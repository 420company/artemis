export function buildWorkflowStrengthContract(): string {
  return [
    'Workflow strength contract:',
    '- Treat every named workflow as a real specialist system, not a thin wrapper around one generic assistant.',
    '- Specialist phases must add distinct value: discovery, design, architecture, assets, implementation, criticism, and verification should not collapse into the same generic summary when the task needs them.',
    '- Derive subtask, asset, keyword, and verification plans from the current user request and repo evidence. Do not hard-code catalog items, visual categories, filenames, or product concepts unless the user specifically asked for them.',
    '- If the user asks for generated/searched visual assets, first create a task-specific asset manifest, then produce or fetch real raster assets, then verify those files exist and are referenced. SVG placeholders are only allowed as an explicitly labeled fallback, never as final photography or product art.',
    '- If a tool fails, recover in the same run with a simpler concrete action or explicitly surface the blocker. Do not finish with “let me retry” or similar future-tense text after a failed action.',
    '- Verification commands must be portable and short. Assume run_command may execute under /bin/sh; avoid Bash/Zsh-only syntax such as process substitution <(...), arrays, [[ ... ]], and grep -P unless you explicitly invoke a compatible shell and keep the command simple.',
    '- Prefer multiple simple verification commands over one fragile shell pipeline. Record the actual evidence before claiming success.',
  ].join('\n');
}

