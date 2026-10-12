# Firetiger Context

You have access to Firetiger, an AI-powered observability platform, through MCP tools.

## Available Tools

### Billing & Subscription
- `get_subscription_status` - Check if the user has an active Firetiger subscription
- `get_checkout_url` - Get a Stripe checkout URL to subscribe (user enters credit card in browser)

### Credentials
- `get_ingest_credentials` - Get OTLP endpoint and auth for sending telemetry

### Agent Management
- `create_agent_with_goal` - Create a monitoring agent with a natural language goal
- `create` (collection: agents) - Create an agent with specific configuration
- `list` (collection: agents) - List existing agents
- `get` (collection: agents) - Get agent details
- `update` (collection: agents) - Update agent configuration
- `delete` (collection: agents) - Delete an agent

### Sessions
- `send_agent_message` - Send a message to an agent session
- `read_agent_messages` - Read messages from an agent session

### Query
- `query` - Run SQL queries against telemetry data

### Resources
- `list` / `get` / `create` / `update` / `delete` - CRUD operations for:
  - `agents` - Monitoring agents
  - `known-issues` - Issue tracking
  - `connections` - Database/service connections
  - `runbooks` - Automated runbooks
  - `triggers` - Agent triggers

## Firetiger Concepts

### Agents
Firetiger agents are autonomous AI that monitor your application. They:
- Analyze logs, traces, and metrics
- Detect anomalies and patterns
- Investigate issues automatically
- Can take actions via connections (Slack, GitHub, etc.)

### Sessions
Each agent run creates a session that tracks the agent's reasoning and actions.

### Connections
Integrations with external services:
- **Databases**: Query production data for investigation
- **Slack**: Send alerts and updates
- **GitHub**: Create issues, comment on PRs
- **Linear**: Create and manage tickets

### Known Issues
Pattern-matched issues that have been identified. Helps deduplicate alerts.

## Common Workflows

### Setup Monitoring
1. Use `/firetiger:setup` to add instrumentation
2. Deploy the application
3. Telemetry automatically flows to Firetiger
4. Agent monitors and investigates issues

### Create a Custom Agent
```
Use create_agent_with_goal with:
- goal: "Monitor API latency and alert when p95 exceeds 500ms"
```

### Query Telemetry
```
Use the query tool:
- query: "SELECT * FROM logs WHERE severity = 'ERROR' ORDER BY timestamp DESC LIMIT 10"
```

### Investigate an Issue
1. Read agent session to see what the agent found
2. Use query tool to explore the data further
3. Check known issues for similar patterns
