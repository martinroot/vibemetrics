# VibeMetrics

VibeMetrics is a self-hosted web analytics portal for a network of sites. It collects page-view events from a lightweight tracker, stores them in your own ClickHouse, and presents the data in a dashboard: visitor and page-view totals, human vs. bot traffic (User-Agent heuristic), countries, sources and attribution with CRM deals, behavioral features, and reports. Projects can be tagged and filtered, and the whole dataset is available to AI agents through a read-only MCP server.

Live instance: https://vibemetrics.click · Integration guide for agents: https://vibemetrics.click/agent.md

## Features

- **Project registry** — register sites, group them with tags, filter the table by tag, and see per-tag summary KPIs (visitors, pageviews) plus an hour-of-day visitor chart. Real URLs for every view (`/panel/projects?tag=OpenMVP`).
- **Traffic quality** — one logical `page_view` per page with dwell time and scroll depth; `human` / `bot` / `unknown` classification by User-Agent heuristic; country via local GeoIP (DB-IP Lite). Raw IPs and full User-Agents are never stored.
- **Attribution and CRM** — first/last-touch channel attribution; deals sent to `/api/crm` are matched to a preceding conversion of the same `person_id` with revenue in USD.
- **Periods** — today, yesterday, 7/14/30 days, with the previous period shown for comparison.
- **Export** — CSV/JSON downloads for projects, attribution, and daily series.
- **MCP server** — a read-only stdio MCP server (`list_projects`, `get_snapshot`, `export_csv`) so AI agents can pull analytics.
- **Agent API** — IP-bound agent keys (`POST /api/agent/key`), site registration (`POST /api/agent/sites`), and a unified stats endpoint:
  ```http
  GET /api/agent/stats?domains=example.com,example.net&days=14
  Authorization: Bearer <ip-bound key>
  ```
  One or many domains (up to 50), period as `days=1..90` or `from`/`to` dates; per-domain pageviews, visitors, sessions, conversions, averages, and CRM deals.

## Quick start (self-hosted)

Requires Docker and Compose v2:

```sh
cp .env.example .env       # fill in five distinct secrets (openssl rand -hex 24)
docker compose up --build -d
```

Open `http://127.0.0.1:8080/` and sign in with `VM_ADMIN_USER` / `VM_ADMIN_PASSWORD`. Compose publishes only the portal on loopback — put a TLS proxy or SSH tunnel in front for remote access. Events are stored in a ClickHouse volume, the project registry in a SQLite volume.

To seed a separate test instance with synthetic data:

```sh
python3 selfhost/seed_demo.py
```

## Events and CRM (server-side ingest)

Both routes accept a single JSON object or an array of up to 500 objects. Re-sending with the same identifiers is idempotent. Keep `VM_INGEST_TOKEN` on the server.

```sh
curl --fail-with-body http://127.0.0.1:8080/api/events \
  -H "Authorization: Bearer $VM_INGEST_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"project_id":"tapapp","event_id":"purchase-42","session_id":"session-42","person_id":"person-42","event_name":"purchase","channel":"Paid search","page":"/checkout","is_conversion":true}'
```

```sh
curl --fail-with-body http://127.0.0.1:8080/api/crm \
  -H "Authorization: Bearer $VM_INGEST_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"project_id":"tapapp","deal_id":"deal-42","person_id":"person-42","revenue":"129.00","currency":"USD"}'
```

`timestamp` (events) and `closed_at` (deals) take ISO 8601 with a timezone and default to the receipt time. Use one stable `person_id` on both sides for end-to-end attribution; anonymous events fall back to `session_id` within the project. Attribution covers touches with a known channel from the start of the period up to the conversion; each deal is credited once to the closest preceding conversion of the same client in the same project. Day boundaries are UTC.

## Site tracker

Add the snippet shown after project registration to the site (before `</body>`):

```html
<script defer src="https://your-vibemetrics-host/tracker.js" data-site-id="example-com" data-site-key="..."></script>
```

The tracker sends one `page_view` per page and updates that record with active time and scroll depth; extra events only via `data-vm-event` or `window.vibeTrack('purchase', { plan: 'standard' }, true)`. After user login, call `window.vibeIdentify('customer-315')` with a non-personal opaque ID. The collector accepts up to 100 events per batch and rate-limits to ~300 requests per minute per site/IP pair.

Goal 1 / Goal 2 are built-in in the public dashboard: fire `window.vibeGoal('Goal1', {...})` or `Goal2` from a site and they appear in the KPI cards, project table and engagement panel without registry setup. Time on page now counts **active** time only: the tab must be visible, focused, and recently interacted with (30s idle cutoff, 60s per-interval cap), so open popunder tabs no longer inflate it. The tracker also records `clicks`, `keys`, `scrolls`, `interacted`, `interaction_ms` and `refocused`; engaged sessions require 10s of active time plus 2+ actions (or a goal).

## AI traffic review

Each project overview includes an **AI marketer** panel: an explicit chain
(observation → hypothesis → check → conclusion), anomalies and prioritized
recommendations. `GET /api/ai/insights?project=ID&days=7` returns the same
JSON; results are cached for 6 hours, and panel admins can force a refresh
with `/panel/api/ai/insights?project=ID&days=7&force=1`. The model receives
only metrics from the selected project snapshot — no external data. When no
LLM key is configured, a deterministic rule-based review is returned instead.
Every number in the response is checked against the snapshot (`grounding`);
a new LLM call is limited to `VM_AI_MAX_CALLS_PER_HOUR` (20 by default) and the
response reports `cached: true|false`. The panel stays visible across all
project report tabs and can export the review as Markdown.

## Custom goals and postbacks

Configure goals per site (up to 50 names, `A-Za-z0-9_.:-`, max 80 chars) with the Basic-authenticated panel API. Any event whose name is in `goals` counts as a conversion, even without a JS flag:

```bash
curl -u 'admin:***' -X POST https://vibemetrics.click/panel/api/projects/goals \
  -H 'Content-Type: application/json' \
  -d '{"id":"my-site","goals":["purchase","lead"],"postback_url":"https://my-site.com/vm-postback"}'
```

On the site, fire a goal with `window.vibeGoal('purchase', { plan: 'standard' })` (alias of `vibeTrack(name, props, true)`). When `?clid=...` is present in the URL, the tracker attaches `clid` to events; a goal conversion with a `clid` triggers an async `POST` to `postback_url` with `{project_id, clid, goal, event_id, timestamp, session_id, person_id}`. Set `VM_POSTBACK_SECRET` to add an HMAC-SHA256 `X-VibeMetrics-Signature` header. Delivery is at-least-once — dedupe on `event_id`. Disable with `{"id":"my-site","goals":[],"postback_url":""}`. See `/agent.md` for the full integration guide.

## MCP for agents

```json
{
  "mcpServers": {
    "vibemetrics": {
      "command": "python3",
      "args": ["/absolute/path/to/selfhost/mcp_server.py"],
      "env": { "VM_API_URL": "http://127.0.0.1:8080", "VM_READ_TOKEN": "your-read-token" }
    }
  }
}
```

| Tool | Data |
| --- | --- |
| `list_projects` | Projects and stable IDs |
| `get_snapshot` | Totals, daily series, attribution, features, and the last 100 events |
| `export_csv` | CSV for projects, attribution, daily events, or behavioral features |

## Layout

- `index.html`, `assets/` — portal UI (single-page, real-URL routing).
- `compose.yaml`, `.env.example` — deployment.
- `selfhost/app.py`, `warehouse.py`, `schema.sql` — HTTP API and data model.
- `selfhost/tracker.js` — site tracker.
- `selfhost/mcp_server.py` — read-only MCP bridge.
- `skills/` — ready-made agent skill instructions.

## Security notes

- The agent API key from `/api/agent/key` is bound to the caller's server IP.
- `site_key` is a public, origin-restricted browser key — not a secret.
- Never expose `VM_AGENT_KEY_SECRET`, `VM_INGEST_TOKEN`, `VM_READ_TOKEN`, or `CLICKHOUSE_PASSWORD` to browsers or agents.
