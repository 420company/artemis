# Artemis Release Guide

This is the release path for publishing Artemis to GitHub and npm.

## Current Targets

- GitHub repository: `https://github.com/420company/artemis`
- Default branch: `main`
- npm package: `artemis-code`
- CLI binary: `artemis` from `dist/cli.js`
- Current prepared release: `0.2.12`
- README hero image: `assets/artemis-github-banner.png`

## Preflight

Before building, confirm local runtime data is not tracked or packed. User data directories may contain API keys, bot tokens, browser state, bridge locks, MCP enablement state, and session data.

```bash
git ls-files .artemis .mylaude
find . -maxdepth 4 \( -name '.env' -o -name '.env.*' -o -name '.npmrc' -o -name '*.log' -o -name '.artemis' \) -not -path './node_modules/*' -print
npm pack --dry-run --json
```

The first command must print nothing. The `find` command must not show workspace-local secrets or runtime state. The pack output must not contain workspace-local `.artemis/`, `.mylaude/`, `.env`, `.npmrc`, cookies, lock files, or token-bearing config. It is expected to include only safe default catalogs such as `defaults/mcp-servers.json`.

Run the full local release check:

```bash
npm run release:check
```

This runs typecheck, lint, all smoke tests, build, and `npm pack --dry-run`. Do not publish if this command fails.

For fast local validation during development, run at least:

```bash
npm run typecheck
npm run lint
npm run test:runtime
npm run build
```

## Version

Update `package.json` and `package-lock.json` together:

```bash
npm version patch --no-git-tag-version
```

Use `minor` or `major` instead of `patch` when the release warrants it.

## Documentation

Before publishing, update:

- `README.md`
- `docs/USAGE.md`
- `docs/RELEASE.md`
- Any versioned feature docs under `docs/`
- GitHub hero/banner asset under `assets/` when changed

The GitHub README hero currently uses:

```text
assets/artemis-github-banner.png
```

## GitHub

Commit the release and tag it:

```bash
git status --short
git add package.json package-lock.json src docs README.md assets/artemis-github-banner.png
git commit -m "Release x.y.z"
git tag vx.y.z
npm run release:git
```

Confirm CI passes on GitHub before publishing to npm.

## npm

Confirm the npm identity and target version:

```bash
npm whoami
npm view artemis-code version
```

Publish:

```bash
npm run release:npm
```

Verify the registry:

```bash
npm view artemis-code version dist-tags bin
```

## Post-Publish Smoke Test

Install the published package in a clean shell:

```bash
npm install -g artemis-code@latest
artemis --version
artemis --help
```

The reported version should match the Git tag and npm version.

## 0.2.12 Release Notes Draft

- Added Seedance 2.0 Pro multimodal video workflow with reference collection.
- Added duration selection before final video generation; skipped duration defaults to 5 seconds.
- Defaulted Seedance workflow audio to off unless explicitly requested.
- Added local media path handling and Vidar asset hosting path for reference assets.
- Added generated video output detection and bridge broadcast for `.mp4`, `.mov`, `.webm`, and `.m4v` files.
- Hardened bridge false-trigger handling so video delivery/debug questions do not start a new generation workflow.
- Updated GitHub README with the `assets/artemis-github-banner.png` hero banner and current feature documentation.
