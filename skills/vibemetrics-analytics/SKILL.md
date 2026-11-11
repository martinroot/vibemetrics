---
name: vibemetrics-analytics
description: Use when summarizing VibeMetrics project statistics through MCP. Keep comparisons period-bound and distinguish events from sessions.
---

# VibeMetrics Analytics

Use the VibeMetrics MCP tools to answer questions about project traffic statistics.

## Workflow

1. Call `list_projects` to resolve the exact project ID. Do not guess IDs.
2. Call `get_snapshot` with the requested project and a supported period (`7`, `14`, or `30` days). Use `model=last` unless the user requests first-touch attribution.
3. For comparisons, use the returned `daily` and `previous` arrays and state both periods. Do not infer causation from a change in counts.
4. Use `export_csv` only when the user asks for a file or raw slice.
5. State when the dataset is empty or marked demo. Never present synthetic demo values as live measurements.

## Interpretation

- `events` count tracked actions; they are not unique visitors.
- `sessions` count observed sessions; they are not people.
- Report the selected project and period with every conclusion.
- Use only fields returned by MCP; do not invent geography, devices, campaign spend, or page-level metrics that are absent from the snapshot.
