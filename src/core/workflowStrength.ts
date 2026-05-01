export function buildWorkflowStrengthContract(): string {
  return [
    'Workflow strength contract:',
    '- Treat every named workflow as a real specialist system, not a thin wrapper around one generic assistant.',
    '- Treat repository-local instructions, docs, tests, schemas, and existing code as the system of record. Keep the injected guidance short; load deeper docs only when the task needs them.',
    '- Build a task harness before claiming completion: identify the relevant static checks, focused tests, runtime smoke paths, logs/metrics, or visual evidence that would actually detect failure.',
    '- Specialist phases must add distinct value: discovery, design, architecture, assets, implementation, criticism, and verification should not collapse into the same generic summary when the task needs them.',
    '- Derive subtask, asset, keyword, and verification plans from the current user request and repo evidence. Do not hard-code catalog items, visual categories, filenames, or product concepts unless the user specifically asked for them.',
    '- Use deterministic controls where available: existing scripts, test commands, lint rules, permission limits, read-only review, and architecture checks beat advisory prose.',
    '- Do not invent products, metrics, command names, install URLs, versions, social links, or company facts. If the repository/user did not provide them, label them as placeholders, omit them, or ask for the missing source of truth.',
    '- If the user asks for generated/searched visual assets, first create a task-specific asset manifest, then produce or fetch real raster assets, then verify those files exist and are referenced. SVG placeholders are only allowed as an explicitly labeled fallback, never as final photography or product art.',
    '- HARD RULE for image generation: when a visual asset is needed and a generate_image tool is available in this session, you MUST call generate_image directly. You are FORBIDDEN from writing custom scripts (generate-assets.js, .py, shell, node) that emit SVG, canvas drawings, or procedural geometry as a substitute. Writing such scripts is a violation. The only acceptable substitute when generate_image is unavailable is web-search via the visual-asset policy explicitly stated in the user message.',
    '- For product photography, editorial imagery, hero images, lookbooks, lifestyle shots, or anything described with photographic terms (lens, lighting, model, pose, fabric, studio, shot), generate_image is required when configured. Do not silently fall back to SVG/CSS art without informing the user that real generation failed.',
    '- For frontend/web/UI work, HTTP 200, file existence, and "server started" are not visual verification. Capture or otherwise inspect desktop and mobile render evidence; if browser/screenshot verification fails, report it as incomplete instead of claiming full validation.',
    '- If a tool fails, recover in the same run with a simpler concrete action or explicitly surface the blocker. Do not finish with “let me retry” or similar future-tense text after a failed action.',
    '- Verification commands must be portable and short. Assume run_command may execute under /bin/sh; avoid Bash/Zsh-only syntax such as process substitution <(...), arrays, [[ ... ]], and grep -P unless you explicitly invoke a compatible shell and keep the command simple.',
    '- run_command has a 120-second hard timeout. For any long-running process (HTTP server, file watcher, background script), use `nohup <cmd> >/tmp/<name>.log 2>&1 & echo $!` to detach AND record the PID, then immediately verify with `sleep 1 && curl -sS http://127.0.0.1:<port>/ -o /dev/null && echo SERVED` (or equivalent). Do NOT start a server without `&`; it will block until the timeout and the PID will be lost.',
    '- If a previous server start command already timed out, try a different port (the previous port may still be held by an orphaned process) and use `lsof -i :<port>` to verify before retrying the same port.',
    '- Prefer multiple simple verification commands over one fragile shell pipeline. Record the actual evidence before claiming success.',
    '- If the work exposes stale docs, dead workflow paths, or obsolete instructions, either update the local source of truth or report the exact cleanup that remains.',
  ].join('\n');
}
