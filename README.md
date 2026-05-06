# Artemis Code

<p align="center">
  <img src="assets/artemis-github-banner.png" alt="Artemis Code GitHub banner" width="100%" />
</p>

<p align="center">
  <strong>AI engineering CLI for real local workspaces, long-running tasks, visual generation, memory, MCP plugins, and mobile bridges.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/artemis-code"><img src="https://img.shields.io/npm/v/artemis-code" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="MIT license" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node >= 20" /></a>
</p>

<p align="center">
  Built by <a href="https://www.420.company">420.COMPANY</a> · npm package <a href="https://www.npmjs.com/package/artemis-code"><code>artemis-code</code></a> · GitHub <a href="https://github.com/420company/artemis"><code>420company/artemis</code></a>
</p>

---

## What is Artemis?

Artemis is a local-first AI engineering agent. It runs inside your real workspace, reads files, edits code, runs commands, validates changes, manages long tasks, generates images and videos, talks through messaging bridges, and keeps local memory across sessions.

It is designed for work that must actually finish: inspect the repository, make the smallest safe change, run the right checks, clean release artifacts, and report only what the tools proved.

Current release: **0.2.12**.

---

## Highlights in 0.2.12

- **Seedance 2.0 Pro multimodal video workflow**: Artemis now detects Seedance 2.0 Pro video intent and guides the user through reference selection before generation.
- **Duration selection before video generation**: users can choose video duration before final confirmation; if skipped, Artemis defaults to 5 seconds.
- **Audio control**: the workflow defaults to no generated audio unless the user explicitly requests audio.
- **Local and URL media references**: CLI can accept local image/video/audio paths and URLs; local video/audio references can be uploaded through the Vidar asset hosting path when configured.
- **Mobile bridge media handling**: Discord attachment URLs can be used as references; Telegram/WeChat binary attachments are handled conservatively when a public URL is required.
- **Video delivery to phones**: generated `.mp4`, `.mov`, `.webm`, and `.m4v` tool outputs are detected and broadcast through active bridge channels when available.
- **False-trigger protection**: questions such as “why did the video not send to my phone?” are treated as system/debug questions, not as a request to start video generation.
- **Vidar Visual naming**: user-facing visual generation language now uses Vidar/Freya-style product naming while retaining internal provider keys for backward-compatible routing.
- **Release hygiene**: local `.artemis` state, bridge sessions, tokens, logs, and runtime files are kept out of Git/npm release artifacts.

---

## Install

Requirements: **Node.js 20+**.

```bash
npm install -g artemis-code
artemis
```

Check the installed version:

```bash
artemis --version
```

Upgrade:

```bash
npm install -g artemis-code@latest
```

---

## Quick start

Open a project and run Artemis:

```bash
cd /path/to/your/project
artemis
```

Useful first commands:

```text
/config          Configure AI providers and defaults
/config visual   Configure image/video generation
/config vision   Configure image understanding
/team            Let Artemis route the task to the right workflow
/heimdall        Show current thread/task status
/soul            Create or edit your personal operating contract
```

Example:

```text
/team inspect the auth module, fix the refresh-token race, and run tests
```

Artemis will inspect files, edit code, run validation, and summarize the result.

---

## Core workflows

Artemis includes named workflows for different engineering styles.

| Command | Purpose | Use it when |
|---|---|---|
| `/team` | Auto-router | You want Artemis to choose the right strategy. |
| `/niko` | Explore → build | The problem needs investigation before implementation. |
| `/design` | Design first | You want an architecture/design plan before code changes. |
| `/athena` | Deep multi-agent research | The task spans many files or subsystems. |
| `/nidhogg` | Background long-running workflow | You want a detached worker to continue while you chat. |
| `/review` | Code review | You want defects, risks, and missing tests found before release. |
| `/heimdall` | Thread visibility | You want to see active tasks, queues, and background workers. |

---

## What Artemis can do

### 1. Real code work

- Read and search project files.
- Edit source with minimal diffs.
- Add tests and documentation.
- Run `typecheck`, `lint`, test suites, build commands, and release checks.
- Preserve workspace context across turns.
- Avoid claiming success unless a tool result proves it.

### 2. Long-running task management

- Continue work in `/nidhogg` detached mode.
- Accept new messages while a task is still running.
- Reconcile new user instructions at safe points.
- Track active threads through Heimdall.

### 3. Provider routing

Artemis supports many model providers and OpenAI-compatible endpoints. It can route main chat, specialist models, vision, visual generation, and fallback models independently.

Common provider families include:

- Anthropic Claude
- OpenAI
- Google Gemini
- DeepSeek
- Qwen / Alibaba-compatible endpoints
- Moonshot Kimi
- Baidu Wenxin
- Zhipu GLM
- xAI Grok
- OpenRouter
- Groq
- Mistral
- Minimax
- Tencent Hunyuan
- iFlytek Spark
- Custom OpenAI-compatible providers

Provider setup lives in local Artemis configuration. Secrets stay local.

### 4. MCP plugins

Artemis ships with a large MCP plugin catalog. MCP servers can be enabled for cloud, data, collaboration, observability, design/frontend, business, source-control, and security workflows.

Typical uses:

```text
/mcp list
/mcp enable <server-id>
/mcp disable <server-id>
```

When an external service needs credentials, Artemis tells you which config entry is missing instead of pretending the service worked.

### 5. Skills

Artemis includes a large skill library for recurring engineering tasks: framework-specific development, code review, test strategy, plugin development, research workflows, documentation, and more.

Skills are applied automatically when a task matches their domain.

### 6. Memory

Artemis stores local working memory under `~/.artemis/`.

Main memory features:

```text
/wordup          Save a named session snapshot
/wordupnow       Save immediately
artemis resume --last
artemis resume <sessionId>
/soul            Create or edit ~/.artemis/soul.md
```

The soul file is your personal operating contract: tone, preferences, constraints, and how Artemis should work with you.

### 7. Dream system

Artemis can create local dream diaries from recent activity. Dreams are stored under:

```text
~/.artemis/dreams/
```

Dreams may include Markdown, images, and videos. The dream system is used as a memory and reflection layer, not as a remote telemetry service.

### 8. Visual generation with Freya / Vidar

Artemis can generate images and videos from the same agent workflow used for code.

Configure visual generation:

```text
/config visual
/config vision
```

Image capabilities:

- Generate banners, hero images, product/editorial assets, illustrations, and visual concepts.
- Save images to local workspace or configured output paths.
- Use vision models to understand user-provided images.

Video capabilities:

- Text-to-video generation through configured video providers.
- Seedance 1.5-style standard video generation.
- Seedance 2.0 Pro multimodal generation via Vidar Visual configuration.
- Reference image/video/audio URL support.
- Local reference path support when asset hosting/upload is available.
- Duration normalization according to model limits.
- Optional generated audio when supported and explicitly requested.

Example direct tool-style request:

```text
Generate a 9-second cinematic product video, 16:9, no audio, using this reference image URL: https://example.com/ref.png
```

Seedance 2.0 Pro workflow behavior:

1. User asks for a video.
2. Artemis detects the configured Seedance 2.0 Pro model.
3. Artemis asks whether to use the latest dream source or add multimodal references.
4. User can send image/video/audio URLs or local paths.
5. Artemis asks for duration before final generation.
6. If the user skips duration, Artemis uses 5 seconds and no audio.
7. On completion, generated video files can be pushed back through active messaging bridges.

### 9. Messaging bridge: Bragi

Bragi lets Artemis receive and reply through messaging platforms while still operating in the local workspace.

Supported bridge surfaces in this repository include:

- Discord
- Telegram
- WeChat / iLink-style gateway
- Local bridge notifier services

Bridge capabilities:

- Receive mobile messages and route them into Artemis.
- Send progress updates back to chat.
- Send generated images and videos back to active bridge targets.
- Handle direct requests such as latest dream image/video delivery.
- Avoid consuming fragile one-turn media tokens before sending actual WeChat media.

### 10. Spotify and ambient tools

When configured, Artemis can control Spotify and provide ambient assistant utilities such as weather, calendar, reminders, time zones, currency conversion, and flight lookup. These are only triggered when the user clearly asks for that domain.

### 11. Browser automation

Artemis can use a visible Chromium browser for sites that require JavaScript, login state, or interaction. It can navigate, click, type, wait for selectors, extract text, and take screenshots.

### 12. Safety and permissions

Artemis uses permission modes and sensitive-path checks to avoid unsafe writes and accidental secret exposure.

Release hygiene includes:

- Excluding `.env`, `.npmrc`, logs, local `.artemis` state, and private runtime files from npm packages.
- Keeping API keys local.
- Avoiding secret values in logs and summaries.
- Treating bridge media and generated assets carefully.

---

## Configuration

Run the setup wizard:

```bash
artemis config --setup
```

Or use interactive commands:

```text
/config
/config visual
/config vision
```

Typical config areas:

- Main chat provider and model.
- Specialist/fallback providers.
- Visual image provider.
- Visual video provider.
- Vision model.
- MCP servers.
- Bridge settings.
- Local memory behavior.

Secrets are stored locally according to the configured provider store and platform capabilities.

---

## Common usage examples

### Fix a bug

```text
/team find why login sessions expire early, patch it, and run the relevant tests
```

### Review current changes

```text
/review my current git diff for release blockers
```

### Generate an image

```text
Create a GitHub README hero banner for this project, cinematic but clean, no readable secrets
```

### Generate a Seedance 2.0 Pro video

```text
Generate a cinematic 9-second dream video using the latest dream as reference. No audio.
```

### Send latest dream video to phone

```text
发我最新梦境视频
```

### Continue in background

```text
/nidhogg refactor the visual provider layer and keep validating until tests pass
```

---

## Development

Clone and install:

```bash
git clone https://github.com/420company/artemis.git
cd artemis
npm install
```

Run checks:

```bash
npm run typecheck
npm run lint
npm run test:runtime
npm run build
```

Full release check:

```bash
npm run release:check
```

Package dry run:

```bash
npm pack --dry-run
```

---

## Release notes for maintainers

Before publishing:

1. Review `git status --short` and `git diff`.
2. Run typecheck, lint, runtime tests, and build.
3. Remove local `.artemis`, logs, `.env`, `.npmrc`, temporary scripts, and generated private assets.
4. Update `package.json`, `package-lock.json`, README, and docs.
5. Run `npm pack --dry-run` and inspect included files.
6. Commit, tag, push, and publish.

---

## 中文说明

Artemis Code 是一个面向真实本地工作区的 AI 工程 CLI。它可以读写代码、运行命令、修复问题、做代码审查、运行测试、生成图片和视频、连接手机消息桥、管理长期任务，并把记忆保存在本机。

核心能力：

- 工程任务：检查仓库、修改代码、运行验证、整理发布。
- 多工作流：`/team`、`/niko`、`/design`、`/athena`、`/nidhogg`、`/review`。
- 记忆系统：`/wordup`、`/soul`、梦境日记。
- 视觉系统：Freya / Vidar 图片与视频生成，支持 Seedance 2.0 Pro 多模态视频流程。
- 手机桥接：Discord、Telegram、WeChat 等入口可把消息送进本地 Artemis，并接收生成的图片/视频。
- MCP 插件：内置大量 MCP 服务配置，可按需启用。
- 安全边界：本地密钥、本地状态、临时文件和隐私数据默认不进入 Git/npm 发布包。

安装：

```bash
npm install -g artemis-code
artemis
```

配置：

```text
/config
/config visual
/config vision
```

常用：

```text
/team 修复这个模块的问题并运行测试
/review 检查当前改动有没有发布风险
/nidhogg 后台继续完成这个重构
发我最新梦境视频
```

---

## License

MIT. See [LICENSE](LICENSE).
