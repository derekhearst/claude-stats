#!/usr/bin/env bun
/**
 * Claude usage collector — runs on each PC, parses local Claude Code transcripts
 * (and optionally a claude.ai web export), and POSTs a full snapshot to the
 * dashboard Worker's /ingest endpoint. Idempotent: safe to run on a schedule.
 *
 * Config: collector.config.json next to this file:
 *   { "source": "work", "url": "https://claude-usage-stats.<sub>.workers.dev",
 *     "token": "<INGEST_TOKEN>" }
 *
 * Usage:
 *   bun collect.mjs                          # Claude Code transcripts → source from config
 *   bun collect.mjs --source home            # override source
 *   bun collect.mjs --web path/to/conversations.json   # claude.ai export → source "web"
 *
 * Works under bun or Node 18+ (uses global fetch; no dependencies).
 */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- args + config ------------------------------------------------------
const argv = process.argv.slice(2);
const getArg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

// A downloaded copy (work PC, devbox) updates itself: fetch the latest collector and, if it changed,
// save it and run that instead. A git checkout skips this; so does --no-update.
const SELF_URL = "https://raw.githubusercontent.com/derekhearst/claude-stats/main/collector/collect.mjs";
if (!argv.includes("--no-update") && !existsSync(join(HERE, "..", ".git"))) {
  try {
    const me = fileURLToPath(import.meta.url);
    const latest = await (await fetch(SELF_URL)).text();
    if (latest.startsWith("#!/usr/bin/env bun") && latest !== readFileSync(me, "utf8")) {
      writeFileSync(me, latest);
      process.exit(spawnSync(process.execPath, [me, ...argv, "--no-update"], { stdio: "inherit" }).status ?? 1);
    }
  } catch { /* offline: run this copy */ }
}

let cfg = {};
const cfgPath = join(HERE, "collector.config.json");
if (existsSync(cfgPath)) cfg = JSON.parse(readFileSync(cfgPath, "utf8"));

const webPath = getArg("--web");
const source = getArg("--source") || (webPath ? "web" : cfg.source);
const url = (getArg("--url") || cfg.url || "").replace(/\/+$/, "");
const token = getArg("--token") || cfg.token;
const claudeDir = getArg("--claude-dir") || cfg.claudeDir || join(homedir(), ".claude");
// Desktop keeps a local copy of SSH sessions (projects/ssh-<id>). Ones that ran on the agent-runner
// devbox are also in the devbox's own transcripts, which its collector reports, so skip them here.
const remoteCwdOwnedElsewhere = cfg.skipSshCwd ?? "/home/agent";

if (!source || !url || !token) {
  console.error("Need source, url, and token (via collector.config.json or flags). See header.");
  process.exit(1);
}

// ---- helpers ------------------------------------------------------------
const localDate = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

// ---- build the snapshot -------------------------------------------------
let payload;
if (webPath) payload = fromWebExport(webPath, source);
else payload = fromTranscripts(claudeDir, source);

// ---- send ---------------------------------------------------------------
const res = await fetch(url + "/ingest", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer " + token },
  body: JSON.stringify(payload),
});
const text = await res.text();
const stamp = new Date().toISOString();
if (!res.ok) { console.error(`${stamp} Ingest failed (${res.status}): ${text}`); process.exit(1); }
console.log(`${stamp} Pushed ${source}: ${payload.daily.length} days, ${payload.modelUsage.length} models → ${text}`);

// ---- parsers ------------------------------------------------------------
function fromTranscripts(dir, source) {
  const projectsDir = join(dir, "projects");
  const daily = {};            // date -> {messages,sessions,tool_calls}
  const dmt = {};              // date -> model -> tokens(in+out)
  const usage = {};            // model -> {input,output,cacheRead,cacheCreate}
  const sessionStart = {};     // sid -> date (first seen)
  const hourly = {};           // hour(0-23) -> count
  const tools = {};            // tool name -> count
  const projUsage = {};        // project -> model -> {input,output,cacheRead,cacheCreate}
  const sessions = {};         // sid -> {start,end,title,folder,messages,toolCalls,usage:{model:[in,out,cacheRead,cacheCreate]}}
  let firstSession = null;

  const projects = existsSync(projectsDir)
    ? readdirSync(projectsDir).filter(n => { try { return statSync(join(projectsDir, n)).isDirectory(); } catch { return false; } })
    : [];

  for (const project of projects) {
    for (const fp of walk(join(projectsDir, project))) {
      let lines;
      try { lines = readFileSync(fp, "utf8").split("\n"); } catch { continue; }
      for (const line of lines) {
        const t = line.trim(); if (!t) continue;
        let d; try { d = JSON.parse(t); } catch { continue; }
        if (d.type !== "user" && d.type !== "assistant") continue;
        if (remoteCwdOwnedElsewhere && project.startsWith("ssh-") && String(d.cwd || "").startsWith(remoteCwdOwnedElsewhere)) continue;
        const ts = d.timestamp; if (!ts) continue;
        const date = localDate(ts);
        const sid = d.sessionId;

        (daily[date] ??= { messages: 0, sessions: 0, tool_calls: 0 }).messages++;
        hourly[new Date(ts).getHours()] = (hourly[new Date(ts).getHours()] || 0) + 1;
        if (sid && !(sid in sessionStart)) sessionStart[sid] = date;
        const ses = sid ? (sessions[sid] ??= { start: ts, end: ts, title: "", folder: "", messages: 0, toolCalls: 0, usage: {} }) : null;
        if (ses) {
          ses.messages++;
          if (ts < ses.start) ses.start = ts;
          if (ts > ses.end) ses.end = ts;
          if (!ses.folder && d.cwd) ses.folder = String(d.cwd).split(/[\\/]/).filter(Boolean).pop() || String(d.cwd);
          if (!ses.title && d.type === "user" && !d.isSidechain && !d.isMeta) ses.title = promptTitle(d.message?.content);
        }
        if (!firstSession || ts < firstSession) firstSession = ts;

        if (d.type === "assistant") {
          const msg = d.message || {};
          const model = msg.model, u = msg.usage;
          if (model && u && model !== "<synthetic>") {
            const io = (u.input_tokens || 0) + (u.output_tokens || 0);
            (dmt[date] ??= {});
            dmt[date][model] = (dmt[date][model] || 0) + io;
            const add = (acc) => {
              acc.input += u.input_tokens || 0;
              acc.output += u.output_tokens || 0;
              acc.cacheRead += u.cache_read_input_tokens || 0;
              acc.cacheCreate += u.cache_creation_input_tokens || 0;
            };
            add(usage[model] ??= { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
            add((projUsage[project] ??= {})[model] ??= { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
            if (ses) {
              const su = (ses.usage[model] ??= [0, 0, 0, 0]);
              su[0] += u.input_tokens || 0; su[1] += u.output_tokens || 0;
              su[2] += u.cache_read_input_tokens || 0; su[3] += u.cache_creation_input_tokens || 0;
            }
          }
          const c = msg.content;
          if (Array.isArray(c))
            for (const b of c)
              if (b && b.type === "tool_use") {
                daily[date].tool_calls++;
                if (ses) ses.toolCalls++;
                tools[b.name || "?"] = (tools[b.name || "?"] || 0) + 1;
              }
        }
      }
    }
  }
  for (const [sid, date] of Object.entries(sessionStart)) daily[date].sessions++;

  return {
    source, firstSession,
    daily: Object.entries(daily).map(([date, v]) => ({ date, ...v })),
    dailyModelTokens: Object.entries(dmt).flatMap(([date, mm]) =>
      Object.entries(mm).filter(([, t]) => t > 0).map(([model, tokens]) => ({ date, model, tokens }))),
    modelUsage: Object.entries(usage).map(([model, u]) => ({ model, ...u })),
    hourly: Object.entries(hourly).map(([hour, count]) => ({ hour: +hour, count })),
    tools: Object.entries(tools).map(([tool, count]) => ({ tool, count })),
    projectUsage: Object.entries(projUsage).flatMap(([project, mm]) =>
      Object.entries(mm).map(([model, u]) => ({ project, model, ...u }))),
    sessions: Object.entries(sessions).filter(([, v]) => Object.keys(v.usage).length).map(([id, v]) => ({ id, ...v })),
  };
}

// A session's label: the opening of its first real prompt (not a slash command, hook output or
// system text), whitespace collapsed, at most 100 characters.
function promptTitle(content) {
  const text = typeof content === "string" ? content
    : Array.isArray(content) ? content.filter(b => b && b.type === "text").map(b => b.text).join(" ") : "";
  const t = text.replace(/\s+/g, " ").trim();
  if (!t || /^(<|Caveat:|\[Request interrupted|This session is being continued)/.test(t)) return "";
  return t.length > 100 ? t.slice(0, 99) + "…" : t;
}

function fromWebExport(path, source) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const convos = Array.isArray(raw) ? raw : (raw.conversations || []);
  const daily = {};
  const estByDate = {};         // date -> estimated tokens (~chars/4)
  let firstSession = null;

  const msgText = (m) => {
    if (typeof m.text === "string" && m.text) return m.text;
    if (Array.isArray(m.content))
      return m.content.map(b => (b && typeof b.text === "string") ? b.text : "").join(" ");
    return "";
  };

  for (const c of convos) {
    const cStart = c.created_at || c.create_time || c.created;
    if (cStart) {
      const d = localDate(cStart);
      (daily[d] ??= { messages: 0, sessions: 0, tool_calls: 0 }).sessions++;
      if (!firstSession || new Date(cStart).toISOString() < firstSession)
        firstSession = new Date(cStart).toISOString();
    }
    const msgs = c.chat_messages || c.messages || [];
    for (const m of msgs) {
      const ts = m.created_at || m.create_time || cStart;
      if (!ts) continue;
      const d = localDate(ts);
      (daily[d] ??= { messages: 0, sessions: 0, tool_calls: 0 }).messages++;
      estByDate[d] = (estByDate[d] || 0) + Math.ceil(msgText(m).length / 4); // ~4 chars/token
    }
  }
  // Estimated tokens go under a clearly-labeled pseudo-model so the dashboard can
  // keep them separate from real Code token counts and from the cost figure.
  return {
    source, firstSession,
    daily: Object.entries(daily).map(([date, v]) => ({ date, ...v })),
    dailyModelTokens: Object.entries(estByDate)
      .filter(([, t]) => t > 0)
      .map(([date, tokens]) => ({ date, model: "web (est.)", tokens })),
    modelUsage: [],
  };
}
