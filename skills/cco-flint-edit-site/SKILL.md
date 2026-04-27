---
name: edit-site
description: Edit a Flint website using a background AI agent. Use when the user wants to modify, update, or add content to their Flint managed website.
---

# Edit a Flint Site

Help the user modify a Flint website by running a background AI agent.

## Workflow

1. **Find the site**: Call `list_sites` to get the user's available sites. If $ARGUMENTS contains a site name, match it. If there are multiple sites and the user didn't specify, ask which one.

2. **Run the agent**: Call `run_background_agent` with the site ID and a prompt describing the changes.
   - Describe goals and intent, not implementation details
   - If the user provided code, examples, or reference material, pass them through as-is
   - Do NOT generate HTML, CSS, or markup — Flint is an expert designer and produces better results with creative freedom

3. **Monitor progress**: Call `check_background_agent_status` to track the agent.
   - Wait 90-120 seconds between status checks
   - A single agent typically finishes in 4-5 minutes
   - Multiple concurrent agents take longer (10 agents may take ~15 minutes)

4. **Report results**: When complete, share the summary of changes and the preview URL.

## Important guidelines

- Flint is an expert web designer. Describe what you want, not how to build it.
- Always honor the user's explicit requests (e.g., "make the header black", "use a three-column grid") — pass that intent through.
- Only use `publish_site` if the user explicitly asks to publish or deploy. It deploys the entire site.
