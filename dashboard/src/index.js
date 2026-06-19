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

const PRICE = {
  "claude-opus-4-8":          { in: 5,  out: 25 },
  "claude-opus-4-7":          { in: 5,  out: 25 },
  "claude-opus-4-6":          { in: 5,  out: 25 },
  "claude-opus-4-5":          { in: 5,  out: 25 },
  "claude-sonnet-4-6":        { in: 3,  out: 15 },
  "claude-sonnet-4-5":        { in: 3,  out: 15 },
  "claude-haiku-4-5":         { in: 1,  out: 5  },
  "claude-haiku-4-5-20251001":{ in: 1,  out: 5  },
  "claude-fable-5":           { in: 10, out: 50 },
  "claude-mythos-5":          { in: 10, out: 50 },
};

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
  for (const r of mu) {
    totalCacheRead += r.cache_read || 0;
    const p = PRICE[r.model]; if (!p) continue;
    const c = r.input_tokens / 1e6 * p.in
            + r.output_tokens / 1e6 * p.out
            + r.cache_create / 1e6 * p.in * 1.25
            + r.cache_read / 1e6 * p.in * 0.1;
    cost += c;
    costRows.push([r.source, r.model, c]);
    // what cache reads saved vs paying full input price (0.1x → 1x)
    cacheSavings += (r.cache_read || 0) / 1e6 * p.in * 0.9;
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
    const p = PRICE[r.model];
    const a = (projAgg[r.project] ??= { tokens: 0, cost: 0 });
    a.tokens += (r.input_tokens || 0) + (r.output_tokens || 0);
    if (p) a.cost += r.input_tokens / 1e6 * p.in + r.output_tokens / 1e6 * p.out
                   + r.cache_create / 1e6 * p.in * 1.25 + r.cache_read / 1e6 * p.in * 0.1;
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

  // heatmap grid
  const maxMsgs = Math.max(1, ...Object.values(byDate));
  let heat = "";
  if (dates.length) {
    let start = new Date(dates[0] + "T00:00:00Z");
    const end = new Date(dates.at(-1) + "T00:00:00Z");
    start.setUTCDate(start.getUTCDate() - start.getUTCDay());
    const weeks = [];
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      const wk = Math.floor((d - start) / (7 * 86400000));
      (weeks[wk] ??= []).push(iso);
    }
    heat = weeks.map(wk => `<div class=col>${wk.map(iso => {
      const v = byDate[iso] || 0;
      const lvl = v ? Math.min(4, Math.ceil(v / maxMsgs * 4)) : 0;
      const title = v ? `${iso}: ${fmt(v)} msgs` : `${iso}: none`;
      return `<div class="d l${lvl}" title="${title}"></div>`;
    }).join("")}</div>`).join("");
  }

  const card = (l, v) => `<div class=card><div class=lbl>${l}</div><div class=val>${v}</div></div>`;
  const lastPush = meta.map(m => `${m.source}: ${(m.last_push||"").slice(0,16).replace("T"," ")}`).join(" · ");

  return `<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Claude usage</title>
<style>
 body{background:#161616;color:#e8e8e8;font:14px/1.45 system-ui,sans-serif;margin:0;padding:24px}
 h1{font-size:19px;margin:0 0 2px}.sub{color:#888;font-size:12px;margin-bottom:20px}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;max-width:880px}
 .card{background:#222;border:1px solid #333;border-radius:8px;padding:13px 15px}
 .lbl{color:#999;font-size:12px;margin-bottom:5px}.val{font-size:19px;font-weight:600}
 .heat{display:flex;gap:3px;margin:26px 0 6px;overflow-x:auto;padding-bottom:6px}
 .col{display:flex;flex-direction:column;gap:3px}
 .d{width:12px;height:12px;border-radius:2px;background:#262626}
 .l1{background:#1e3a5f}.l2{background:#2f5b94}.l3{background:#4a83cf}.l4{background:#6ba3f0}
 .legend{color:#888;font-size:11px;display:flex;gap:4px;align-items:center}
 table{border-collapse:collapse;margin-top:22px;font-size:13px}
 td,th{padding:5px 16px 5px 0;text-align:left}th{color:#999;font-weight:500}
 h2{font-size:14px;color:#bbb;margin:26px 0 0}
 .big{font-size:23px;font-weight:700}
 .dow{display:flex;gap:8px;align-items:flex-end;height:80px;margin-top:10px}
 .dowcol{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;width:30px}
 .dowbar{width:18px;background:#4a83cf;border-radius:3px 3px 0 0;min-height:2px}
 .dowlab{color:#888;font-size:11px;margin-top:4px}
</style>
<h1>✳ Claude usage — all surfaces</h1>
<div class=sub>Sources: ${sources.join(" + ") || "none yet"} · last push — ${lastPush || "never"}</div>
<div class=grid>
 ${card("Sessions", fmt(totalSessions))}
 ${card("Messages", fmt(totalMessages))}
 ${card("Total tokens", fmtTok(totalTokens))}
 ${card("Web tokens (est.)", fmtTok(estTokens))}
 ${card("Active days", activeDays)}
 ${card("Current streak", currentStreak + "d")}
 ${card("Longest streak", longestStreak + "d")}
 ${card("Avg msgs / session", avgMsgs.toFixed(0))}
 ${card("Tool calls", fmtTok(totalTools))}
 ${card("Cache savings (est.)", usd(cacheSavings))}
 ${card("Favorite model", favoriteModel.replace("claude-",""))}
 ${card("Est. API cost", '<span class=big>'+usd(cost)+'</span>')}
 ${card("Est. $/mo (run rate)", usd(monthlyRunRate))}
 ${card("Busiest day", busiestDay ? `${busiestDay.slice(5)} · ${fmtTok(busiestN)}` : "—")}
 ${card("Peak hour", peakHour != null ? hr12(peakHour) : "—")}
</div>
<div class=heat>${heat}</div>
<div class=legend>Less <span class="d l0"></span><span class="d l1"></span><span class="d l2"></span><span class="d l3"></span><span class="d l4"></span> More</div>

<h2>Messages by weekday</h2>
<div class=dow>${["S","M","T","W","T","F","S"].map((lab,i)=>{
  const mx=Math.max(1,...dow); const h=Math.round(dow[i]/mx*60);
  return `<div class=dowcol title="${fmt(dow[i])} msgs"><div class=dowbar style="height:${h}px"></div><div class=dowlab>${lab}</div></div>`;
}).join("")}</div>

<h2>Tokens per week (Code, input+output)</h2>
<div class=dow style=height:90px>${weeks.length ? weeks.map(([wk,t])=>{
  const mx=Math.max(1,...weeks.map(w=>w[1])); const h=Math.round(t/mx*64);
  return `<div class=dowcol style=width:42px title="week of ${wk}: ${fmtTok(t)} tokens"><div class=dowbar style="width:28px;height:${h}px"></div><div class=dowlab>${wk.slice(5)}</div></div>`;
}).join("") : '<span class=sub>no data</span>'}</div>

<h2>Time of day (messages by hour, local)</h2>
<div class=dow style=height:90px>${hourCounts.map((c,h)=>{
  const mx=Math.max(1,...hourCounts); const ht=Math.round(c/mx*64);
  return `<div class=dowcol style=width:22px title="${hr12(h)}: ${fmt(c)} msgs"><div class=dowbar style="width:14px;height:${ht}px"></div><div class=dowlab>${h%3===0?h:''}</div></div>`;
}).join("")}</div>

<h2>By source</h2>
<table><tr><th>Source</th><th>Sessions</th><th>Messages</th><th>Tokens</th></tr>
${sources.map(s=>`<tr><td>${s}</td><td>${fmt(perSource[s]?.sessions||0)}</td><td>${fmt(perSource[s]?.messages||0)}</td><td>${fmtTok(tokBySource[s]||0)}${s==="web"?" <span style=color:#888>(est.)</span>":""}</td></tr>`).join("")}
</table>

<h2>By project (Code)</h2>
<table><tr><th>Project</th><th>Tokens</th><th>Est. cost</th></tr>
${projList.length ? projList.map(([p,a])=>`<tr><td title="${p}">${pretty(p)}</td><td>${fmtTok(a.tokens)}</td><td>${usd(a.cost)}</td></tr>`).join("") : "<tr><td colspan=3 class=sub>no project data yet — run the updated collector</td></tr>"}
</table>

<h2>Top tools (Code)</h2>
<table><tr><th>Tool</th><th>Calls</th></tr>
${topTools.length ? topTools.map(([t,c])=>`<tr><td>${t}</td><td>${fmt(c)}</td></tr>`).join("") : "<tr><td colspan=2 class=sub>no tool data yet — run the updated collector</td></tr>"}
</table>

<h2>Tokens by model (input+output)</h2>
<table><tr><th>Model</th><th>Tokens</th></tr>
${Object.entries(tokByModel).sort((a,b)=>b[1]-a[1]).map(([m,t])=>`<tr><td>${m}</td><td>${fmtTok(t)}</td></tr>`).join("")||"<tr><td>—</td><td>0</td></tr>"}
${estTokens?`<tr><td>web (est.) <span style=color:#888>~chars/4</span></td><td>${fmtTok(estTokens)}</td></tr>`:""}
</table>

<h2>Estimated cost at API list price</h2>
<table><tr><th>Source</th><th>Model</th><th>Cost</th></tr>
${costRows.map(([s,m,c])=>`<tr><td>${s}</td><td>${m}</td><td>${usd(c)}</td></tr>`).join("")||"<tr><td colspan=3>no token data</td></tr>"}
<tr><td colspan=2><b>Total</b></td><td><b>${usd(cost)}</b></td></tr>
</table>
<p class=sub style=margin-top:24px>Cost is hypothetical (subscription usage is billed flat). Cache-write = 1.25× input, cache-read = 0.1× input. Web tokens are a rough ~chars/4 estimate (the export has no real counts) — excluded from "Total tokens" and from cost. Run rate = total cost ÷ day-span × 30.</p>`;
}
