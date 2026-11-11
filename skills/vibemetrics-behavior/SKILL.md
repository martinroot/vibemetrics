---
name: vibemetrics-behavior
description: Use when interpreting VibeMetrics behavior features and recent events via MCP. Use only the server-provided definitions.
---

# VibeMetrics Behavior

Use `get_snapshot` to review the `features` and `events` sections for a selected project and period.

## Workflow

1. Select a project using its ID from `list_projects`.
2. Request a supported period (`7`, `14`, or `30` days).
3. Quote the feature definitions returned by the server when explaining counts.
4. Use recent events as examples of recorded event types only; do not treat the limited recent-event list as a complete log.
5. Distinguish counts of sessions from counts of visitors and events.

## Limits

The current snapshot exposes defined aggregate features and at most 100 recent events. It does not guarantee automatic scroll, click, time-on-page, or exit tracking; those require the corresponding events to be sent. Never claim a behavior was measured unless the relevant event or feature is present.
