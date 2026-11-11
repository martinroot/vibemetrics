---
name: vibemetrics-attribution
description: Use when comparing VibeMetrics first-touch and last-touch attribution through MCP. Separate conversions, linked deals, and revenue.
---

# VibeMetrics Attribution

Use `get_snapshot` or `export_csv` with `dataset=attribution` to analyze channel attribution.

## Workflow

1. Resolve the project ID with `list_projects` when the user names a project.
2. Query the same period (`7`, `14`, or `30` days) with `model=first` and `model=last` when comparing attribution models.
3. Report conversions, conversions linked to CRM deals, and revenue separately. Revenue is recorded in USD.
4. Explain that `linked` is the count of conversions with an associated deal; it is not an extra conversion count.
5. State missing data explicitly and do not infer a winning channel from an empty or partial period.

## Limits

The current data model does not include campaign spend. Do not calculate or claim CPA from revenue or conversions alone. Ask for spend data or label any calculation as unavailable until spend is integrated.
