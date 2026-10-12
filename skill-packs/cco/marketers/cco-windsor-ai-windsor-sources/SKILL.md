---
name: windsor-sources
description: Show all connected data sources and what data is available from each
---

# /windsor-sources

Show all connected data sources and what data is available from each.

## Instructions

1. Call `get_connectors` to list all connected platforms.
2. For each connector that has accounts, call `get_options` to get the available fields.
3. Present a concise summary showing:
   - Platform name and account(s)
   - Number of available fields grouped by type (dimensions vs metrics)
   - A few example fields from each group
4. Keep it scannable — the user wants a quick overview, not a wall of text.
