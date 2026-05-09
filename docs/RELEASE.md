# Artemis Release Guide

This is the release path for publishing Artemis to GitHub and npm.

## Current Targets

- GitHub repository: `https://github.com/420company/artemis`
- Default branch: `main`
- npm package: `artemis-code`
- CLI binary: `artemis` from `dist/cli.js`
- Current prepared release: `0.2.35`
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

## Current 0.2.35 Notes

- Dream bridge text now shows human-readable filenames alongside full paths; hero/banner image paths aligned across all outputs.
- Fixed dream local file links and Windows input handling so cross-platform dream workflows resolve correctly.
- Polished dream notifications: improved bridge and notification formatting for cleaner dream delivery across Telegram, Discord, and WeChat.
- Tightened context compression and reset visual policy between generation sessions.
- Refined chat emoji markers and CLI chat labels for lighter, less intrusive output.
- Added startup update check: Artemis alerts when a newer version is available.
- Tool-run interjection: running conversations, agent workflows, and Nidhogg poll for user corrections during model calls; video providers can be cancelled mid-generation.
- Saga identity continuity hardening: dynamic identity inventory for safe turnaround derivatives; strengthened identity preservation; photoreal turnaround anchors for video keyframes; improved Saga reference integrity diagnostics and visual continuity.
- Routed Saga and Seedance workflow text through the explicitly selected UI locale instead of inferring language from prompt contents.
- Super Visual image-edit and segment-keyframe timeout handling so visual-generation stalls fail cleanly.

## 当前 0.2.35 中文说明

- 梦境桥接文本现在同时显示可读文件名和完整路径；hero/banner 图片路径在各输出中保持一致。
- 修正梦境本地文件链接和 Windows 输入处理，跨平台梦境工作流现在正确解析。
- 完善梦境通知：改进桥接和通知格式，在 Telegram、Discord、WeChat 上更清晰地展示梦境内容。
- 收紧上下文压缩；视觉策略重置确保生成会话间状态干净。
- 精炼聊天 emoji 标记和 CLI 聊天标签，输出更轻量、更不突兀。
- 新增启动更新检查：Artemis 启动时检查新版本，有升级可用时提醒用户。
- 工具运行插话：运行中对话、agent 工作流和 Nidhogg 会在模型调用期间轮询用户纠错；视频生成可在中途取消。
- Saga 身份连续性加固：动态身份清单用于安全的三视图衍生；加强身份保留；三视图角色锚定视频关键帧；改进 Saga 参考完整性诊断和视觉连续性。
- Saga 和 Seedance 的界面文案严格使用用户选择的 UI 语言，不再根据 prompt 内容猜测中文或英文。
- Super Visual 的图片编辑和片段关键帧调用增加超时处理，避免视觉生成长期卡住。
