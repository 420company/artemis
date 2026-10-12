---
name: optibot
description: Run AI code reviews with Optibot. Use when the user wants to review code changes, compare branches, review diffs, manage Optibot authentication or API keys, or set up CI/CD integration.
allowed-tools: Bash(optibot *), Bash(which optibot), Bash(npm install -g @optimalai/optibot), Bash(npm install @optimalai/optibot), Bash(npx @optimalai/optibot *), Bash(cat ~/.optibot/config.json), Bash(test -f ~/.optibot/config.json *), Bash(echo $OPTIBOT_API_KEY)
---

# Optibot - AI Code Review from the Terminal

Optibot is a CLI tool that sends code changes to an AI reviewer and returns actionable feedback. Your job is to run reviews on the user's behalf, interpret results, and help them act on the feedback.

## Prerequisites

Before running any optibot command, check if it's installed:

```bash
which optibot
```

If not found, install it:

```bash
npm install -g @optimalai/optibot
```

## Authentication

Optibot needs authentication before running reviews. There are two methods:

**Interactive login** (for humans at a terminal):
```bash
optibot login
```
This opens a browser for OAuth. New users will be guided through account setup (creating an organization) before being redirected back. The token is stored in `~/.optibot/config.json` and lasts 90 days.

**API key** (for CI/CD or headless environments):
Set the environment variable:
```bash
export OPTIBOT_API_KEY=optk_...
```

Or create a key through the CLI:
```bash
optibot apikey create "my-key-name"
```

The key is shown once — save it immediately. Keys always start with `optk_`.

### Managing API keys

```bash
optibot apikey list       # See all keys with creation/last-used dates
optibot apikey delete ID  # Revoke a key by its ID
```

## Logout

To remove saved credentials from the local machine:

```bash
optibot logout
```

This deletes the stored token from `~/.optibot/config.json`. After logging out, the user must run `optibot login` or set `OPTIBOT_API_KEY` before running reviews again.

## Checking Auth Status

To check whether the user is currently authenticated, verify the config file:

```bash
test -f ~/.optibot/config.json && cat ~/.optibot/config.json
```

If the file exists and contains a valid `apiKey` or `token` field, the user is authenticated. If the file is missing or empty, they need to log in.

You can also check for the environment variable:

```bash
echo $OPTIBOT_API_KEY
```

If neither the config file nor the environment variable is set, prompt the user to authenticate (see [Authentication](#authentication)).

## Running Reviews

There are three modes. Pick the right one based on what the user wants reviewed.

### 1. Review uncommitted local changes

Best for: "review my changes", "check my code before I commit"

```bash
optibot review
```

This runs `git diff HEAD` and sends all changed files for review.

### 2. Review a branch against its base

Best for: "review my branch", "review before I open a PR", "compare against main"

```bash
optibot review -b              # Auto-detects base branch (main/master/develop)
optibot review -b main         # Explicit base branch
optibot review -b origin/main  # Compare against remote
```

The auto-detection tries `origin/main`, then `origin/master`, then `origin/develop`.

### 3. Review an arbitrary diff file

Best for: "review this patch file", "review this diff"

```bash
optibot review --diff path/to/changes.patch
```

## Interpreting Results

The review output has two sections:

**Review Summary** — A general overview of the changes, patterns noticed, and overall assessment.

**File Comments** — Specific feedback tied to file paths and line numbers. Each comment references the exact file and line range. Use these to navigate directly to the code that needs attention.

**Usage counter** — Shows how many reviews have been used out of the daily limit (e.g., `Reviews used: 3/20 (17 remaining)`).

## After a Review

Once you receive the review results, help the user by:

1. Summarizing the key findings in plain language
2. Offering to fix specific issues the review identified — navigate to the mentioned files/lines and apply the suggested changes
3. If the review found no issues, confirm the code looks good

## Workflow Integration

The most powerful pattern is reviewing before committing or opening a PR:

1. User writes code
2. Run `optibot review` (or `optibot review -b` for branch reviews)
3. Read the feedback, fix issues
4. Commit and push

## Troubleshooting

| Error | Meaning | Fix |
|-------|---------|-----|
| Authentication failed (401) | Token expired or invalid API key | Run `optibot login` or check `OPTIBOT_API_KEY` |
| Review limit reached (429) | Daily quota exhausted | Wait for reset (shown in error) or contact getoptimal.ai |
| No seat assigned (403) | User not assigned in their org | Ask org admin to assign a seat |
| Plan doesn't include reviews (402) | Free/basic plan | Upgrade at getoptimal.ai |
| No changes to review | Empty diff | Make some changes first, or use `-b` to compare branches |
| Not a git repository | Running outside a repo | `cd` into a git project first |

## CI/CD Setup

If the user wants optibot in their CI pipeline, suggest this pattern:

```yaml
# GitHub Actions example
- name: Run Optibot Review
  env:
    OPTIBOT_API_KEY: ${{ secrets.OPTIBOT_API_KEY }}
  run: npx @optimalai/optibot review -b main
```

Key points:
- Use `npx @optimalai/optibot` so it doesn't need a global install
- Always use `-b` in CI to compare the PR branch against the base
- Store the API key as a repository secret, never in code
