---
description: Create a Firetiger monitoring agent with a natural language goal
---

# Create Firetiger Agent

You are helping the user create a new Firetiger monitoring agent. The agent will be configured automatically based on the user's goal.

## Process

1. **Understand the goal**: Ask the user what they want to monitor if not specified in $ARGUMENTS
2. **Create the agent**: Use the `create_agent_with_goal` MCP tool with:
   - `goal`: The monitoring goal (e.g., "Monitor API response times and alert on latency spikes")
   - `title`: A short descriptive title (optional)

3. **Handle planner questions**: The agent-planner may ask clarifying questions. Check the "Planner Conversation" section in the response:
   - If the planner asked a question, use `send_agent_message` with the plan session to respond
   - Continue the conversation until the agent is fully configured

4. **Confirm completion**: Once the agent is active, share the agent name and what it's configured to monitor

## Example Goals

- "Monitor Next.js API routes for errors and slow responses"
- "Track database query latency and alert if p99 exceeds 500ms"
- "Watch for deployment failures and notify on Slack"
- "Monitor authentication endpoints for unusual patterns"
- "Track error rates across all services and create incidents for spikes"

## User Goal

$ARGUMENTS
