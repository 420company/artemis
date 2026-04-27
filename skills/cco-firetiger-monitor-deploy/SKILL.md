---
description: Set up deployment monitoring for a PR
---

# Monitor Deployment

You are helping the user set up deployment monitoring for their PR.

## How Deploy Monitoring Works

Firetiger monitors deployments through GitHub integration. Once set up, users simply comment `@firetiger` on any PR to enable monitoring.

When a PR with monitoring is merged and deployed:
- Firetiger develops a targeted monitoring plan based on the PR changes
- Checks run at 10 minutes, 30 minutes, 1 hour, 2 hours, 24 hours, and 72 hours
- Issues are reported directly on the PR and as Known Issues in Firetiger

## Process

1. **Check GitHub connection**: Use the `list` MCP tool to check for existing GitHub connections:
   ```
   list connections with filter: connection_type = "GITHUB"
   ```

2. **If no GitHub connection**: Set it up first:
   - Use `onboard_github` MCP tool to start the OAuth flow
   - Wait for the user to complete authorization, then continue

3. **Identify the PR**:
   - If the user specified a PR number or URL in $ARGUMENTS, use that
   - Otherwise, check for a PR on the current branch: `gh pr view --json number,title,url`
   - If no PR exists, ask the user which PR to monitor

4. **Gather monitoring context**:
   - Read the PR diff to understand what changed: `gh pr diff`
   - Ask the user if they have specific things they want monitored, or suggest focus areas based on the changes

5. **Post the @firetiger comment**: Use the gh CLI:
   ```bash
   gh pr comment <PR_NUMBER> --body "@firetiger <monitoring context>"
   ```

6. **Confirm**: Let the user know the comment was posted. Firetiger will:
   - Respond with an eyes emoji to confirm receipt
   - Develop a monitoring plan and post it as a PR comment
   - After merge and deploy, run automated checks at 10min, 30min, 1h, 2h, 24h, 72h

## Example Comments

Simple:
```
@firetiger
```

With context:
```
@firetiger please monitor this deployment - this changes the payment flow, watch for any errors or latency spikes in checkout
```

Specific focus:
```
@firetiger monitor for:
- Error rate increases in /api/orders
- Latency regression in database queries
- Any 5xx responses from the new endpoint
```

## User Request

$ARGUMENTS
