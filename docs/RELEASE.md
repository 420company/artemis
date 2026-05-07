# Artemis Release Guide

This is the release path for publishing Artemis to GitHub and npm.

## Current Targets

- GitHub repository: `https://github.com/420company/artemis`
- Default branch: `main`
- npm package: `artemis-code`
- CLI binary: `artemis` from `dist/cli.js`
- Current prepared release: `0.2.12`
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

## Current 0.2.12 Notes

- Added and refined the Seedance 2.0 Pro multimodal video workflow with latest-dream source selection and reference collection.
- Added duration confirmation before final video generation.
- Added explicit generated-audio control for supported models.
- Fixed a bridge-runtime false trigger where a duration reply such as `10秒` could be misread as a request to send the previous latest dream video.
- Replaced hard-coded dream-video output naming with dream-aware naming so generated videos do not overwrite a fixed `lastdreamseedance.mp4` path.
- Ensured dream-video workflows send the exact newly generated file path when available.
- Verified Telegram and Discord original MP4 delivery.
- Stabilized WeChat video delivery through compressed video-card variants and fallback ordering.
- Removed WeChat original MP4 file follow-up because the WeChat CDN rejected that file channel for original videos.
- Added WeChat stale context-token recovery so invalid cached tokens are cleared instead of poisoning future sends.
- Separated WeChat media-type handling for video and file delivery.
- Updated README, usage documentation, release guide, credits language, and GitHub presentation assets.

## 当前 0.2.12 中文说明

- 新增并完善 Seedance 2.0 Pro 多模态视频流程，支持选择最新梦境与收集参考素材。
- 在最终生成前确认视频时长。
- 对支持的模型提供显式音频生成控制。
- 修复手机桥接中 `10秒` 等时长回复被误判为“发送旧梦境视频”的问题。
- 移除梦境视频硬编码命名，避免固定 `lastdreamseedance.mp4` 覆盖旧产物。
- 工作流在生成后优先发送精确的新视频路径。
- 已验证 Telegram 和 Discord 可发送原始 MP4。
- WeChat 使用压缩视频卡片与降级档位保证稳定送达。
- 因 WeChat CDN 拒绝原始 MP4 文件通道，已取消原始文件追加发送。
- WeChat 过期 context token 会自动清理，避免缓存污染后续发送。
- WeChat 视频与文件 mediaType 已分离处理。
- README、使用说明、发布指南、署名说明和 GitHub 展示资产已同步更新。
