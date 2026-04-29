# Artemis — AI Engineering CLI

> Built by [420.COMPANY](https://www.420.company) · [npm](https://www.npmjs.com/package/artemis-code) · [GitHub](https://github.com/420company/artemis)

[![npm version](https://img.shields.io/npm/v/artemis-code)](https://www.npmjs.com/package/artemis-code)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node ≥ 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

Artemis is a full-featured AI engineering CLI built for people who take their workflow seriously. Thirty-plus AI providers. Ninety pre-bundled MCP plugins. Nine hundred and ninety-nine specialized skills. A dual-model brain architecture. A live messaging bridge. And a Spotify integration so your workspace arrives ready — the moment you do.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Installation](#installation)
- [Core Workflows](#core-workflows)
- [Heimdall — Thread Visibility](#heimdall--thread-visibility)
- [Bifrost — Dual-Model Architecture](#bifrost--dual-model-architecture)
- [MCP Plugins](#mcp-plugins)
- [999 Skills](#999-skills)
- [Messaging Bridge (Bragi)](#messaging-bridge-bragi)
- [Spotify Integration](#spotify-integration)
- [Memory System](#memory-system)
- [Visual Generation (Freya)](#visual-generation-freya)
- [Agent Profiles](#agent-profiles)
- [Odin Skill Evolution](#odin-skill-evolution)
- [Supported AI Providers](#supported-ai-providers)
- [All Commands Reference](#all-commands-reference)
- [Permission Modes](#permission-modes)
- [Configuration](#configuration)
- [Development](#development)
- [License](#license)
- [中文说明](#中文说明)

---

## Quick Start

```bash
npm install -g artemis-code
artemis
```

The CLI guides you through provider setup on first run. Everything else is optional — add what you need, when you need it.

---

## Installation

**Requirements**: Node.js ≥ 20

```bash
npm install -g artemis-code
```

MCP server dependencies are installed on first use, not at install time. Your `npm install -g` completes in seconds.

---

## Core Workflows

Artemis ships six named workflows, each a distinct strategy for turning a task description into working code.

### `/team` — Auto-Router *(recommended starting point)*

Tell Artemis what you need. It analyzes your intent and dispatches to the most appropriate workflow automatically. No need to know which mode to pick.

```
/team refactor the payment module to support idempotent transactions
```

---

### `/niko` — Explore → Build

A two-phase approach: first explore the problem space, gather evidence, and map the unknowns — then build from a position of certainty. Ideal when the best path forward isn't obvious up front.

```
/niko add multi-tenant support to the auth layer
```

**Phase 1:** Research. Reads codebase, identifies dependencies, considers edge cases.  
**Phase 2:** Execution. Builds from findings, not assumptions.

---

### `/design` — Design First

Produces a full architecture document — data models, interfaces, component breakdown, migration strategy — before a single line of code is written. You review and approve the design. Then Artemis builds it.

```
/design redesign the notification system to be event-driven
```

Best for features where a poor early decision compounds into months of technical debt.

---

### `/athena` — Deep Research + Coordinated Multi-Agent Execution

Deploys multiple independent sub-agents in parallel to research the codebase, then synthesizes findings into a unified execution plan. Built for tasks that span many files, modules, or concerns simultaneously.

```
/athena audit all authentication flows for OWASP Top 10 vulnerabilities
```

**Roles deployed:** `planner`, `researcher` (parallel), `builder`, `reviewer`

---

### `/nidhogg` — Adversarial Hardening

Implements a solution, then turns an adversarial critic loose on it. The critic identifies weaknesses, edge cases, and failure modes. Artemis fixes them. Repeat until the solution holds under pressure.

```
/nidhogg implement the withdrawal transaction handler
```

The slowest workflow. The most robust output. Use it when correctness is not negotiable.

---

### `/contest` — Path Debate & Selection

Generates multiple competing approaches to the same problem, debates their trade-offs explicitly, selects the winner, and implements it. Useful when several architecturally distinct solutions are all plausible.

```
/contest choose between event sourcing and CQRS for our order history feature
```

---

## Heimdall — Thread Visibility

`/heimdall` gives you real-time visibility into the agent's execution state: what it's doing, what it's waiting for, and what it needs from you.

```bash
/heimdall              # current thread status
/heimdall threads      # list all active threads
/heimdall events       # recent event log
/heimdall follow       # live-stream events in real time
/heimdall upload <file> # pass files into an active thread
/heimdall approve      # unblock a pending approval gate
/heimdall reply <text> # respond to an agent clarification request
```

When a long-running task pauses for approval or input, `/heimdall` is how you interact with it without restarting.

---

## Bifrost — Dual-Model Architecture

Most tasks don't need the same model for planning and execution. Bifrost lets you configure two providers independently: one for reasoning, one for speed.

```bash
/bifrost   # open dual-model configuration
/mind      # swap active Forge ↔ Raven assignment
```

**Brain model (Raven):** High-capability reasoning model — used for planning, analysis, adversarial critique. Think Claude Opus, GPT-4o, DeepSeek-R1.

**Execution model (Forge):** Fast, code-focused model — handles tool calls, edits, and generation. Think Claude Haiku, GPT-4o Mini, DeepSeek-Coder.

The result: reasoning quality of a large model, with the latency and cost profile of a small one.

---

## MCP Plugins

Ninety MCP servers ship with Artemis, pre-configured and ready to enable. Zero manual setup for HTTP-based servers — they connect on first use.

```bash
/mcp list              # browse all 90 servers
/mcp enable <id>       # enable a server
/mcp probe <id>        # test connectivity
/mcp add <command>     # add a custom server
/mcp doctor            # diagnose MCP configuration
```

**Highlights:**

| Server | Service | What it unlocks |
|--------|---------|-----------------|
| `cco-github-github` | GitHub | Repos, PRs, Issues, Actions |
| `cco-vercel-vercel` | Vercel | Deploy, logs, domains |
| `cco-prisma-prisma-local` | Prisma | Schema management, migrations |
| `cco-notion-notion` | Notion | Databases, documents |
| `cco-slack-slack` | Slack | Channels, messages, users |
| `cco-figma-figma` | Figma | Design file access |
| `cco-atlassian-atlassian` | Jira / Confluence | Projects, tickets, docs |
| `cco-postman-postman` | Postman | API collections, test runs |
| `cco-shopify-shopify-mcp` | Shopify | eCommerce operations |
| `cco-aikido-aikido-mcp` | Aikido Security | Vulnerability scanning |
| `cco-aws-serverless-aws-serverless-mcp` | AWS SAM | Serverless deployment |
| `cco-azure-azure` | Azure | Resource management |
| `cco-sourcegraph-sourcegraph` | Sourcegraph | Deep codebase search |

Transport types: 53 streamable HTTP (zero setup), 22 npm/npx, 9 Python/uvx, 4 binary.

---

## 999 Skills

Skills are structured knowledge units — pre-built patterns for recurring engineering tasks. Artemis applies them automatically when a task matches.

```bash
/skills          # browse the full skill library
/odin list       # inspect learned skills
/odin search <keywords>  # find skills by topic
```

The **Odin layer** evolves your skill library over time: after complex multi-step operations, Artemis can capture a new skill from what it just learned — so the next time the same pattern appears, it's faster and more precise.

---

## Messaging Bridge (Bragi)

Send tasks from Telegram, Discord, or WeChat. Artemis executes them on your machine with the same tool access as the terminal — and streams results back to your phone.

```bash
/bragi                       # control plane overview
/bragi telegram setup        # configure Telegram bot
/bragi discord setup         # configure Discord bot
/bragi wechat setup          # configure WeChat gateway
```

The bridge inherits your active permission mode. Set `/accept-all` and your phone becomes a remote execution terminal.

---

## Spotify Integration

Artemis connects to Spotify so your workspace comes alive the moment you sit down. Search and play music, control playback, switch devices — all without leaving the terminal or your messaging app.

**Available tools:**

```
spotify_play_liked       Play your Liked Songs (with optional shuffle)
spotify_search_and_play  Find and play any track or playlist
spotify_play_playlist    Play a named playlist from your library
spotify_resume / pause   Playback control
spotify_skip_next/prev   Track navigation
spotify_set_volume       Volume control (0–100)
spotify_now_playing      Show currently playing track
spotify_set_device       Transfer playback to any device
```

**Via messaging bridge:** You can control Spotify directly from Telegram, Discord, or WeChat — ask Artemis to play something and it happens on your machine, wherever you are.

If no active device is found, Artemis automatically wakes the local Spotify app and retries.

---

## Memory System

### WordUP — Session Snapshots

Artemis saves compressed memory of your conversation context at key moments. Close the terminal, reopen later, and pick up exactly where you left off.

```bash
/wordup          # save a named snapshot
/wordupnow       # force-save immediately
artemis resume --last       # restore most recent snapshot
artemis resume <sessionId>  # restore specific snapshot
```

### Soul File

`~/.artemis/soul.md` — Write your preferences here. Artemis reads it at startup and applies it to every interaction: tone, communication style, what to avoid, how to present code.

---

## Visual Generation (Freya)

The Freya pipeline adds image and video generation to the standard agent toolset. When a task requires a logo, banner, diagram, or hero image, Artemis generates it directly.

```bash
/config visual   # configure visual provider and defaults
/config vision   # configure vision model for image understanding
```

**Supported providers:** OpenAI DALL-E, Google Gemini, Grok (xAI), Stable Diffusion, BytePlus, and custom endpoints.

---

## Agent Profiles

Multi-agent workflows like `/athena` and `/nidhogg` compose from nine specialist roles, each optimized for a specific function:

| Role | Responsibility | Default Permission |
|------|---------------|-------------------|
| **Planner** | Decompose task into sequenced steps | Read-only |
| **Researcher** | Codebase investigation, evidence gathering | Read-only |
| **Builder** | Precise, minimal code changes | Inherits mode |
| **Reviewer** | Find defects, risks, missing coverage | Read-only |
| **Brainstormer** | Diverge → converge on best approach | Read-only |
| **Arbiter** | Judge competing proposals, decide | Read-only |
| **Architect** | System design, scalability, extensibility | Read-only |
| **Designer** | UI/UX, SVG, frontend assets | Inherits mode |
| **QA** | Test strategy, performance, security | Read-only |

---

## Odin Skill Evolution

Odin watches your sessions and learns from them. After a sufficiently complex multi-step operation, it can capture what happened as a structured skill — complete with principles, tool chains, and known edge cases.

```bash
/odin list                # view active skills
/odin search <keywords>   # find by topic
/odin capture <name>      # manually save a skill
/odin decay               # run confidence decay on stale skills
/odin remove <id>         # remove a skill
```

Skills evolve: draft → active → stale → archived. Confidence degrades with disuse and strengthens with reuse.

---

## Supported AI Providers

30+ providers supported out of the box. Configure via `/model:config` or the setup wizard.

| Provider | Region | Notes |
|----------|--------|-------|
| Anthropic | Global | Claude 3.5 / 4 family |
| OpenAI | Global | GPT-4o, o1, o3 |
| Google Gemini | Global | Gemini 2.0 / 2.5 |
| DeepSeek | CN / Global | R1, V3, Coder |
| Mistral | EU | Codestral, Mixtral |
| Groq | Global | Fast inference |
| OpenRouter | Global | Meta-provider |
| xAI (Grok) | Global | Grok-3 |
| Qwen (Alibaba) | CN | Qwen2.5-Coder |
| Kimi (Moonshot) | CN | Long context |
| BytePlus | CN | Skylark family |
| Zhipu (GLM) | CN | GLM-4 |
| Baidu (ERNIE) | CN | ERNIE 4.0 |
| Minimax | CN | |
| 360 AI | CN | |
| Lingyi (01.AI) | CN | |
| Spark (iFLYTEK) | CN | |
| Hunyuan (Tencent) | CN | |
| Doubao (ByteDance) | CN | |
| Any OpenAI-compatible endpoint | — | Custom base URL |

---

## All Commands Reference

```
Core
  /help              Help and command list
  /commands          Full command catalog
  /new               Start new session
  /clear             Clear screen / reset history
  /exit              Exit session
  /language          Switch interface language
  /version           Show version

Workflows
  /team              Auto-route to best workflow
  /niko              Explore → Build
  /design            Design first → Implement
  /athena            Multi-agent research + execution
  /nidhogg           Harness engineering loop: build, verify, critique, judge
  /contest           Path debate and selection

Thread Control
  /heimdall          Thread status and control
  /ps                List background runtimes
  /logs <id>         Show runtime logs
  /wait <id>         Wait for runtime to complete
  /attach <id>       Attach to a runtime's session
  /kill <id>         Interrupt a runtime

Model & Providers
  /model [name]      Switch model mid-session
  /model:config      Reopen provider setup wizard
  /providers         Show saved provider profiles
  /bifrost           Dual-model configuration
  /mind              Swap Forge ↔ Raven assignment

Messaging Bridge
  /bragi             Bridge control plane
  /bragi telegram    Telegram sessions and setup
  /bragi discord     Discord sessions and setup
  /bragi wechat      WeChat sessions and setup

Knowledge & Research
  /docs <query>      Documentation lookup
  /research <query>  Deep research shortcut
  /deep-research     Configure deep research engine

Skills & Plugins
  /skills            Browse 999 bundled skills
  /odin              Skill evolution layer
  /mcp               Manage MCP servers
  /plugins           Inspect and run local plugins

Memory & Sessions
  /wordup            Save session snapshot
  /wordupnow         Force-save snapshot
  /sessions          Manage saved sessions
  /history           Recent message history
  /context           Current context snapshot
  /summary           Current session summary

Configuration
  /config            View or update configuration
  /config visual     Visual model setup
  /config memory     Memory enhancement setup
  /artemis-md        Audit project instructions
  /revise-artemis-md Generate instruction improvements
  /doctor            System diagnostic

Tasks & Planning
  /plan              Show execution plan
  /tasks             Task board (add, start, done, block)
  /workflow          Workflow record

Permissions
  /mode <mode>       Set permission mode
  /whosyourdaddy     Enable full autonomy mode
  /evidence          Evidence graph
  /verify            Generate verification plan
```

---

## Permission Modes

```bash
/mode prompt         # (default) confirm before writes and shell commands
/mode read-only      # inspection only — no writes
/mode accept-edits   # auto-approve file edits, confirm shell/network
/mode accept-all     # full autonomy — no confirmations
```

Or launch directly into a mode:

```bash
artemis --accept-all
artemis --read-only
```

---

## Configuration

Artemis stores all configuration in `~/.artemis/`:

```
~/.artemis/
  config.json          Provider profiles and settings
  trust.json           Trusted workspaces
  sessions/            WordUP session snapshots
  soul.md              Your personal AI personality file
  skills/              Learned Odin skills
```

Project-level instructions: place an `ARTEMIS.md` at the root of any repository. Artemis reads it on startup and applies it to all interactions within that workspace. Legacy `Artemis.MD`, `Artemis.md`, `artemis.md`, and `.artemis.md` files are still accepted for compatibility.

---

## Development

```bash
git clone https://github.com/420company/artemis
cd artemis
npm install
npm run run        # run from source
npm run typecheck  # must pass with zero errors
npm run lint       # ESLint
npm run test:all   # run all smoke tests
npm run build      # compile to dist/
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

---

## License

MIT — open source, free for everyone. Fork it, extend it, make it yours.

See [LICENSE](LICENSE) for the full text.

---

---

# 中文说明

> 由 [420.COMPANY](https://www.420.company) 构建

Artemis 是一款面向工程师的全功能 AI 编程 CLI，专为认真对待工作流的人设计。三十余家 AI Provider、九十个预装 MCP 插件、九百九十九个专属技能包、双模型脑架构、实时消息桥接——以及一个 Spotify 集成，让你的工作区在你到达的那一刻就已就绪。

我们为 vibe coder 打造了更好的 coding 氛围。得益于 Artemis 的 Spotify 集成，你可以通过 Telegram、Discord 或微信等第三方通讯软件随时控制你的 Spotify——无论身处何地，当你打开工作区时，好的 vibes 早已等候在那里。

---

## 快速开始

```bash
npm install -g artemis-code
artemis
```

首次启动时，CLI 会引导你完成 Provider 配置。其余一切按需启用。

---

## 核心工作流

### `/team` — 自动路由 *(推荐新手起点)*

描述你的任务，Artemis 自动判断并分发到最合适的工作流。

### `/niko` — 探索 → 构建

先广泛探索问题空间、收集证据，再从确定性出发构建实现。适用于最佳路径尚不明确的任务。

### `/design` — 设计优先

先生成完整架构文档（数据模型、接口定义、组件拆分、迁移策略），你审核并确认后，再动手写代码。

### `/athena` — 深度研究 + 多 Agent 协作执行

并行部署多个独立子 Agent 研究代码库，汇总发现后制定统一执行计划。适用于跨模块、跨文件的大型任务。

### `/nidhogg` — 对抗性加固

实现方案 → 对抗性审视弱点 → 迭代修复，直到方案在压力下仍然稳健。最慢，但输出最可靠。适用于支付、安全、数据完整性等关键路径。

### `/contest` — 路径辩论与选择

生成多种竞争性实现方案，明确辩论利弊权衡，选出最优方案并实现。

---

## Heimdall — 线程可观测性

`/heimdall` 让你实时看到 Agent 的执行状态、等待原因和所需输入。

```bash
/heimdall              # 当前线程状态
/heimdall follow       # 实时事件流
/heimdall approve      # 解除待审批阻塞
/heimdall reply <内容>  # 回复 Agent 的澄清请求
/heimdall upload <文件> # 向活跃线程传入文件
```

---

## Bifrost — 双模型架构

规划与执行不需要同一个模型。Bifrost 让你为推理和执行分别配置最适合的 Provider。

```bash
/bifrost   # 打开双模型配置
/mind      # 切换 Forge ↔ Raven 分配
```

**脑模型（Raven）：** 高能力推理模型，负责规划、分析、对抗性审查。如 Claude Opus、GPT-4o、DeepSeek-R1。  
**执行模型（Forge）：** 快速、代码专项模型，负责工具调用、文件编辑、代码生成。如 Claude Haiku、GPT-4o Mini、DeepSeek-Coder。

效果：大模型的推理质量 + 小模型的速度与成本。

---

## MCP 插件

九十个 MCP 服务器预装就绪，HTTP 类型的服务器零配置即可启用。

```bash
/mcp list              # 浏览全部 90 个服务器
/mcp enable <id>       # 启用某个服务器
/mcp doctor            # 诊断 MCP 配置状态
```

包含：GitHub、Vercel、Prisma、Notion、Slack、Figma、Jira/Confluence、Postman、Shopify、AWS SAM、Azure、Sourcegraph、Aikido Security 等。

---

## 消息桥接（Bragi）

通过 Telegram、Discord 或微信发送任务。Artemis 在你的本地机器上执行，并将结果推送回你的手机。与终端完全相同的工具权限。

```bash
/bragi telegram setup   # 配置 Telegram 机器人
/bragi discord setup    # 配置 Discord 机器人
/bragi wechat setup     # 配置微信网关
```

---

## Spotify 集成

Artemis 连接 Spotify，让你的工作区在你就座时就已进入状态。

可通过终端或 **Telegram / Discord / 微信** 控制：

- 播放喜爱的歌曲或播放列表
- 暂停、继续、切换曲目
- 调节音量、切换播放设备
- 查看当前正在播放的内容

找不到活跃设备时，Artemis 会自动唤醒本地 Spotify 客户端并重试。

---

## 记忆系统

### WordUP — 会话快照

```bash
/wordup          # 保存命名快照
/wordupnow       # 立即强制保存
artemis resume --last   # 恢复最近的快照
```

### Soul 文件

`~/.artemis/soul.md` — 写下你的个性偏好。Artemis 启动时读取，并应用于所有交互：语气、沟通风格、代码展示方式。

---

## 支持的 AI Provider

支持 30+ 家 Provider：Anthropic、OpenAI、Google Gemini、DeepSeek、Qwen（阿里）、Kimi（月之暗面）、字节豆包、百度文心、智谱 GLM、BytePlus（火山引擎）、科大讯飞星火、腾讯混元、Minimax、360 AI、零一万物、Mistral、Groq、OpenRouter、xAI Grok，以及任意 OpenAI 兼容端点。

---

## 开发

```bash
git clone https://github.com/420company/artemis
cd artemis
npm install
npm run run        # 从源码运行
npm run typecheck  # 必须零错误
npm run build      # 编译至 dist/
```

详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 开源协议

MIT — 开源，免费，欢迎所有人。Fork 它，扩展它，让它成为你自己的工具。

欢迎 PR、Issue 和一切形式的贡献。

[https://github.com/420company/artemis](https://github.com/420company/artemis)
