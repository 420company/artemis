# Artemis Release Guide

This is the release path for publishing Artemis to GitHub and npm.

## Current Targets

- GitHub repository: `https://github.com/420company/artemis`
- Default branch: `main`
- npm package: `artemis-code`
- CLI binary: `artemis` from `dist/cli.js`
- Current prepared release: `0.2.25`
- README hero image: `assets/artemis-github-banner.png`

## Release Principle

Since the `0.1.x` line, Artemis has been used as the working agent for her own upgrades: repository inspection, code edits, type-checking, build verification, documentation updates, release cleanup, and Git publishing. Release notes must therefore describe not only the feature surface, but also the verified local work Artemis performed.

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
- `CONTRIBUTING.md` when workflow expectations change
- `CREDITS.md` when authorship or project history language changes
- GitHub hero/banner asset under `assets/` when changed

The GitHub README hero currently uses:

```text
assets/artemis-github-banner.png
```

## GitHub

Commit the release and tag it:

```bash
git status --short
git add package.json package-lock.json src docs README.md CONTRIBUTING.md CREDITS.md assets/artemis-github-banner.png
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

## Current 0.2.25 Notes

- Improved running correction handling for normal conversations, agent workflows, and Nidhogg by polling for user interjections during model calls and aborting in-flight provider requests when possible.
- Routed Saga and Seedance workflow text through the explicitly selected UI locale instead of inferring language from prompt contents.
- Added a Saga locale smoke test that verifies explicit Chinese and English locale selection always wins.
- Added a 30 second night-beach Saga long-video test script using the provided character turnaround reference.
- Added Super Visual image-edit and segment-keyframe timeout handling so visual-generation stalls fail cleanly.
- Refreshed README, usage documentation, and release notes to remove stale release references.

## 当前 0.2.25 中文说明

- 优化普通对话、agent 工作流和 Nidhogg 的运行中纠错：模型调用期间会轮询用户插话，并在可行时中断当前 provider 请求，用最新指令重跑。
- Saga 和 Seedance 的界面文案严格使用用户选择的 UI 语言，不再根据 prompt 内容猜测中文或英文。
- 新增 Saga locale smoke test，验证显式中文/英文选择始终优先。
- 新增 30 秒夜晚海边 Saga 长视频测试脚本，使用给定三视图角色参考。
- Super Visual 的图片编辑和片段关键帧调用增加超时处理，避免视觉生成长期卡住。
- README、使用说明和发布说明已清理旧版本信息。
