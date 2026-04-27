---
description: "Assess pre-commit risk by correlating PagerDuty incidents with current code changes"
argument-hint: "[pagerduty-service-name]"
allowed-tools: ["ToolSearch", "Read", "Glob", "Grep", "Bash", "Write", "AskUserQuestion", "mcp__plugin_pagerduty_pagerduty__get_service", "mcp__plugin_pagerduty_pagerduty__list_services", "mcp__plugin_pagerduty_pagerduty__list_incidents", "mcp__plugin_pagerduty_pagerduty__list_incident_notes", "mcp__plugin_pagerduty_pagerduty__list_service_change_events"]
---

You are performing a pre-commit risk assessment. Follow these steps precisely and in order. Do not skip steps. Do not silently degrade -- if a required tool is unavailable, stop and tell the user.

## Step 0: Pre-flight Checks

Before doing anything else, verify that the required MCP tools are available.

### 0a: Verify PagerDuty MCP

First, call `ToolSearch` with query `"select:mcp__plugin_pagerduty_pagerduty__get_service,mcp__plugin_pagerduty_pagerduty__list_services,mcp__plugin_pagerduty_pagerduty__list_incidents,mcp__plugin_pagerduty_pagerduty__list_incident_notes,mcp__plugin_pagerduty_pagerduty__list_service_change_events"` to load all required PagerDuty tools. If ToolSearch returns no results, STOP immediately (see error below).

Once loaded, call `mcp__plugin_pagerduty_pagerduty__list_services` with query `"test"`. This is a connectivity check.

If ToolSearch returns no PagerDuty tools, or the connectivity call fails, STOP and tell the user:

```
PagerDuty MCP server is not available. This plugin requires it.

To fix:
1. Set the PAGERDUTY_API_KEY environment variable with a valid PagerDuty API token
2. Restart Claude Code so the plugin's MCP server configuration is loaded
3. Re-run /pagerduty:pre-commit-risk-scoring
```

Do NOT proceed without PagerDuty MCP. Do NOT fall back to a degraded assessment. The entire point of this plugin is PagerDuty incident correlation.

### 0b: Verify changes exist

Run `git diff --stat` and `git diff --cached --stat` to check for uncommitted changes (unstaged and staged).

If both are empty, run `git log -1 --oneline` and tell the user:

```
No uncommitted changes detected. The most recent commit is:
<commit hash and message>

/pagerduty:pre-commit-risk-scoring analyzes uncommitted changes. Make some changes first, or if you want to assess the last commit, let me know.
```

Then STOP. Do not proceed to analyze committed history on your own.

## Step 1: Resolve Service Mapping

Determine the PagerDuty service ID for this repository. Follow the steps **in order** and stop at the first one that resolves a service.

### 1a: Use explicit argument (highest priority)

If `$ARGUMENTS` is provided, use it immediately — **do not check the cache or catalog first**.

Call `mcp__plugin_pagerduty_pagerduty__list_services` with `$ARGUMENTS` as the query.
- If exactly one service matches: use it and skip to Step 1d.
- If multiple match: present the options to the user via `AskUserQuestion` and let them pick, then skip to Step 1d.
- If no match: tell the user no service was found for that name, ask them to verify it, and STOP. Do NOT fall through to cache or repo-name detection.

### 1b: Check cached configuration

If no `$ARGUMENTS` was provided, read `.claude/risk-config.json`. If it exists and contains `pagerduty.serviceId`, validate it by calling `mcp__plugin_pagerduty_pagerduty__get_service` with that ID. If the call succeeds, use the service and skip to Step 2 — display the cached service name to the user. If the call fails (service not found or API error), discard the cached config, warn the user, and continue to Step 1c.

### 1c: Check Backstage catalog

If no cached config, check for `catalog-info.yaml` in the repository root. Look for the `pagerduty.com/service-id` annotation under `metadata.annotations`. If found, use that service ID.

Validate it by calling `mcp__plugin_pagerduty_pagerduty__get_service` with the literal service ID (e.g. `PAWX771`). Do NOT pass the ID to `list_services` — querying by raw UUID returns a 502. Extract the service name from the response. If found, skip to Step 1d.

### 1d: Auto-detect from repository name

If none of the above resolved a service:

- Get the repository name from the current directory basename, or parse it from `git remote -v` output.
- Call `mcp__plugin_pagerduty_pagerduty__list_services` with a query matching the repository name.
- If exactly one service matches: use it. Tell the user which service was detected and ask them to confirm.
- If multiple services match: present the options to the user via `AskUserQuestion` and let them pick.
- If no match: use `AskUserQuestion` to ask the user for the PagerDuty service name or ID. Search for it with `mcp__plugin_pagerduty_pagerduty__list_services` to validate and get the canonical service ID.

### 1e: Persist configuration

If the service was resolved via `$ARGUMENTS` (Step 1a), **do not write or update `.claude/risk-config.json`** — the argument is a one-time override, not a permanent mapping.

Otherwise, once a service ID is resolved, write `.claude/risk-config.json`:

```json
{
  "version": "1.0",
  "pagerduty": {
    "serviceId": "<resolved-service-id>",
    "serviceName": "<resolved-service-name>"
  }
}
```

Create the `.claude/` directory first if it does not exist.

## Step 2: Check Ongoing Incidents

Call `mcp__plugin_pagerduty_pagerduty__list_incidents` with:

- `statuses`: `["triggered", "acknowledged"]`
- `service_ids`: `["<serviceId>"]`

For each active incident returned, call `mcp__plugin_pagerduty_pagerduty__list_incident_notes` to get responder context. **Cap at 5 active incidents** — if more are returned, fetch notes only for the 5 most recently triggered and note the total count.

If there are active incidents, report them prominently -- these are the highest-priority risk signal. Use this format:

```
ACTIVE INCIDENTS

[TRIGGERED] INC-12345: Database connection pool exhaustion (P1)
  Triggered 2h ago. Notes: "Scaling up read replicas, ETA 30min"

[ACKNOWLEDGED] INC-12346: Elevated error rate on /api/checkout (P2)
  Acknowledged 45min ago. Notes: "Investigating correlation with deploy at 14:30"
```

If there are no active incidents, note that briefly and continue.

## Step 3: Fetch Recent Incident History

**Start these calls in parallel with Step 2** — they are fully independent. Make the following three calls in parallel with each other:

1. Call `mcp__plugin_pagerduty_pagerduty__list_incidents` for the service over the last 90 days, filtered to **high urgency** (use `since` set to 90 days ago, `until` set to today, and `urgencies: ["high"]`). Include all statuses.

   **Limit handling**: The API caps results at 1000 incidents. If exactly 1000 are returned, the history is partial — note this in the assessment and state the actual date range covered (i.e. the timestamp of the oldest incident returned).

2. Call `mcp__plugin_pagerduty_pagerduty__list_incidents` for the service over the last 90 days, filtered to **low urgency** (same date range, `urgencies: ["low"]`). Include all statuses.

   Apply the same limit handling as above independently for this call.

3. Call `mcp__plugin_pagerduty_pagerduty__list_service_change_events` for the service to get recent change events that PagerDuty has tracked. **Before analyzing**, deduplicate change events by `summary + timestamp` — the API often returns 5–6 identical entries for the same deploy.

For incidents that warrant fetching notes, use the high-urgency list from call 1 directly — no keyword guessing needed. **Cap notes fetching at 10 incidents** (most recent first). If the high-urgency list has more than 10, note how many were skipped.

From the collected data, summarize:
- Total incident count over 90 days: high-urgency count (from call 1) + low-urgency count (from call 2), noting if either is partial due to the 1000-incident cap
- Severity distribution: high-urgency vs low-urgency counts
- Recency of the most recent resolved incident
- Common patterns in incident titles or notes (repeated keywords, affected components)
- Change events (deduplicated) and their timing relative to incidents

## Step 4: Analyze Current Changes and Correlate

**Start Steps 4a and 4b in parallel with Steps 2 and 3** — git commands are local and do not depend on PagerDuty data.

### 4a: Gather current changes

Run the following commands to understand the current diff:
- `git diff --stat` for a summary of changes (unstaged)
- `git diff --cached --stat` for staged changes
- `git diff --name-only` and `git diff --cached --name-only` for the list of changed files
- `git diff` and `git diff --cached` for the full diff content (if the diff is very large, focus on `--stat` and file names)

### 4b: Gather recent commit history

Run `git log --format="%h %s (%an, %ar)" -20` to get the last 20 commits. This provides context on what has been changing recently.

### 4c: Correlate changes with incidents

Analyze the data gathered in Steps 2-4b and look for correlations:

1. **File/directory overlap**: Compare the files and directories in the current diff with areas mentioned in incident notes or titles. Are we touching components that have been involved in recent incidents?

2. **Change event correlation**: Compare PagerDuty change events with the current diff paths. Have previous changes to these same areas preceded incidents?

3. **Structural risk patterns**: Identify high-risk file types in the current diff:
   - Authentication/authorization files (auth, login, session, token, permission)
   - Database migrations (migrate, schema, alembic, flyway)
   - Configuration files (config, settings, env, infrastructure)
   - Dependency files (requirements.txt, package.json, go.mod, Gemfile, build.gradle)
   - API contracts (openapi, swagger, proto, graphql schema)
   - Infrastructure (terraform, cloudformation, kubernetes, helm, dockerfile)

4. **Change magnitude**: Assess the size and spread of changes -- number of files, lines changed, number of distinct directories affected.

5. **Pattern similarity**: Does the current change resemble (in nature, scope, or affected area) changes that preceded past incidents?

## Step 5: Assign Risk Score

Based on all the data gathered, assign a risk score from 0 to 5:

- **0** -- No risk signals at all. Pure documentation, comments, or whitespace.
- **1** -- Trivial changes with no incident correlation. Test cleanup, minor refactors, no structural risk signals.
- **2** -- Some structural signals (config changes, dependency updates) or recent incidents exist, but no correlation with current changes.
- **3** -- Moderate risk. Touching areas related to recent incidents, or high-risk file types (auth, migrations, infra) with no active incidents.
- **4** -- High risk. Active incidents on the service AND changes correlate with incident-affected areas, OR large changes to critical paths with recent incident history.
- **5** -- Critical. Active P1/P2 incident AND current changes directly touch the code involved in the incident.

**Noisy alert adjustment**: Before scoring, check if incident volume is dominated by a single repeating alert title (e.g. 95 out of 100 incidents are "heap-memory-usage"). If so, call that out explicitly in the Risk Factors section and weight those incidents lower than diverse incidents across multiple alert types. The raw incident count alone is misleading in this case.

Build the score bar using filled and empty blocks. For score N, use N filled blocks (█) and (5-N) empty blocks (░):
- 0/5: `░░░░░`
- 1/5: `█░░░░`
- 2/5: `██░░░`
- 3/5: `███░░`
- 4/5: `████░`
- 5/5: `█████`

## Step 6: Present Risk Assessment

Output a compact, structured risk assessment. Be concise -- one line per finding, no filler. Use this format exactly:

```
PRE-COMMIT RISK ASSESSMENT
Service: <service-name> (<service-id>) | Changes: <N> files (+<additions>, -<deletions>)

RISK SCORE: <N>/5 [<LEVEL>] <score-bar>

Active incidents: <"None" or one-line summary per incident>
Incident history (90d): <count> incidents (<"partial: oldest covered is <date>" if capped at 1000>). <one-line summary of severity, recency, patterns>

CHANGE ANALYSIS
- <file-or-group> -- <what changed, one line>
- <file-or-group> -- <what changed, one line>
- Structural risk signals: <"None" or list>
- Incident correlation: <"None" or one-line description of correlation found>

RISK FACTORS
<numbered list, one line each. If none, say "No significant risk factors identified.">

RECOMMENDATION
<one to two sentences. Match the tone to the score level.>
```

Where `<LEVEL>` corresponds to the score:
- 0-1: `LOW`
- 2: `MODERATE`
- 3: `ELEVATED`
- 4: `HIGH`
- 5: `CRITICAL`

Guidelines:
- Be concise. Each bullet should be one line. Do not repeat information across sections.
- Do not pad findings. If incident history is sparse, say so briefly. If there are no correlations, say "None".
- Do not invent risk factors that are not supported by the data gathered.
- If there are active incidents that relate to the areas being changed, this is the most critical finding -- call it out and recommend coordinating with incident responders.
- For scores 0-2, the recommendation can be a single sentence.
- For scores 3+, include specific actionable guidance.