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
// Whole numbers without `| 0`: that wraps at 2^31, and cache-read totals pass 2 billion.
const int = (v) => Math.trunc(Number(v) || 0);

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
    ).bind(source, r.date, int(r.messages), int(r.sessions), int(r.tool_calls)));
  for (const r of dmt)
    stmts.push(env.DB.prepare(
      "INSERT INTO daily_model_tokens (source,date,model,tokens) VALUES (?,?,?,?)"
    ).bind(source, r.date, r.model, int(r.tokens)));
  for (const r of mu)
    stmts.push(env.DB.prepare(
      "INSERT INTO model_usage (source,model,input_tokens,output_tokens,cache_read,cache_create) VALUES (?,?,?,?,?,?)"
    ).bind(source, r.model, int(r.input), int(r.output), int(r.cacheRead), int(r.cacheCreate)));
  // New tables — only touch them if the payload includes the array, so an older
  // collector (no hourly/tools/projectUsage) doesn't wipe a source's data.
  if (Array.isArray(body.hourly)) {
    stmts.push(env.DB.prepare("DELETE FROM hourly WHERE source=?").bind(source));
    for (const r of body.hourly)
      stmts.push(env.DB.prepare("INSERT INTO hourly (source,hour,count) VALUES (?,?,?)")
        .bind(source, int(r.hour), int(r.count)));
  }
  if (Array.isArray(body.tools)) {
    stmts.push(env.DB.prepare("DELETE FROM tools WHERE source=?").bind(source));
    for (const r of body.tools)
      stmts.push(env.DB.prepare("INSERT INTO tools (source,tool,count) VALUES (?,?,?)")
        .bind(source, String(r.tool), int(r.count)));
  }
  if (Array.isArray(body.projectUsage)) {
    stmts.push(env.DB.prepare("DELETE FROM project_usage WHERE source=?").bind(source));
    for (const r of body.projectUsage)
      stmts.push(env.DB.prepare(
        "INSERT INTO project_usage (source,project,model,input_tokens,output_tokens,cache_read,cache_create) VALUES (?,?,?,?,?,?,?)"
      ).bind(source, String(r.project), String(r.model), int(r.input), int(r.output), int(r.cacheRead), int(r.cacheCreate)));
  }

  // The per-session list is one JSON row per source: one statement however many sessions.
  if (Array.isArray(body.sessions)) {
    const list = body.sessions.map(s => ({
      id: String(s.id), start: String(s.start), end: String(s.end || s.start),
      title: String(s.title || "").slice(0, 120), folder: String(s.folder || "").slice(0, 80),
      messages: int(s.messages), toolCalls: int(s.toolCalls),
      usage: Object.fromEntries(Object.entries(s.usage || {}).map(([m, u]) => [m, (u || []).slice(0, 4).map(int)])),
    }));
    stmts.push(env.DB.prepare("INSERT OR REPLACE INTO session_sets (source,data) VALUES (?,?)")
      .bind(source, JSON.stringify(list)));
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
  const [daily, dmt, mu, meta, hourly, tools, sessionSets] = await Promise.all([
    env.DB.prepare("SELECT * FROM daily").all(),
    env.DB.prepare("SELECT * FROM daily_model_tokens").all(),
    env.DB.prepare("SELECT * FROM model_usage").all(),
    env.DB.prepare("SELECT * FROM meta").all(),
    env.DB.prepare("SELECT * FROM hourly").all(),
    env.DB.prepare("SELECT * FROM tools").all(),
    env.DB.prepare("SELECT * FROM session_sets").all(),
  ]);

  await loadPrices();
  return new Response(render(daily.results, dmt.results, mu.results, meta.results,
    hourly.results, tools.results, sessionSets.results), { headers });
}

// ---- render -------------------------------------------------------------
// The server prices every session and embeds the data; a small script in the page draws the parts
// that follow the period switch (cards, spend chart, machine/model split, top sessions). Habits
// (heatmap, time of day, weekday, tools) are all-time and drawn here.
function render(daily, dmt, mu, meta, hourly = [], toolRows = [], sessionSets = []) {
  const short = m => String(m).replace(/^claude-/, "").replace(/-\d{8}$/, "");
  const unpriced = new Set();

  // sessions, priced per model
  const sessions = [];
  const withSessions = new Set();
  for (const set of sessionSets) {
    let list; try { list = JSON.parse(set.data); } catch { continue; }
    withSessions.add(set.source);
    for (const s of list) {
      const mc = {}; let cost = 0, tok = 0;
      for (const [model, u] of Object.entries(s.usage || {})) {
        const r = { input_tokens: u[0], output_tokens: u[1], cache_read: u[2], cache_create: u[3] };
        tok += u[0] + u[1];
        const p = priceFor(model); if (!p) { unpriced.add(model); continue; }
        const c = tokenCost(p, r); cost += c; mc[short(model)] = (mc[short(model)] || 0) + c;
      }
      sessions.push({ s: set.source, t: s.title, f: s.folder, st: s.start, en: s.end,
        m: s.messages, tc: s.toolCalls, c: +cost.toFixed(4), tok, mc });
    }
  }

  // sources with no session list yet (an older collector, or web): their cost only counts in "All"
  const legacy = {};
  for (const r of mu) {
    if (withSessions.has(r.source)) continue;
    const p = priceFor(r.model); if (!p) { if (r.model !== "<synthetic>") unpriced.add(r.model); continue; }
    const l = (legacy[r.source] ??= { cost: 0, tok: 0, mc: {} });
    l.tok += (r.input_tokens || 0) + (r.output_tokens || 0);
    const c = tokenCost(p, r); l.cost += c; l.mc[short(r.model)] = (l.mc[short(r.model)] || 0) + c;
  }
  const dayRows = daily.map(r => [r.date, r.source, r.messages, r.sessions]);
  const sources = meta.map(m => ({ s: m.source, at: m.last_push, sessions: withSessions.has(m.source) }))
    .sort((a, b) => a.s < b.s ? -1 : 1);

  // ---- habits (all time) ----
  const byDate = {};
  for (const r of daily) byDate[r.date] = (byDate[r.date] || 0) + r.messages;
  const dates = Object.keys(byDate).sort();
  const dow = [0, 0, 0, 0, 0, 0, 0];
  for (const [d, n] of Object.entries(byDate)) dow[new Date(d + "T00:00:00Z").getUTCDay()] += n;
  const hourCounts = Array(24).fill(0);
  for (const r of hourly) hourCounts[r.hour] = (hourCounts[r.hour] || 0) + r.count;
  const toolAgg = {};
  for (const r of toolRows) toolAgg[r.tool] = (toolAgg[r.tool] || 0) + r.count;
  const topTools = Object.entries(toolAgg).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const maxTool = topTools[0]?.[1] || 1;
  let longestStreak = 0, cur = 0, prev = null;
  for (const ds of dates) {
    const d = new Date(ds + "T00:00:00Z");
    cur = (prev && (d - prev) === 86400000) ? cur + 1 : 1;
    prev = d; if (cur > longestStreak) longestStreak = cur;
  }

  const fmt = n => n.toLocaleString("en-US");
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const hr12 = h => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "a" : "p"}`;

  const maxMsgs = Math.max(1, ...Object.values(byDate));
  let heatHtml = "", monthsHtml = "";
  if (dates.length) {
    const end = new Date(dates.at(-1) + "T00:00:00Z");
    end.setUTCDate(end.getUTCDate() + (6 - end.getUTCDay()));
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - (53 * 7 - 1));
    const wks = [];
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      (wks[Math.floor((d - start) / (7 * 86400000))] ??= []).push(iso);
    }
    heatHtml = wks.map(wk => `<div class=col>${wk.map(iso => {
      const v = byDate[iso] || 0;
      const lvl = v ? Math.min(4, Math.ceil(v / maxMsgs * 4)) : 0;
      return `<div class="d l${lvl}" title="${v ? `${iso}: ${fmt(v)} messages` : iso}"></div>`;
    }).join("")}</div>`).join("");
    const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    let lastM = -1;
    monthsHtml = wks.map(wk => {
      const m = new Date(wk[0] + "T00:00:00Z").getUTCMonth();
      const lab = m !== lastM ? MON[m] : ""; lastM = m;
      return `<div class=mlab>${lab}</div>`;
    }).join("");
  }
  const vbars = (vals, labFn, titleFn) => {
    const mx = Math.max(1, ...vals);
    return `<div class=vchart>${vals.map((v, i) =>
      `<div class=vcol title="${titleFn(i, v)}"><div class=vbar style="height:${Math.round(v / mx * 100)}%"></div><div class=vlab>${labFn(i)}</div></div>`).join("")}</div>`;
  };

  // JSON for the page script; < escaped so no string can close the script tag
  const firstCode = meta.filter(m => m.source !== "web" && m.first_session).map(m => m.first_session).sort()[0] || null;
  const data = JSON.stringify({ sessions, legacy, dayRows, sources, firstCode }).replace(/</g, "\\u003c");

  return `<!doctype html><html lang=en><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Claude usage</title>
<style>
 :root{--bg:#0e0e10;--panel:#17171a;--line:#26262b;--soft:#1e1e22;--text:#e7e7ea;--muted:#8b8b93;--faint:#5f5f67;
  --accent:#6ba3f0;--warn:#e0b450;--opus:#6ba3f0;--sonnet:#6fcf9f;--haiku:#e0c36b;--fable:#c18cf0;--other:#8b8b93}
 *{box-sizing:border-box}
 body{background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;margin:0;padding:24px 16px 40px}
 .wrap{max-width:1120px;margin:0 auto}
 header{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:6px}
 h1{font-size:19px;font-weight:650;margin:0;letter-spacing:-.01em}
 .chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 18px}
 .chip{font-size:12px;color:var(--muted);background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:3px 10px}
 .chip b{color:var(--text);font-weight:600}.chip.stale{border-color:#5a4720;color:var(--warn)}
 .controls{display:flex;gap:10px;align-items:center}
 .seg{display:inline-flex;background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:3px}
 .seg button{background:none;border:0;color:var(--muted);font:inherit;font-size:13px;padding:5px 12px;border-radius:6px;cursor:pointer}
 .seg button.on{background:#2a3c57;color:#fff}
 a.logout{color:var(--muted);font-size:12px;text-decoration:none;border:1px solid var(--line);padding:6px 11px;border-radius:8px}
 .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}
 .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
 .card.hero{background:linear-gradient(140deg,#1b2a42,var(--panel) 70%);border-color:#2f4668}
 .lbl{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
 .val{font-size:24px;font-weight:650;letter-spacing:-.02em;margin-top:4px;font-variant-numeric:tabular-nums}
 .sub{color:var(--faint);font-size:12px;margin-top:2px}
 .grid{display:grid;gap:12px;margin-top:12px}
 .g-main{grid-template-columns:2fr 1fr}
 .g-3{grid-template-columns:repeat(3,1fr)}
 @media(max-width:860px){.g-main,.g-3{grid-template-columns:1fr}}
 .panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px;min-width:0}
 h2{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin:0 0 14px;display:flex;justify-content:space-between;align-items:center;gap:8px}
 h2 span{text-transform:none;letter-spacing:0;font-weight:500;color:var(--faint)}
 .spend{display:flex;align-items:flex-end;gap:2px;height:170px;border-bottom:1px solid var(--line)}
 .scol{flex:1;min-width:0;height:100%;display:flex;flex-direction:column-reverse;cursor:default}
 .scol:hover{background:var(--soft)}
 .seg-bar{width:100%}
 .xlab{display:flex;justify-content:space-between;color:var(--faint);font-size:11px;margin-top:6px}
 .legend{display:flex;flex-wrap:wrap;gap:12px;margin-top:10px;font-size:12px;color:var(--muted)}
 .sw{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:0}
 .hb{margin-bottom:11px}.hb:last-child{margin-bottom:0}
 .hb-top{display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;gap:8px}
 .hb-top span:last-child{font-variant-numeric:tabular-nums;color:var(--muted)}
 .track{height:7px;background:var(--soft);border-radius:4px;overflow:hidden;display:flex}
 .fill{height:100%}
 .tools{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px}
 input,select{background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font:inherit;font-size:13px}
 input{width:220px;max-width:100%}
 table{width:100%;border-collapse:collapse;font-size:13px}
 th{text-align:left;color:var(--muted);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:7px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
 td{padding:8px;border-bottom:1px solid #1d1d21;vertical-align:top}
 tbody tr:hover{background:var(--soft)}
 .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
 .title{max-width:520px}.title div:first-child{overflow:hidden;text-overflow:ellipsis}
 .muted{color:var(--faint);font-size:12px}
 .pill{font-size:11px;padding:1px 7px;border-radius:999px;background:var(--soft);color:var(--muted);white-space:nowrap}
 .tablewrap{overflow-x:auto}
 .more{margin-top:10px;background:none;border:1px solid var(--line);color:var(--muted);border-radius:8px;padding:6px 14px;cursor:pointer;font:inherit;font-size:13px}
 .heatwrap{overflow-x:auto}
 .months{display:flex;height:14px}.mlab{width:15px;flex:none;font-size:10px;color:var(--faint)}
 .heat{display:flex;gap:3px}.col{display:flex;flex-direction:column;gap:3px}
 .d{width:12px;height:12px;border-radius:3px;background:#1d1d21}
 .l1{background:#1e3a5f}.l2{background:#2f5b94}.l3{background:#4a83cf}.l4{background:#6ba3f0}
 .vchart{display:flex;align-items:flex-end;gap:3px;height:110px}
 .vcol{flex:1;min-width:0;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center}
 .vbar{width:70%;background:#3b6fb0;border-radius:3px 3px 0 0;min-height:2px}
 .vcol:hover .vbar{background:var(--accent)}
 .vlab{color:var(--faint);font-size:10px;height:14px;margin-top:4px}
 .foot{color:var(--faint);font-size:12px;margin-top:22px;line-height:1.7}
 .empty{color:var(--faint);font-size:13px;padding:20px 0;text-align:center}
</style>
<div class=wrap>
<header>
 <h1>✳ Claude usage</h1>
 <div class=controls>
  <div class=seg id=period><button data-d=7>7d</button><button data-d=30>30d</button><button data-d=90>90d</button><button data-d=0>All</button></div>
  <a class=logout href=/logout>Sign out</a>
 </div>
</header>
<div class=chips id=chips></div>

<div class=cards id=cards></div>

<div class="grid g-main">
 <div class=panel><h2>Spend <span id=spend-note></span></h2><div class=spend id=spend></div><div class=xlab id=spend-x></div><div class=legend id=legend></div></div>
 <div class=panel><h2>By machine</h2><div id=machines></div><h2 style=margin-top:20px>By model</h2><div id=models></div></div>
</div>

<div class="grid">
 <div class=panel>
  <h2>Top sessions <span id=ses-note></span></h2>
  <div class=tools>
   <input id=q type=search placeholder="Search prompts and folders">
   <div style="display:flex;gap:8px"><select id=src><option value="">All machines</option></select>
   <select id=sort><option value=c>Most expensive</option><option value=st>Newest</option><option value=tok>Most tokens</option><option value=m>Most messages</option></select></div>
  </div>
  <div class=tablewrap><table><thead><tr><th>Started</th><th>Session</th><th>Machine</th><th class=num>Length</th><th class=num>Msgs</th><th>Model</th><th class=num>Cost</th></tr></thead><tbody id=rows></tbody></table></div>
  <button class=more id=more hidden>Show 25 more</button>
 </div>
</div>

<div class="grid">
 <div class=panel>
  <h2>Activity <span>messages per day, last 12 months · longest streak ${longestStreak} days</span></h2>
  <div class=heatwrap><div class=months>${monthsHtml}</div><div class=heat>${heatHtml || '<div class=empty>No data</div>'}</div></div>
 </div>
</div>
<div class="grid g-3">
 <div class=panel><h2>Time of day</h2>${vbars(hourCounts, i => i % 6 === 0 ? hr12(i) : "", (i, v) => `${hr12(i)}: ${fmt(v)} messages`)}</div>
 <div class=panel><h2>Weekday</h2>${vbars(dow, i => "SMTWTFS"[i], (i, v) => `${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][i]}: ${fmt(v)} messages`)}</div>
 <div class=panel><h2>Top tools</h2>${topTools.map(([t, c]) => `<div class=hb><div class=hb-top><span>${esc(t)}</span><span>${fmt(c)}</span></div><div class=track><div class=fill style="width:${(c / maxTool * 100).toFixed(1)}%;background:#3b6fb0"></div></div></div>`).join("") || '<div class=empty>No data</div>'}</div>
</div>

<p class=foot>Cost is hypothetical: subscription use is billed flat, so this is what the same tokens would cost at API list price (prices from the ${esc(priceSource)}, cache reads and writes at each model's own rates). A session's cost counts on the day it started. Machines without a session list yet count only in <b>All</b>.${unpriced.size ? ` No price yet for ${esc([...unpriced].join(", "))}; those tokens are left out.` : ""} Web conversations have no token counts, so they add to sessions and activity but not cost.</p>
</div>
<script>
const D = ${data};
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const usd = n => "$" + n.toLocaleString("en-US", { minimumFractionDigits: n < 100 ? 2 : 0, maximumFractionDigits: n < 100 ? 2 : 0 });
const tokf = n => n >= 1e9 ? (n/1e9).toFixed(1)+"B" : n >= 1e6 ? (n/1e6).toFixed(1)+"M" : n >= 1e3 ? (n/1e3).toFixed(0)+"K" : String(n);
const family = m => /opus/.test(m) ? "opus" : /sonnet/.test(m) ? "sonnet" : /haiku/.test(m) ? "haiku" : /fable|mythos/.test(m) ? "fable" : "other";
const color = m => "var(--" + family(m) + ")";
const dayKey = d => d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
const ago = iso => { const h = (Date.now() - new Date(iso)) / 36e5; return h < 1 ? "just now" : h < 48 ? Math.round(h) + "h ago" : Math.round(h/24) + "d ago"; };
const dur = (a, b) => { const m = Math.max(0, (new Date(b) - new Date(a)) / 6e4); return m < 60 ? Math.round(m) + "m" : m < 1440 ? (m/60).toFixed(1) + "h" : (m/1440).toFixed(1) + "d"; };

let period = 30, shown = 25;
try { const p = localStorage.getItem("period"); if (p !== null) period = +p; } catch {}

$("chips").innerHTML = D.sources.map(s => {
  const stale = (Date.now() - new Date(s.at)) / 36e5 > (s.s === "web" ? 24 * 45 : 36);
  return '<span class="chip' + (stale ? " stale" : "") + '" title="' + (s.sessions ? "" : "no session list yet; counts only in All") + '"><b>' + esc(s.s) + '</b> ' + ago(s.at) + (s.sessions ? "" : " · totals only") + '</span>';
}).join("");
for (const s of D.sources) $("src").insertAdjacentHTML("beforeend", '<option>' + esc(s.s) + '</option>');

function inPeriod(dateStr) {
  if (!period) return true;
  const since = new Date(); since.setHours(0,0,0,0); since.setDate(since.getDate() - period + 1);
  return new Date(dateStr.length === 10 ? dateStr + "T00:00:00" : dateStr) >= since;
}

function draw() {
  document.querySelectorAll("#period button").forEach(b => b.classList.toggle("on", +b.dataset.d === period));
  const ses = D.sessions.filter(s => inPeriod(s.st));
  const days = D.dayRows.filter(r => inPeriod(r[0]));
  const legacy = period ? {} : D.legacy;

  let cost = 0, tok = 0, sesCost = 0; const byMachine = {}, byModel = {};
  for (const s of ses) {
    cost += s.c; sesCost += s.c; tok += s.tok;
    byMachine[s.s] = (byMachine[s.s] || 0) + s.c;
    for (const [m, c] of Object.entries(s.mc)) byModel[m] = (byModel[m] || 0) + c;
  }
  for (const [src, l] of Object.entries(legacy)) {
    cost += l.cost; tok += l.tok; byMachine[src] = (byMachine[src] || 0) + l.cost;
    for (const [m, c] of Object.entries(l.mc)) byModel[m] = (byModel[m] || 0) + c;
  }
  const sessionsN = days.reduce((a, r) => a + r[3], 0);
  const activeDays = new Set(days.map(r => r[0])).size;
  let spanDays = period;
  // "All" runs from the first Code session: web history goes back further but has no cost to chart
  if (!period) { const first = D.firstCode || D.dayRows.map(r => r[0]).sort()[0]; spanDays = first ? Math.round((new Date() - new Date(first.slice(0, 10) + "T00:00:00")) / 864e5) + 1 : 1; }
  const label = period ? "last " + period + " days" : "all time";
  const card = (l, v, sub, cls) => '<div class="card ' + (cls || "") + '"><div class=lbl>' + l + '</div><div class=val>' + v + '</div>' + (sub ? '<div class=sub>' + sub + '</div>' : "") + '</div>';
  $("cards").innerHTML =
    card("Est. API cost", usd(cost), label, "hero") +
    card("Per month", usd(cost / Math.max(1, spanDays) * 30), "at this pace") +
    card("Sessions", sessionsN.toLocaleString(), ses.length ? usd(sesCost / ses.length) + " avg per Code session" : "") +
    card("Active days", activeDays + (period ? " / " + period : ""), "") +
    card("Tokens", tokf(tok), "input + output");

  // spend chart: daily bars (weekly when the range is long), stacked by model family
  const buckets = new Map(); const weekly = spanDays > 120;
  const start = new Date(); start.setHours(0,0,0,0); start.setDate(start.getDate() - spanDays + 1);
  for (let d = new Date(start); d <= new Date(); d.setDate(d.getDate() + (weekly ? 7 : 1))) buckets.set(dayKey(d), {});
  const keys = [...buckets.keys()];
  for (const s of ses) {
    const d = new Date(s.st); let k = dayKey(d);
    if (weekly) { const i = Math.min(keys.length - 1, Math.floor((d - start) / (7 * 864e5))); k = keys[Math.max(0, i)]; }
    const b = buckets.get(k); if (!b) continue;
    for (const [m, c] of Object.entries(s.mc)) b[family(m)] = (b[family(m)] || 0) + c;
  }
  const totals = keys.map(k => Object.values(buckets.get(k)).reduce((a, v) => a + v, 0));
  const max = Math.max(1e-9, ...totals);
  const fams = ["opus", "sonnet", "haiku", "fable", "other"];
  $("spend").innerHTML = keys.map((k, i) => {
    const b = buckets.get(k);
    return '<div class=scol title="' + (weekly ? "week of " : "") + k + ": " + usd(totals[i]) + '">' + fams.filter(f => b[f]).map(f =>
      '<div class=seg-bar style="height:' + (b[f] / max * 100).toFixed(2) + '%;background:var(--' + f + ')"></div>').join("") + '</div>';
  }).join("");
  $("spend-x").innerHTML = keys.length ? '<span>' + keys[0].slice(5) + '</span><span>' + keys[keys.length - 1].slice(5) + '</span>' : "";
  $("spend-note").textContent = (weekly ? "per week" : "per day") + (!period && Object.keys(legacy).length ? " · machines without a session list are not charted" : "");
  const usedFams = fams.filter(f => keys.some(k => buckets.get(k)[f]));
  $("legend").innerHTML = usedFams.map(f => '<span><i class=sw style="background:var(--' + f + ')"></i>' + f + '</span>').join("");

  const hbars = (obj, colorFn) => {
    const rows = Object.entries(obj).filter(([, v]) => v > 0.005).sort((a, b) => b[1] - a[1]);
    if (!rows.length) return '<div class=empty>Nothing in this period</div>';
    const tot = rows.reduce((a, r) => a + r[1], 0);
    return rows.map(([k, v]) => '<div class=hb><div class=hb-top><span>' + esc(k) + '</span><span>' + usd(v) + ' · ' + Math.round(v / tot * 100) + '%</span></div><div class=track><div class=fill style="width:' + (v / rows[0][1] * 100).toFixed(1) + '%;background:' + colorFn(k) + '"></div></div></div>').join("");
  };
  $("machines").innerHTML = hbars(byMachine, () => "var(--accent)");
  $("models").innerHTML = hbars(byModel, color);

  // top sessions
  const q = $("q").value.trim().toLowerCase(), src = $("src").value, sort = $("sort").value;
  let list = ses.filter(s => (!src || s.s === src) && (!q || (s.t + " " + s.f).toLowerCase().includes(q)));
  list.sort((a, b) => sort === "st" ? (a.st < b.st ? 1 : -1) : b[sort] - a[sort]);
  $("ses-note").textContent = list.length.toLocaleString() + " sessions · " + label;
  $("rows").innerHTML = list.slice(0, shown).map(s => {
    const main = Object.entries(s.mc).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    const d = new Date(s.st);
    return '<tr><td class=muted>' + d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + '<br>' + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) + '</td>' +
      '<td class=title><div>' + (s.t ? esc(s.t) : '<span class=muted>(no prompt text)</span>') + '</div><div class=muted>' + esc(s.f || "") + '</div></td>' +
      '<td><span class=pill>' + esc(s.s) + '</span></td><td class=num>' + dur(s.st, s.en) + '</td><td class=num>' + s.m.toLocaleString() + '</td>' +
      '<td>' + (main ? '<i class=sw style="background:' + color(main) + '"></i>' + esc(main) : "") + '</td><td class=num><b>' + usd(s.c) + '</b></td></tr>';
  }).join("") || '<tr><td colspan=7 class=empty>No sessions match</td></tr>';
  $("more").hidden = list.length <= shown;
}

$("period").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  period = +b.dataset.d; shown = 25;
  try { localStorage.setItem("period", period); } catch {}
  draw();
});
for (const id of ["q", "src", "sort"]) $(id).addEventListener("input", () => { shown = 25; draw(); });
$("more").addEventListener("click", () => { shown += 25; draw(); });
draw();
</script>`;
}
