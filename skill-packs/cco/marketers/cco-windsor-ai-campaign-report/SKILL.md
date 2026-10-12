---
name: campaign-report
description: Generate a quick campaign performance report from any connected data source
---

# /campaign-report

Generate a quick campaign performance report from any connected data source.

## Instructions

1. Call `get_connectors` to list the user's connected platforms and accounts.
2. Ask the user which connector and account to report on (or pick the most obvious one if there's only one).
3. Call `get_data` with these fields: `["campaign", "date", "spend", "clicks", "impressions", "conversions", "revenue"]` and `date_preset: "last_30d"`.
4. Format the results as a clean markdown table sorted by spend descending.
5. Include a summary line with totals for spend, clicks, and conversions.

If the connector doesn't support some of those fields, call `get_options` first and adapt to available fields.
