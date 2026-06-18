#!/usr/bin/env bun
/**
 * merge-stats.mjs — Combine Claude Code stats-cache.json files from multiple
 * machines into one unified dashboard.
 *
 * Usage:
 *   bun merge-stats.mjs                 # merges every *.json in ./data
 *   bun merge-stats.mjs a.json b.json   # merges the files you pass
 *
 * Each input is a copy of  <user>\.claude\stats-cache.json  from one PC.
 * Name the files after the machine, e.g. data/home.json, data/work.json —
 * the filename (minus .json) becomes the machine label in the report.
 *
 * Outputs:
 *   combined-stats.json   merged raw data
 *   dashboard.html        self-contained page (summary cards + heatmap)
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, "data");

// ---- gather input files -------------------------------------------------
let files = process.argv.slice(2);
if (files.length === 0) {
  if (!existsSync(DATA_DIR)) {
    console.error(`No files given and ${DATA_DIR} does not exist.`);
    process.exit(1);
  }
  files = readdirSync(DATA_DIR)
    .filter((f) => f.toLowerCase().endsWith(".json"))
    .map((f) => join(DATA_DIR, f));
}
if (files.length === 0) {
  console.error("No stats-cache JSON files found. Drop them in ./data first.");
  process.exit(1);
}

// ---- merge --------------------------------------------------------------
const merged = {
  machines: [],
  dailyActivity: {},      // date -> {messageCount, sessionCount, toolCallCount}
  dailyModelTokens: {},   // date -> {model -> tokens}
  modelUsage: {},         // model -> summed token fields
  totalSessions: 0,
  totalMessages: 0,
  hourCounts: {},
  firstSessionDate: null,
  longestSession: null,
};

const addInto = (target, key, fields, src) => {
  target[key] ??= {};
  for (const f of fields) target[key][f] = (target[key][f] || 0) + (src[f] || 0);
};

for (const path of files) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`Skipping ${path}: ${e.message}`);
    continue;
  }
  const label = basename(path).replace(/\.json$/i, "");
  merged.machines.push(label);

  for (const d of raw.dailyActivity || []) {
    addInto(merged.dailyActivity, d.date,
      ["messageCount", "sessionCount", "toolCallCount"], d);
  }
  for (const d of raw.dailyModelTokens || []) {
    merged.dailyModelTokens[d.date] ??= {};
    for (const [m, t] of Object.entries(d.tokensByModel || {}))
      merged.dailyModelTokens[d.date][m] = (merged.dailyModelTokens[d.date][m] || 0) + t;
  }
  for (const [m, u] of Object.entries(raw.modelUsage || {})) {
    addInto(merged.modelUsage, m, [
      "inputTokens", "outputTokens", "cacheReadInputTokens",
      "cacheCreationInputTokens", "webSearchRequests", "costUSD",
    ], u);
  }
  merged.totalSessions += raw.totalSessions || 0;
  merged.totalMessages += raw.totalMessages || 0;
  for (const [h, c] of Object.entries(raw.hourCounts || {}))
    merged.hourCounts[h] = (merged.hourCounts[h] || 0) + c;

  if (raw.firstSessionDate &&
      (!merged.firstSessionDate || raw.firstSessionDate < merged.firstSessionDate))
    merged.firstSessionDate = raw.firstSessionDate;

  if (raw.longestSession &&
      (!merged.longestSession ||
       raw.longestSession.duration > merged.longestSession.duration))
    merged.longestSession = { ...raw.longestSession, machine: label };
}

// ---- derived totals -----------------------------------------------------
// Headline tokens = input + output, matching the welcome panel (which excludes
// cache reads/creation). dailyModelTokens already holds that billed-style count.
const tokensPerModel = {};
let totalTokens = 0;
for (const day of Object.values(merged.dailyModelTokens)) {
  for (const [m, t] of Object.entries(day)) {
    tokensPerModel[m] = (tokensPerModel[m] || 0) + t;
    totalTokens += t;
  }
}
// Cache tokens tracked separately (huge, not part of the headline number).
let totalCacheRead = 0, totalCacheCreate = 0;
for (const u of Object.values(merged.modelUsage)) {
  totalCacheRead += u.cacheReadInputTokens || 0;
  totalCacheCreate += u.cacheCreationInputTokens || 0;
}
for (const m of Object.keys(tokensPerModel))
  if (tokensPerModel[m] === 0) delete tokensPerModel[m]; // drop synthetic/empty
const favoriteModel =
  Object.entries(tokensPerModel).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—";

const activeDays = Object.keys(merged.dailyActivity).length;
const peakHour =
  Object.entries(merged.hourCounts).sort((a, b) => b[1] - a[1])[0]?.[0];

// longest run of consecutive active days
const sortedDates = Object.keys(merged.dailyActivity).sort();
let longestStreak = 0, cur = 0, prev = null;
for (const ds of sortedDates) {
  const d = new Date(ds + "T00:00:00Z");
  if (prev && (d - prev) === 86400000) cur++;
  else cur = 1;
  prev = d;
  if (cur > longestStreak) longestStreak = cur;
}

const fmt = (n) => n.toLocaleString("en-US");
const fmtTok = (n) =>
  n >= 1e9 ? (n / 1e9).toFixed(1) + "B" :
  n >= 1e6 ? (n / 1e6).toFixed(1) + "M" :
  n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(n);
const hr12 = (h) => {
  h = +h; const ap = h < 12 ? "AM" : "PM";
  const x = h % 12 === 0 ? 12 : h % 12; return `${x} ${ap}`;
};

// ---- console summary ----------------------------------------------------
console.log("\n=== Combined Claude Code stats ===");
console.log("Machines        :", merged.machines.join(", "));
console.log("Sessions        :", fmt(merged.totalSessions));
console.log("Messages        :", fmt(merged.totalMessages));
console.log("Total tokens    :", fmtTok(totalTokens), `(${fmt(totalTokens)})  [input+output]`);
console.log("Cache read      :", fmtTok(totalCacheRead));
console.log("Cache created   :", fmtTok(totalCacheCreate));
console.log("Active days     :", activeDays);
console.log("Longest streak  :", longestStreak, "d");
console.log("Peak hour       :", peakHour != null ? hr12(peakHour) : "—");
console.log("Favorite model  :", favoriteModel);
console.log("First session   :", merged.firstSessionDate || "—");
console.log("\nTokens by model:");
for (const [m, t] of Object.entries(tokensPerModel).sort((a, b) => b[1] - a[1]))
  console.log(`  ${m.padEnd(20)} ${fmtTok(t)}`);

// ---- HTML dashboard -----------------------------------------------------
const maxMsgs = Math.max(1, ...Object.values(merged.dailyActivity).map((d) => d.messageCount));
const cell = (date) => {
  const a = merged.dailyActivity[date];
  if (!a) return { lvl: 0, title: `${date}: no activity` };
  const lvl = Math.min(4, Math.ceil((a.messageCount / maxMsgs) * 4));
  return { lvl, title: `${date}: ${fmt(a.messageCount)} msgs, ${a.sessionCount} sessions` };
};

// build a calendar grid: weeks as columns, days(Sun..Sat) as rows
let gridStart = sortedDates[0] ? new Date(sortedDates[0] + "T00:00:00Z") : new Date();
let gridEnd = sortedDates.length ? new Date(sortedDates.at(-1) + "T00:00:00Z") : new Date();
gridStart.setUTCDate(gridStart.getUTCDate() - gridStart.getUTCDay()); // back to Sunday
const weeks = [];
for (let d = new Date(gridStart); d <= gridEnd; d.setUTCDate(d.getUTCDate() + 1)) {
  const iso = d.toISOString().slice(0, 10);
  const wk = Math.floor((d - gridStart) / (7 * 86400000));
  (weeks[wk] ??= []).push(iso);
}
const heatCols = weeks.map((wk) =>
  `<div class="col">${wk.map((iso) => {
    const c = cell(iso);
    return `<div class="d l${c.lvl}" title="${c.title}"></div>`;
  }).join("")}</div>`).join("");

const card = (label, val) =>
  `<div class="card"><div class="lbl">${label}</div><div class="val">${val}</div></div>`;

const html = `<!doctype html><meta charset="utf-8">
<title>Claude Code — combined stats</title>
<style>
  body{background:#1a1a1a;color:#e8e8e8;font:14px/1.4 system-ui,sans-serif;margin:0;padding:32px}
  h1{font-size:20px;font-weight:600;margin:0 0 4px}
  .sub{color:#888;margin-bottom:24px;font-size:13px}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;max-width:760px}
  .card{background:#242424;border:1px solid #333;border-radius:8px;padding:14px 16px}
  .lbl{color:#999;font-size:12px;margin-bottom:6px}
  .val{font-size:20px;font-weight:600}
  .heat{display:flex;gap:3px;margin-top:28px;overflow-x:auto;padding-bottom:8px}
  .col{display:flex;flex-direction:column;gap:3px}
  .d{width:12px;height:12px;border-radius:2px;background:#262626}
  .l1{background:#1e3a5f}.l2{background:#2f5b94}.l3{background:#4a83cf}.l4{background:#6ba3f0}
  table{border-collapse:collapse;margin-top:24px;font-size:13px}
  td,th{padding:5px 14px 5px 0;text-align:left}th{color:#999;font-weight:500}
  .legend{display:flex;align-items:center;gap:4px;color:#888;font-size:11px;margin-top:8px}
</style>
<h1>✳ Combined Claude Code stats</h1>
<div class="sub">Machines: ${merged.machines.join(" + ")} · first session ${merged.firstSessionDate?.slice(0,10) || "—"}</div>
<div class="grid">
  ${card("Sessions", fmt(merged.totalSessions))}
  ${card("Messages", fmt(merged.totalMessages))}
  ${card("Total tokens", fmtTok(totalTokens))}
  ${card("Active days", activeDays)}
  ${card("Longest streak", longestStreak + "d")}
  ${card("Peak hour", peakHour != null ? hr12(peakHour) : "—")}
  ${card("Favorite model", favoriteModel.replace("claude-", ""))}
  ${card("Models used", Object.keys(tokensPerModel).length)}
</div>
<div class="heat">${heatCols}</div>
<div class="legend">Less
  <span class="d l0"></span><span class="d l1"></span><span class="d l2"></span>
  <span class="d l3"></span><span class="d l4"></span> More</div>
<table>
  <tr><th>Model</th><th>Tokens</th></tr>
  ${Object.entries(tokensPerModel).sort((a,b)=>b[1]-a[1])
    .map(([m,t])=>`<tr><td>${m}</td><td>${fmtTok(t)} (${fmt(t)})</td></tr>`).join("")}
</table>`;

writeFileSync(join(HERE, "combined-stats.json"), JSON.stringify(merged, null, 2));
writeFileSync(join(HERE, "dashboard.html"), html);
console.log("\nWrote combined-stats.json and dashboard.html");
console.log("Open dashboard.html in a browser to see the heatmap.\n");
