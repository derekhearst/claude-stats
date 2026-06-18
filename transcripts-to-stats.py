#!/usr/bin/env python
"""Reconstruct a stats-cache.json-equivalent from raw Claude Code transcripts.

Reads every projects/**/*.jsonl under the given root and emits a JSON file in
the same shape merge-stats.mjs consumes. Counts are computed independently from
the transcripts, so they may differ slightly from Claude Code's native panel.
"""
import json, glob, sys, os, collections
from datetime import datetime, timezone

root = sys.argv[1] if len(sys.argv) > 1 else "work-extract"
out  = sys.argv[2] if len(sys.argv) > 2 else "data/work.json"

files = glob.glob(os.path.join(root, "projects", "**", "*.jsonl"), recursive=True)

def local_date(ts):
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d")
def local_hour(ts):
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone().hour
def to_ms(ts):
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000

daily = collections.defaultdict(lambda: {"messageCount": 0, "sessionCount": 0, "toolCallCount": 0})
daily_model = collections.defaultdict(lambda: collections.defaultdict(int))  # date -> model -> in+out
model_usage = collections.defaultdict(lambda: collections.defaultdict(int))
hour_counts = collections.Counter()
sessions = {}  # sid -> {first, last, msgs, date}
total_messages = 0
first_session = None

for fp in files:
    with open(fp, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            t = d.get("type")
            ts = d.get("timestamp")
            sid = d.get("sessionId")
            if t not in ("user", "assistant"):
                continue
            if not ts:
                continue
            date = local_date(ts)
            ms = to_ms(ts)

            total_messages += 1
            daily[date]["messageCount"] += 1

            # session bookkeeping
            if sid:
                s = sessions.get(sid)
                if s is None:
                    sessions[sid] = {"first": ms, "last": ms, "msgs": 1, "date": date, "ts": ts}
                else:
                    s["first"] = min(s["first"], ms)
                    s["last"]  = max(s["last"], ms)
                    s["msgs"] += 1

            if first_session is None or ts < first_session:
                first_session = ts

            if t == "assistant":
                msg = d.get("message") or {}
                model = msg.get("model")
                usage = msg.get("usage") or {}
                if model and usage:
                    it = usage.get("input_tokens", 0) or 0
                    ot = usage.get("output_tokens", 0) or 0
                    daily_model[date][model] += it + ot
                    mu = model_usage[model]
                    mu["inputTokens"] += it
                    mu["outputTokens"] += ot
                    mu["cacheReadInputTokens"] += usage.get("cache_read_input_tokens", 0) or 0
                    mu["cacheCreationInputTokens"] += usage.get("cache_creation_input_tokens", 0) or 0
                    stu = usage.get("server_tool_use") or {}
                    mu["webSearchRequests"] += stu.get("web_search_requests", 0) or 0
                # tool calls
                content = msg.get("content")
                if isinstance(content, list):
                    n = sum(1 for c in content if isinstance(c, dict) and c.get("type") == "tool_use")
                    daily[date]["toolCallCount"] += n

# session start hour + per-day session counts
for sid, s in sessions.items():
    start_ts = s["ts"]
    hour_counts[str(local_hour(start_ts))] += 1
    daily[s["date"]]["sessionCount"] += 1

# longest session by wall-clock duration
longest = None
for sid, s in sessions.items():
    dur = s["last"] - s["first"]
    if longest is None or dur > longest["duration"]:
        longest = {"sessionId": sid, "duration": int(dur),
                   "messageCount": s["msgs"], "timestamp": s["ts"]}

result = {
    "version": 2,
    "computedFrom": "transcripts",
    "dailyActivity": [dict(date=d, **v) for d, v in sorted(daily.items())],
    "dailyModelTokens": [{"date": d, "tokensByModel": dict(m)} for d, m in sorted(daily_model.items())],
    "modelUsage": {k: dict(v) for k, v in model_usage.items()},
    "totalSessions": len(sessions),
    "totalMessages": total_messages,
    "longestSession": longest,
    "firstSessionDate": first_session,
    "hourCounts": dict(hour_counts),
}

os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "w", encoding="utf-8") as fh:
    json.dump(result, fh, indent=2)

print(f"Parsed {len(files)} files, {len(sessions)} sessions, {total_messages} messages")
print(f"Wrote {out}")
