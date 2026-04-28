# Contributing to Artemis

Thank you for your interest in contributing.

## Getting Started

1. Fork the repository and clone your fork
2. Install dependencies: `npm install`
3. Run in dev mode: `npm run run`
4. Type-check: `npm run typecheck`

## Development Workflow

- All source is TypeScript in `src/`. Target is ESM (Node ≥ 20).
- The entry point is `src/cli.ts` → `src/cli/runCli.ts`.
- The agent loop lives in `src/core/agent.ts`.
- MCP transport and dependency detection: `src/mcp/client.ts`, `src/mcp/installer.ts`.

Before opening a PR:

```bash
npm run typecheck   # must pass with zero errors
npm run lint        # must pass or have justification
npm run test:all    # run smoke tests
```

## Pull Requests

- Keep PRs focused: one fix or feature per PR
- Include a clear description of what changed and why
- TypeScript strict mode is on — no `any` without comment
- No new dependencies without discussion

## Reporting Bugs

Use the [Bug Report](.github/ISSUE_TEMPLATE/bug_report.md) issue template.

Include:
- Artemis version (`artemis --version`)
- Node.js version (`node --version`)
- OS and shell
- Steps to reproduce
- What you expected vs. what happened
- Relevant error output

## Feature Requests

Use the [Feature Request](.github/ISSUE_TEMPLATE/feature_request.md) issue template.

## Code Style

- ESLint config is in `.eslintrc` — run `npm run lint:fix` to auto-fix
- No trailing comments that describe what the code does; only add comments when the *why* is non-obvious
- Prefer small, focused functions

## License

By contributing, you agree your contributions will be licensed under the MIT License.
