---
name: setup-zoom-mcp
description: Decide when Zoom MCP is the right fit and produce a safe setup plan for Claude. Use when planning AI workflows over Zoom data, deciding between MCP and REST, or defining a hybrid MCP architecture.
argument-hint: "<AI workflow or MCP use case>"
---

# /setup-zoom-mcp

> If you see unfamiliar placeholders or need to check which tools are connected, see [CONNECTORS.md](../../CONNECTORS.md).

Plan a Zoom MCP workflow and decide when to use MCP alone versus a hybrid REST API + MCP architecture.

## Usage

```text
/setup-zoom-mcp $ARGUMENTS
```

## Workflow

1. Determine whether the goal is deterministic automation, AI tool orchestration, or a hybrid.
2. If MCP is appropriate, identify the likely Zoom MCP surface and transport assumptions.
3. If MCP alone is not enough, define the REST API responsibilities separately.
4. Call out auth, scope, and client capability constraints, especially the difference between Claude Cowork and Claude Code auth paths.
5. End with a minimal proof-of-concept sequence.

## Output

- Recommended MCP strategy
- Connector expectations
- Hybrid boundaries if REST is also required
- Risks and setup notes
- Relevant skill links

## Auth Rules

- **Claude Cowork**: use the published Zoom connector and complete OAuth in Claude's connector flow.
- **Claude Code**: manually complete Zoom user-level OAuth, export `ZOOM_MCP_ACCESS_TOKEN`, reconnect the plugin, then continue with this skill.
- Scope requirements differ by MCP server. Use the server-specific scope sets below and the detailed tables in [../zoom-mcp/concepts/oauth-setup.md](../zoom-mcp/concepts/oauth-setup.md).

## Server-Specific Scope Sets

Main Zoom MCP server: `https://mcp.zoom.us/mcp/zoom/streamable`
- `ai_companion:read:search`
- `meeting:read:search`
- `meeting:read:assets`
- `cloud_recording:read:list_user_recordings`
- `cloud_recording:read:content`
- `docs:write:import`
- `docs:read:export`

Zoom Docs MCP server: `https://mcp.zoom.us/mcp/docs/streamable`
- `create_file_with_content` → `docs:write:import`
- `get_file_content` → `docs:read:export`

Zoom Whiteboard MCP server: `https://mcp.zoom.us/mcp/whiteboard/streamable`
- `add_a_whiteboard_collaborator` → `whiteboard:write:collaborator:admin`
- `create_a_whiteboard` → `whiteboard:write:whiteboard`
- `create_a_whiteboard_by_script` → `whiteboard:write:whiteboard`
- `create_a_whiteboard_for_brainstorming` → `whiteboard:write:whiteboard`
- `create_a_whiteboard_for_meeting_summary` → `whiteboard:write:whiteboard`
- `create_a_whiteboard_for_strategy_analysis` → `whiteboard:write:whiteboard`
- `delete_a_whiteboard_collaborator` → `whiteboard:delete:collaborator:admin`
- `get_a_whiteboard` → `whiteboard:read:whiteboard:admin`
- `get_a_whiteboard_collaborator` → `whiteboard:read:list_collaborators:admin`
- `list_whiteboards` → `whiteboard:read:list_whiteboards:admin`
- `update_a_whiteboard_collaborator` → `whiteboard:update:collaborator:admin`

## Related Skills

- [design-mcp-workflow](../design-mcp-workflow/SKILL.md)
- [choose-zoom-approach](../choose-zoom-approach/SKILL.md)
