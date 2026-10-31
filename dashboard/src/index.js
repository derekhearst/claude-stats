/**
 * Claude usage dashboard — Cloudflare Worker.
 *
 * Routes:
 *   POST /ingest   Authorization: Bearer <INGEST_TOKEN>
 *                  Body: a full per-source snapshot (see collector). Idempotent
 *                  full-replace for that source.
 *   GET  /         The dashboard. Gated by ?key=<DASH_KEY> (sets a cookie so you
 *                  only need the key in the URL once per browser).
 *   GET  /health   Plain OK.
 *
 * Storage: D1 (binding `DB`). Tables: daily, daily_model_tokens, model_usage, meta.
 */

// $/MTok at API list price. Live prices come from LiteLLM's public price list
// (refreshed daily via the Cloudflare cache), so new models price themselves on
// release. This table is the fallback when that fetch fails. Fields: in, out,
// cr = cache read, cw = cache write (default 0.1x / 1.25x input).
const FALLBACK_PRICE = {
  "claude-fable-5-1":  { in: 10,  out: 50,  cr: 0.25 },
  "claude-fable-5":    { in: 10,  out: 50 },
  "claude-mythos-5":   { in: 10,  out: 50 },
  "claude-opus-5-5":   { in: 4,   out: 20,  cr: 0.20 },
  "claude-opus-5":     { in: 5,   out: 25 },
  "claude-opus-4-8":   { in: 5,   out: 25 },
  "claude-opus-4-7":   { in: 5,   out: 25 },
  "claude-opus-4-6":   { in: 5,   out: 25 },
  "claude-opus-4-5":   { in: 5,   out: 25 },
  "claude-sonnet-5-5": { in: 2,   out: 10,  cr: 0.20 },
  "claude-sonnet-5":   { in: 2,   out: 10 },
  "claude-sonnet-4-6": { in: 3,   out: 15 },
  "claude-sonnet-4-5": { in: 3,   out: 15 },
  "claude-haiku-5-5":  { in: 0.1, out: 0.5 },
  "claude-haiku-4-5":  { in: 1,   out: 5 },
};
const PRICE_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
let PRICE = FALLBACK_PRICE;
let priceSource = "built-in table";

async function loadPrices() {
  try {
    const res = await fetch(PRICE_URL, { cf: { cacheTtl: 86400, cacheEverything: true } });
    if (!res.ok) throw new Error(res.status);
    const all = await res.json();
    const live = {};
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith("claude-") || v.litellm_provider !== "anthropic" || !v.input_cost_per_token) continue;
      live[k] = {
        in: v.input_cost_per_token * 1e6,
        out: v.output_cost_per_token * 1e6,
        cr: v.cache_read_input_token_cost != null ? v.cache_read_input_token_cost * 1e6 : undefined,
        cw: v.cache_creation_input_token_cost != null ? v.cache_creation_input_token_cost * 1e6 : undefined,
      };
    }
    PRICE = { ...FALLBACK_PRICE, ...live };
    priceSource = "LiteLLM price list";
  } catch {
    PRICE = FALLBACK_PRICE;
    priceSource = "built-in table (live prices unavailable)";
  }
}

// exact id first, then without a -YYYYMMDD snapshot suffix
const priceFor = (model) => PRICE[model] || PRICE[String(model).replace(/-\d{8}$/, "")];
const cacheReadPrice = (p) => p.cr ?? p.in * 0.1;
const tokenCost = (p, r) => r.input_tokens / 1e6 * p.in
  + r.output_tokens / 1e6 * p.out
  + r.cache_create / 1e6 * (p.cw ?? p.in * 1.25)
  + r.cache_read / 1e6 * cacheReadPrice(p);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") return new Response("ok");
      if (url.pathname === "/ingest" && request.method === "POST")
        return await ingest(request, env);
      if (url.pathname === "/login" && request.method === "POST")
        return await login(request, env);
      if (url.pathname === "/logout")
        return new Response(null, { status: 302, headers: {
          location: "/", "set-cookie": "dk=; Max-Age=0; Path=/" } });
      if (url.pathname === "/" || url.pathname === "") {
        if (!authed(request, env)) return loginPage();
        return await dashboard(request, env, url);
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      return new Response("error: " + (e?.message || e), { status: 500 });
    }
  },
};

// ---- ingest -------------------------------------------------------------
async function ingest(request, env) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!env.INGEST_TOKEN || token !== env.INGEST_TOKEN)
    return new Response("unauthorized", { status: 401 });

  const body = await request.json();
  const source = String(body.source || "").trim();
  if (!source) return new Response("missing source", { status: 400 });

  const daily = Array.isArray(body.daily) ? body.daily : [];
  const dmt = Array.isArray(body.dailyModelTokens) ? body.dailyModelTokens : [];
  const mu = Array.isArray(body.modelUsage) ? body.modelUsage : [];
  const now = new Date().toISOString();

  const stmts = [
    env.DB.prepare("DELETE FROM daily WHERE source=?").bind(source),
    env.DB.prepare("DELETE FROM daily_model_tokens WHERE source=?").bind(source),
    env.DB.prepare("DELETE FROM model_usage WHERE source=?").bind(source),
  ];
  for (const r of daily)
    stmts.push(env.DB.prepare(
      "INSERT INTO daily (source,date,messages,sessions,tool_calls) VALUES (?,?,?,?,?)"
    ).bind(source, r.date, r.messages | 0, r.sessions | 0, r.tool_calls | 0));
  for (const r of dmt)
    stmts.push(env.DB.prepare(
      "INSERT INTO daily_model_tokens (source,date,model,tokens) VALUES (?,?,?,?)"
    ).bind(source, r.date, r.model, r.tokens | 0));
  for (const r of mu)
    stmts.push(env.DB.prepare(
      "INSERT INTO model_usage (source,model,input_tokens,output_tokens,cache_read,cache_create) VALUES (?,?,?,?,?,?)"
    ).bind(source, r.model, r.input | 0, r.output | 0, r.cacheRead | 0, r.cacheCreate | 0));
  // New tables — only touch them if the payload includes the array, so an older
  // collector (no hourly/tools/projectUsage) doesn't wipe a source's data.
  if (Array.isArray(body.hourly)) {
    stmts.push(env.DB.prepare("DELETE FROM hourly WHERE source=?").bind(source));
    for (const r of body.hourly)
      stmts.push(env.DB.prepare("INSERT INTO hourly (source,hour,count) VALUES (?,?,?)")
        .bind(source, r.hour | 0, r.count | 0));
  }
  if (Array.isArray(body.tools)) {
    stmts.push(env.DB.prepare("DELETE FROM tools WHERE source=?").bind(source));
    for (const r of body.tools)
      stmts.push(env.DB.prepare("INSERT INTO tools (source,tool,count) VALUES (?,?,?)")
        .bind(source, String(r.tool), r.count | 0));
  }
  if (Array.isArray(body.projectUsage)) {
    stmts.push(env.DB.prepare("DELETE FROM project_usage WHERE source=?").bind(source));
    for (const r of body.projectUsage)
      stmts.push(env.DB.prepare(
        "INSERT INTO project_usage (source,project,model,input_tokens,output_tokens,cache_read,cache_create) VALUES (?,?,?,?,?,?,?)"
      ).bind(source, String(r.project), String(r.model), r.input | 0, r.output | 0, r.cacheRead | 0, r.cacheCreate | 0));
  }

  stmts.push(env.DB.prepare(
    "INSERT OR REPLACE INTO meta (source,last_push,first_session) VALUES (?,?,?)"
  ).bind(source, now, body.firstSession || null));

  await env.DB.batch(stmts);
  return Response.json({ ok: true, source, days: daily.length, models: mu.length });
}

// ---- auth ---------------------------------------------------------------
function cookieVal(request, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(request.headers.get("cookie") || "");
  return m ? decodeURIComponent(m[1]) : null;
}
function authed(request, env) {
  return !!env.DASH_KEY && cookieVal(request, "dk") === env.DASH_KEY;
}
async function login(request, env) {
  const form = await request.formData();
  const pw = String(form.get("password") || "");
  if (env.DASH_KEY && pw === env.DASH_KEY) {
    return new Response(null, { status: 302, headers: {
      location: "/",
      "set-cookie": `dk=${encodeURIComponent(pw)}; Max-Age=31536000; Path=/; HttpOnly; Secure; SameSite=Lax`,
    }});
  }
  return loginPage(true);
}
function loginPage(failed = false) {
  return new Response(`<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>Claude usage</title>
<style>body{background:#161616;color:#e8e8e8;font:15px system-ui,sans-serif;display:flex;
min-height:100vh;align-items:center;justify-content:center;margin:0}
form{background:#222;border:1px solid #333;border-radius:10px;padding:28px;width:280px;text-align:center}
h1{font-size:17px;margin:0 0 16px}input{width:100%;box-sizing:border-box;padding:10px;border-radius:6px;
border:1px solid #444;background:#1a1a1a;color:#eee;font-size:14px}
button{margin-top:12px;width:100%;padding:10px;border:0;border-radius:6px;background:#4a83cf;color:#fff;
font-size:14px;font-weight:600;cursor:pointer}.err{color:#e06b6b;font-size:12px;margin-top:10px}</style>
<form method=POST action=/login>
<h1>✳ Claude usage</h1>
<input type=password name=password placeholder=Password autofocus autocomplete=current-password>
<button>Sign in</button>
${failed ? '<div class=err>Wrong password</div>' : ''}
</form>`, { status: failed ? 401 : 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

// ---- dashboard ----------------------------------------------------------
async function dashboard(request, env, url) {
  const headers = { "content-type": "text/html; charset=utf-8" };
  const [daily, dmt, mu, meta, hourly, tools, proj] = await Promise.all([
    env.DB.prepare("SELECT * FROM daily").all(),
    env.DB.prepare("SELECT * FROM daily_model_tokens").all(),
    env.DB.prepare("SELECT * FROM model_usage").all(),
    env.DB.prepare("SELECT * FROM meta").all(),
    env.DB.prepare("SELECT * FROM hourly").all(),
    env.DB.prepare("SELECT * FROM tools").all(),
    env.DB.prepare("SELECT * FROM project_usage").all(),
  ]);

  await loadPrices();
  return new Response(render(daily.results, dmt.results, mu.results, meta.results,
    hourly.results, tools.results, proj.results), { headers });
}

// ---- render -------------------------------------------------------------
function render(daily, dmt, mu, meta, hourly = [], toolRows = [], projRows = []) {
  const sources = [...new Set(daily.map(d => d.source))].sort();

  // per-date totals (all sources)
  const byDate = {};
  let totalMessages = 0, totalSessions = 0, totalTools = 0;
  for (const r of daily) {
    byDate[r.date] ??= 0;
    byDate[r.date] += r.messages;
    totalMessages += r.messages;
    totalSessions += r.sessions;
    totalTools += r.tool_calls;
  }

  // tokens by model — keep real (Code) separate from estimated (web "(est.)")
  const tokByModel = {}, tokBySource = {};
  let totalTokens = 0, estTokens = 0;
  for (const r of dmt) {
    tokBySource[r.source] = (tokBySource[r.source] || 0) + r.tokens;
    if (/\(est\.\)/.test(r.model)) { estTokens += r.tokens; continue; }
    tokByModel[r.model] = (tokByModel[r.model] || 0) + r.tokens;
    totalTokens += r.tokens;
  }
  for (const m of Object.keys(tokByModel)) if (!tokByModel[m]) delete tokByModel[m];
  const favoriteModel = Object.entries(tokByModel).sort((a, b) => b[1] - a[1])[0]?.[0] || "—";

  // cost + cache totals from model_usage
  let cost = 0, costRows = [], totalCacheRead = 0, cacheSavings = 0;
  const unpriced = new Set();
  for (const r of mu) {
    totalCacheRead += r.cache_read || 0;
    const p = priceFor(r.model); if (!p) { unpriced.add(r.model); continue; }
    const c = tokenCost(p, r);
    cost += c;
    costRows.push([r.source, r.model, c]);
    // what cache reads saved vs paying full input price
    cacheSavings += (r.cache_read || 0) / 1e6 * (p.in - cacheReadPrice(p));
  }
  costRows.sort((a, b) => b[2] - a[2]);

  // dates, streaks, run-rate, busiest day, weekday distribution
  const dates = Object.keys(byDate).sort();
  const activeDays = dates.length;
  let longestStreak = 0, cur = 0, prev = null;
  for (const ds of dates) {
    const d = new Date(ds + "T00:00:00Z");
    cur = (prev && (d - prev) === 86400000) ? cur + 1 : 1;
    prev = d; if (cur > longestStreak) longestStreak = cur;
  }
  let currentStreak = 0;                       // consecutive days up to the latest active day
  for (let i = dates.length - 1; i > 0; i--) {
    if (i === dates.length - 1) currentStreak = 1;
    const a = new Date(dates[i] + "T00:00:00Z"), b = new Date(dates[i - 1] + "T00:00:00Z");
    if (a - b === 86400000) currentStreak++; else break;
  }
  // run rate uses the span of days that actually have cost (Code), not the full
  // history — web's year-plus of zero-cost activity would otherwise deflate it.
  const realDates = [...new Set(dmt.filter(r => !/\(est\.\)/.test(r.model)).map(r => r.date))].sort();
  const codeSpan = realDates.length
    ? Math.round((new Date(realDates.at(-1) + "T00:00:00Z") - new Date(realDates[0] + "T00:00:00Z")) / 86400000) + 1
    : 1;
  const monthlyRunRate = cost / codeSpan * 30;
  const avgMsgs = totalSessions ? totalMessages / totalSessions : 0;
  let busiestDay = null, busiestN = 0;
  for (const [d, n] of Object.entries(byDate)) if (n > busiestN) { busiestN = n; busiestDay = d; }
  const dow = [0, 0, 0, 0, 0, 0, 0];
  for (const [d, n] of Object.entries(byDate)) dow[new Date(d + "T00:00:00Z").getUTCDay()] += n;

  // per-source breakdown
  const perSource = {};
  for (const r of daily) {
    perSource[r.source] ??= { messages: 0, sessions: 0 };
    perSource[r.source].messages += r.messages;
    perSource[r.source].sessions += r.sessions;
  }

  // time-of-day
  const hourCounts = Array(24).fill(0);
  for (const r of hourly) hourCounts[r.hour] = (hourCounts[r.hour] || 0) + r.count;
  const peakHour = hourCounts.some(x => x) ? hourCounts.indexOf(Math.max(...hourCounts)) : null;
  const hr12 = h => { const ap = h < 12 ? "AM" : "PM"; const x = h % 12 === 0 ? 12 : h % 12; return `${x} ${ap}`; };

  // top tools
  const toolAgg = {};
  for (const r of toolRows) toolAgg[r.tool] = (toolAgg[r.tool] || 0) + r.count;
  const topTools = Object.entries(toolAgg).sort((a, b) => b[1] - a[1]).slice(0, 12);

  // per-project tokens + cost
  const projAgg = {};
  for (const r of projRows) {
    const p = priceFor(r.model);
    const a = (projAgg[r.project] ??= { tokens: 0, cost: 0 });
    a.tokens += (r.input_tokens || 0) + (r.output_tokens || 0);
    if (p) a.cost += tokenCost(p, r);
  }
  const projList = Object.entries(projAgg).sort((a, b) => b[1].cost - a[1].cost);

  // weekly trend — real Code tokens by week (Sunday start)
  const weekTok = {};
  for (const r of dmt) {
    if (/\(est\.\)/.test(r.model)) continue;
    const d = new Date(r.date + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    const wk = d.toISOString().slice(0, 10);
    weekTok[wk] = (weekTok[wk] || 0) + r.tokens;
  }
  const weeks = Object.entries(weekTok).sort((a, b) => a[0] < b[0] ? -1 : 1);

  const fmt = n => n.toLocaleString("en-US");
  const fmtTok = n => n >= 1e9 ? (n/1e9).toFixed(1)+"B" : n >= 1e6 ? (n/1e6).toFixed(1)+"M"
                    : n >= 1e3 ? (n/1e3).toFixed(1)+"K" : String(n);
  const usd = n => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = n => (n * 100).toFixed(0) + "%";
  // decode Claude Code's encoded working-dir name → last folder segment
  const pretty = p => {
    const parts = p.replace(/^([A-Za-z])--/, "$1:/").replace(/-/g, "/").split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : p;
  };

  // activity heatmap — windowed to the last 53 weeks so a single old web
  // conversation doesn't stretch it into a huge empty expanse
  const maxMsgs = Math.max(1, ...Object.values(byDate));
  let heatHtml = "", monthsHtml = "";
  if (dates.length) {
    const end = new Date(dates.at(-1) + "T00:00:00Z");
    end.setUTCDate(end.getUTCDate() + (6 - end.getUTCDay()));   // Saturday of latest week
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - (53 * 7 - 1));        // 53 weeks back, Sunday
    const wks = [];
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      const wk = Math.floor((d - start) / (7 * 86400000));
      (wks[wk] ??= []).push(iso);
    }
    heatHtml = wks.map(wk => `<div class=col>${wk.map(iso => {
      const v = byDate[iso] || 0;
      const lvl = v ? Math.min(4, Math.ceil(v / maxMsgs * 4)) : 0;
      return `<div class="d l${lvl}" title="${v ? `${iso}: ${fmt(v)} msgs` : iso}"></div>`;
    }).join("")}</div>`).join("");
    const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    let lastM = -1;
    monthsHtml = wks.map(wk => {
      const m = new Date(wk[0] + "T00:00:00Z").getUTCMonth();
      const lab = m !== lastM ? MON[m] : ""; lastM = m;
      return `<div class=mlab>${lab}</div>`;
    }).join("");
  }

  const card = (l, v, cls = "") => `<div class="card ${cls}"><div class=lbl>${l}</div><div class=val>${v}</div></div>`;
  const lastPush = meta.map(m => `${m.source} ${(m.last_push||"").slice(5,16).replace("T"," ")}`).join(" · ");
  const est = ' <span class=tag>est</span>';
  // generic evenly-spaced bar chart (flex:1 columns → consistent spacing)
  const barChart = (items, labFn, valFn, titleFn) => {
    const mx = Math.max(1, ...items.map(valFn));
    return `<div class=chart>${items.map((it, i) => {
      const h = Math.round(valFn(it) / mx * 100);
      return `<div class=bcol title="${titleFn(it, i)}"><div class=bar style="height:${h}px"></div><div class=blab>${labFn(it, i)}</div></div>`;
    }).join("")}</div>`;
  };

  return `<!doctype html><html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Claude usage</title>
<style>
 *{box-sizing:border-box}
 body{background:#0f0f11;color:#e6e6e8;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;margin:0;padding:28px 22px}
 .wrap{max-width:1080px;margin:0 auto}
 header{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:10px;margin-bottom:20px}
 h1{font-size:20px;font-weight:650;margin:0;letter-spacing:-.01em}
 .meta{color:#73737b;font-size:12px;margin-top:3px}
 a.logout{color:#8a8a90;font-size:12px;text-decoration:none;border:1px solid #2a2a2e;padding:5px 11px;border-radius:7px}
 a.logout:hover{color:#ddd;border-color:#3a3a40}
 .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
 .card{background:#1a1a1d;border:1px solid #27272b;border-radius:12px;padding:14px 16px}
 .card.accent{background:linear-gradient(140deg,#1c2a44,#1a1a1d);border-color:#31486b}
 .lbl{color:#83838a;font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px}
 .val{font-size:22px;font-weight:650;letter-spacing:-.01em}
 .tag{font-size:10px;color:#73737b;font-weight:500;vertical-align:middle}
 .row{display:grid;gap:14px;margin-top:14px}
 .charts{grid-template-columns:repeat(auto-fit,minmax(290px,1fr))}
 .tables{grid-template-columns:repeat(auto-fit,minmax(330px,1fr))}
 .panel{background:#1a1a1d;border:1px solid #27272b;border-radius:12px;padding:16px 18px}
 h2{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#9a9aa2;margin:0 0 12px}
 .chart{display:flex;align-items:flex-end;gap:4px;height:124px}
 .bcol{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%}
 .bar{width:72%;max-width:24px;background:#3b6fb0;border-radius:3px 3px 0 0;min-height:2px}
 .bcol:hover .bar{background:#6ba3f0}
 .blab{color:#73737b;font-size:10px;margin-top:6px;white-space:nowrap;height:12px}
 .heatwrap{overflow-x:auto;padding-bottom:2px}
 .months{display:flex;height:14px}
 .mlab{width:15px;flex:none;font-size:10px;color:#73737b}
 .heat{display:flex;gap:3px}
 .col{display:flex;flex-direction:column;gap:3px}
 .d{width:12px;height:12px;border-radius:3px;background:#1f1f23}
 .l1{background:#1e3a5f}.l2{background:#2f5b94}.l3{background:#4a83cf}.l4{background:#6ba3f0}
 .legend{display:flex;gap:5px;align-items:center;justify-content:flex-end;color:#73737b;font-size:11px;margin-top:8px}
 .legend .d{width:11px;height:11px}
 table{width:100%;border-collapse:collapse;font-size:13px}
 th{text-align:left;color:#83838a;font-weight:500;font-size:10px;text-transform:uppercase;letter-spacing:.05em;padding:6px 8px;border-bottom:1px solid #2a2a2e}
 td{padding:6px 8px;border-bottom:1px solid #1f1f23}
 tr:last-child td{border-bottom:0}
 .num{text-align:right;font-variant-numeric:tabular-nums}
 tbody tr:hover,table tr:hover{background:#1f1f23}
 .foot{color:#6a6a72;font-size:11px;margin-top:20px;line-height:1.7}
</style>
<div class=wrap>
<header>
 <div><h1>✳ Claude usage</h1><div class=meta>${sources.join(" · ") || "no sources"} &nbsp;·&nbsp; updated ${lastPush || "never"}</div></div>
 <a class=logout href=/logout>Sign out</a>
</header>

<div class=cards>
 ${card("Sessions", fmt(totalSessions))}
 ${card("Messages", fmt(totalMessages))}
 ${card("Total tokens", fmtTok(totalTokens))}
 ${card("Web tokens", fmtTok(estTokens) + est)}
 ${card("Active days", activeDays)}
 ${card("Current streak", currentStreak + "d")}
 ${card("Longest streak", longestStreak + "d")}
 ${card("Avg msgs / session", avgMsgs.toFixed(0))}
 ${card("Tool calls", fmtTok(totalTools))}
 ${card("Peak hour", peakHour != null ? hr12(peakHour) : "—")}
 ${card("Favorite model", favoriteModel.replace("claude-",""))}
 ${card("Cache savings", usd(cacheSavings) + est)}
 ${card("Est. API cost", usd(cost), "accent")}
 ${card("Est. $/mo", usd(monthlyRunRate))}
</div>

<div class=panel style=margin-top:14px>
 <h2>Activity — last 12 months</h2>
 <div class=heatwrap>
  <div class=months>${monthsHtml}</div>
  <div class=heat>${heatHtml || '<span class=meta>no data</span>'}</div>
 </div>
 <div class=legend>Less <span class="d l0"></span><span class="d l1"></span><span class="d l2"></span><span class="d l3"></span><span class="d l4"></span> More</div>
</div>

<div class="row charts">
 <div class=panel><h2>Time of day</h2>
  ${barChart(hourCounts.map((c, h) => ({ c, h })), it => it.h % 3 === 0 ? it.h : "", it => it.c, it => `${hr12(it.h)}: ${fmt(it.c)} msgs`)}</div>
 <div class=panel><h2>By weekday</h2>
  ${barChart(["Su","Mo","Tu","We","Th","Fr","Sa"].map((lab, i) => ({ lab, i })), it => it.lab, it => dow[it.i], it => `${fmt(dow[it.i])} msgs`)}</div>
 <div class=panel><h2>Tokens per week</h2>
  ${weeks.length ? barChart(weeks, it => it[0].slice(5), it => it[1], it => `week of ${it[0]}: ${fmtTok(it[1])}`) : '<div class=meta>no data</div>'}</div>
</div>

<div class="row tables">
 <div class=panel><h2>By source</h2>
  <table><tr><th>Source</th><th class=num>Sessions</th><th class=num>Messages</th><th class=num>Tokens</th></tr>
  ${sources.map(s=>`<tr><td>${s}</td><td class=num>${fmt(perSource[s]?.sessions||0)}</td><td class=num>${fmt(perSource[s]?.messages||0)}</td><td class=num>${fmtTok(tokBySource[s]||0)}${s==="web"?"*":""}</td></tr>`).join("")}</table></div>
 <div class=panel><h2>By project</h2>
  <table><tr><th>Project</th><th class=num>Tokens</th><th class=num>Est. cost</th></tr>
  ${projList.length ? projList.map(([p,a])=>`<tr><td title="${p}">${pretty(p)}</td><td class=num>${fmtTok(a.tokens)}</td><td class=num>${usd(a.cost)}</td></tr>`).join("") : "<tr><td colspan=3 class=meta>no project data yet</td></tr>"}</table></div>
 <div class=panel><h2>Top tools</h2>
  <table><tr><th>Tool</th><th class=num>Calls</th></tr>
  ${topTools.length ? topTools.map(([t,c])=>`<tr><td>${t}</td><td class=num>${fmt(c)}</td></tr>`).join("") : "<tr><td colspan=2 class=meta>no tool data yet</td></tr>"}</table></div>
 <div class=panel><h2>Tokens by model</h2>
  <table><tr><th>Model</th><th class=num>Tokens</th></tr>
  ${Object.entries(tokByModel).sort((a,b)=>b[1]-a[1]).map(([m,t])=>`<tr><td>${m.replace("claude-","")}</td><td class=num>${fmtTok(t)}</td></tr>`).join("")||"<tr><td>—</td><td class=num>0</td></tr>"}
  ${estTokens?`<tr><td>web (est.)</td><td class=num>${fmtTok(estTokens)}</td></tr>`:""}</table></div>
 <div class=panel><h2>Estimated cost (API list price)</h2>
  <table><tr><th>Source</th><th>Model</th><th class=num>Cost</th></tr>
  ${costRows.map(([s,m,c])=>`<tr><td>${s}</td><td>${m.replace("claude-","")}</td><td class=num>${usd(c)}</td></tr>`).join("")||"<tr><td colspan=3 class=meta>no token data</td></tr>"}
  <tr><td colspan=2><b>Total</b></td><td class=num><b>${usd(cost)}</b></td></tr></table></div>
</div>

<p class=foot>Cost is hypothetical — subscription usage is billed flat; this is what the same tokens would cost at API list price (prices from the ${priceSource}, cache reads and writes at each model's own rates).${unpriced.size ? ` No price yet for ${[...unpriced].join(", ")}; those tokens are left out of cost.` : ""} Web tokens (*) are a rough ~chars/4 estimate — the export has no real counts — and are excluded from Total tokens and cost. Run rate = total cost ÷ Code day-span × 30.</p>
</div>`;
}
