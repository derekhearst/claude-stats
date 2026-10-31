# Claude usage dashboard

A live, cloud-hosted dashboard that tracks your Claude usage across machines and
surfaces — built on Cloudflare Workers + D1.

```
home PC  ──┐
work PC  ──┤
devbox   ──┼─ (scheduled) ──POST /ingest──▶  Worker ──▶ D1
agent-runner (hourly, from its dispatcher)     │
web export ┘ (manual)                          │
                                  any browser ◀─┘  GET / (password-gated dashboard)
```

- **Claude Code (per machine):** fully automatic via a scheduled collector that parses
  local transcripts under `~/.claude/projects`. A downloaded copy of the collector updates
  itself from this repo on each run; a git checkout does not.
- **agent-runner / devbox:** the TrueNAS agent runner reports its issue runs, and its dev box
  runs the collector over its own history (see the agent-runner README).
- **claude.ai web:** semi-manual — request a data export and run the collector on it.
- **Tokens + estimated cost:** included for Claude Code; web is activity-only (the
  consumer export carries no token counts).

## The dashboard

- A **7d / 30d / 90d / All** switch drives the cost cards, the token chart (input + output per day, stacked
  by model family), cost by machine and by model, and **Top sessions**.
- **Top sessions** lists each session with the opening of its first prompt as its title,
  the folder, machine, length, messages, main model and cost. Search and sort it in place.
- Below: activity heatmap, time of day, weekday and top tools (all time).
- Prices come live from LiteLLM's public price list (cached daily), with a built-in table
  as fallback. A session's cost counts on the day it started.
- A machine whose collector has not yet sent a session list shows as "totals only" and
  counts only in **All**.

## Components

| Path | What it is |
|---|---|
| `dashboard/` | Cloudflare Worker — `POST /ingest` (auth) + password-gated dashboard at `/` |
| `collector/collect.mjs` | Per-PC collector: parses transcripts (or a web export) → POSTs a snapshot |
| `merge-stats.mjs` | Offline alternative: merges `stats-cache.json` files into a local HTML report |
| `transcripts-to-stats.py` | Offline: reconstruct a stats snapshot from raw transcripts |

## Secrets

Two secrets are required, kept **out of this repo** (`SECRETS.local.md` and the real
`collector/collector.config.json` are gitignored):

| Secret | Used for |
|---|---|
| `INGEST_TOKEN` | collectors authenticate their POSTs |
| `DASH_KEY` | the dashboard login password |

Generate your own with e.g. `openssl rand -base64 24`.

## 1. Deploy the Worker

```sh
cd dashboard
bunx wrangler login
bunx wrangler secret put INGEST_TOKEN     # paste your ingest token
bunx wrangler secret put DASH_KEY         # paste your dashboard password
bunx wrangler deploy
```

The D1 binding and the custom domain are set in `wrangler.toml`. A custom domain
requires its zone to be active on the same Cloudflare account — `wrangler deploy` then
creates the DNS record + cert. Remove the `[[routes]]` block to use the free
`*.workers.dev` URL that `deploy` prints instead.

View the dashboard at your URL → password login → enter your `DASH_KEY`. The login is
stored in a cookie (sign in once per browser/device). `/logout` clears it.

## 2. Set up the collector (on each PC)

1. Copy `collector/collector.config.example.json` to `collector/collector.config.json`
   and fill in the machine's `source` name, your Worker `url`, and the `token`
   (= `INGEST_TOKEN`).
2. Test: `cd collector && bun collect.mjs` → should print `Pushed <source>: N days ...`.
3. Schedule daily (Windows Task Scheduler):
   ```
   schtasks /create /tn "Claude usage collector" /tr "C:\path\to\collector\run-collector.cmd" /sc daily /st 23:30
   ```

Works under `bun` or Node 18+ (no dependencies).

## 3. Web (claude.ai) — periodic, manual

1. claude.ai → Settings → Privacy → Export data.
2. Unzip; find `conversations.json`.
3. `bun collect.mjs --web "path/to/conversations.json"` (pushes a `web` source —
   sessions/messages/heatmap only, no tokens).

## Notes

- **Idempotent:** each run replaces that source's data wholesale — re-running never
  double-counts. The collector reads full local history each time.
- **Cost is hypothetical** — subscriptions are billed flat; the figure is what the same
  tokens would cost at API list price, cache reads and writes at each model's own rates.
- **Keep history forever:** set `cleanupPeriodDays` high in `~/.claude/settings.json` so
  Claude Code stops auto-deleting transcripts after 30 days.
