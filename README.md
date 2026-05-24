# Artemis Code

<p align="center">
  <img src="assets/artemis-github-banner.png" alt="Artemis Code GitHub banner" width="100%" />
</p>

<p align="center">
  <strong>Local-first AI engineering, visual generation, long-video production, memory, tools, and mobile automation — in one command-line workspace.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/artemis-code"><img src="https://img.shields.io/npm/v/artemis-code" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="MIT license" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node >= 20" /></a>
</p>

<p align="center">
  Created by <a href="https://www.420.company">420.COMPANY</a> · npm: <a href="https://www.npmjs.com/package/artemis-code"><code>artemis-code</code></a> · GitHub: <a href="https://github.com/420company/artemis"><code>420company/artemis</code></a>
</p>

---

## English

### What is Artemis Code?

Artemis Code is a local-first AI workspace agent for people who want execution, not suggestions.

It works inside your real project folder, reads the files, edits the code, runs commands, checks logs, verifies results, and keeps context across long sessions. It can build software, review changes, manage tools, generate images and video, operate long creative workflows, remember your preferences, and connect to mobile chat platforms so you can drive work from anywhere.

Artemis is designed for users who want one intelligent operator across engineering, creative production, research, automation, and daily workflows.

Current npm release: **0.2.72**

---

### Core experience

#### 1. Local-first autonomous execution

Artemis runs where your work lives: your terminal, your repository, your files, your machine.

You can ask for a feature, a fix, a release check, a refactor, a README rewrite, a visual asset, or a long video. Artemis will inspect the workspace, plan the steps, make the changes, run the appropriate checks, and report the result with evidence.

What this means in practice:

- Reads and edits real local files
- Uses precise patches instead of vague instructions
- Runs terminal commands directly
- Diagnoses build, lint, test, and runtime failures
- Keeps changes small when the task is small
- Runs verification before claiming success
- Works with existing project conventions instead of imposing a template

#### 2. Software engineering workflow

Artemis can handle everyday and advanced engineering work:

- Implement new features
- Fix bugs from stack traces or screenshots
- Refactor modules safely
- Update configuration files
- Add or adjust tests
- Review Git diffs before release
- Prepare npm package releases
- Inspect package contents before publishing
- Clean temporary files and accidental artifacts
- Diagnose environment, dependency, and command failures

The goal is simple: you describe the outcome; Artemis does the operational work.

#### 3. Persistent memory and long-context stability

Long work often fails because the assistant forgets. Artemis is built to preserve continuity.

It maintains local memory, session state, collapse ledgers, tool evidence, and recovery context so long tasks can continue without losing the important parts. Your preferences, project conventions, workflow habits, and recurring constraints can become part of the way Artemis works with you.

Useful for:

- Large refactors
- Multi-step releases
- Long creative workflows
- Repeated project maintenance
- Returning to a task after interruption
- Keeping your personal style and rules consistent

#### 4. Visual generation system

Artemis includes a full visual workflow layer for image and video generation.

It can help create:

- Product visuals
- Concept art
- Character references
- README and brand assets
- UI and presentation images
- Short video clips
- Long cinematic sequences
- Abstract visuals and VJ loops
- Story-driven video scenes

The visual system is provider-aware and can route image, vision, and video requests through configured providers. It asks for missing inputs, handles local media references, and keeps creative intent connected to the final generation workflow.

#### 5. Saga long-video engine

Saga is Artemis' long-video production workflow. It is built for videos that need structure, consistency, and continuity instead of one-off clips.

Saga can:

- Turn a concept into a structured video brief
- Expand sparse ideas into a complete cinematic script
- Respect user-written scripts as authoritative material
- Split long videos into model-safe segments
- Preserve character identity, wardrobe, accessories, scene logic, lighting, and movement direction
- Use reference images, direct image inputs, character photos, or turnaround sheets
- Ask for aspect ratio, subtitle mode, duration, references, and BGM choices
- Generate original-audio, full-BGM, and dialogue-ducked variants when soundtrack mixing is used
- Support clean-direct / raw-look workflows
- Handle pure environment or abstract videos without forcing unwanted characters
- Maintain opening framing, movement direction, and continuity between shots

Saga is designed for users who want to say: “Make this into a real video,” then be guided through the right creative and technical steps.

#### 6. Brief authoring and AI screenwriter mode

Artemis can work with both complete scripts and partial inspiration.

If you already have a script, Artemis treats it as the controlling narrative. If you only have a topic, mood, character, place, or rough idea, Artemis can act as a screenwriter and expand it into a structured Saga-compatible brief.

The package includes a full bilingual authoring guide:

- `docs/saga-brief-authoring-guide.html`

It explains how to write timecoded scenes, dialogue markers, aspect ratio notes, character locks, opening framing, world anchors, audio intent, BGM planning, and advanced long-video brief structures.

#### 7. Mobile bridge and ambient control

Artemis can be connected to chat platforms such as Telegram, Discord, or WeChat through its bridge system.

This lets you:

- Send work instructions from your phone
- Start visual or video workflows remotely
- Receive generated media back in chat
- Continue project work away from the desk
- Use Artemis as an always-available ambient agent

The mobile bridge turns your local machine into a reachable creative and engineering workstation.

#### 8. Daily tools and external integrations

Artemis is not limited to code. It includes workflow tools for everyday operations and can connect to external services through MCP servers.

Capabilities include:

- Weather, time, currency, and flight lookups
- Calendar and reminder workflows on macOS
- Spotify playback control when explicitly requested
- Browser automation for pages that require interaction
- MCP server discovery, enabling, and runtime use
- Local speech, media, and bridge utilities

The intention is to make Artemis useful as a practical daily operator, not only a coding assistant.

#### 9. Background work and heavy tasks

For long-running work, Artemis can detach tasks into background workflows. This is useful for large investigations, deep refactors, extended research, or slow media operations.

You can keep using your terminal while Artemis continues the heavy work and returns when there is a result.

---

### Installation

Requirements:

- Node.js **20+**
- npm
- A terminal
- At least one configured AI provider for model-backed tasks

Install globally:

```bash
npm install -g artemis-code
```

Start Artemis inside any project:

```bash
cd /path/to/your/project
artemis
```

---

### Typical ways to use Artemis

```text
Fix the failing build and run the tests.
```

```text
Review my current Git diff for release blockers.
```

```text
Create a polished product image for this landing page.
```

```text
Turn this story idea into a 60-second cinematic Saga video.
```

```text
Clean the package, verify it, bump the version, and publish to npm.
```

```text
Rewrite the README for GitHub so it explains the product clearly to users.
```

---

### Useful commands

- `/config` — Configure providers, models, keys, and preferences
- `/team` — Let Artemis choose the best routing strategy for the task
- `/review` — Review the current Git diff and identify risks
- `/nidhogg` — Run heavy or long work in the background
- `/wordup` — Save important context into memory
- `/soul` — Define long-term personal style, rules, and working preferences
- `/mcp` — Manage external MCP integrations

---

### Who Artemis is for

Artemis is for builders, founders, creators, designers, engineers, and operators who want a single local agent that can actually do the work.

Use it when you want:

- Less copy-paste
- Fewer manual terminal steps
- Stronger release discipline
- Better continuity across long tasks
- A serious visual and video workflow
- A local agent that understands your workspace
- A mobile-accessible assistant that can operate your machine

---

## 中文

### Artemis Code 是什么？

Artemis Code 是一个本地优先的 AI 工作区代理。它不是只给建议、让你自己复制粘贴的聊天框，而是可以直接进入你的真实项目目录，读取文件、修改代码、执行命令、检查日志、验证结果，并在长任务中保持上下文连续的执行型助手。

它可以写代码、修 Bug、做发布检查、清理包内容、生成图片和视频、组织长视频工作流、记住你的偏好，也可以通过手机聊天平台远程接收指令和发送产物。

Artemis 面向的是希望把工程、创意、自动化、研究和日常操作交给一个统一智能操作者的人。

当前 npm 版本：**0.2.72**

---

### 核心体验

#### 1. 本地优先，直接执行

Artemis 运行在你的终端和项目目录里。它面对的不是抽象问题，而是真实文件、真实命令、真实构建、真实错误。

你可以让它做一个功能、修一个问题、检查一次发布、重写文档、生成视觉素材，或者制作一段长视频。Artemis 会自己检查工作区、拆解步骤、修改文件、运行验证，并基于工具结果汇报进展。

实际效果是：

- 直接读取和编辑本地文件
- 用精确 Diff 修改，而不是给你一段需要手抄的代码
- 直接执行终端命令
- 自动诊断构建、lint、测试和运行时报错
- 小任务做最小改动，大任务分阶段推进
- 验证通过后再汇报完成
- 尊重现有项目风格，不强行套模板

#### 2. 工程开发工作流

Artemis 可以处理日常和复杂的软件工程任务：

- 实现新功能
- 根据报错、日志或截图修 Bug
- 安全重构模块
- 更新配置文件
- 补充或修正测试
- 发布前审查 Git diff
- 准备 npm 包发布
- 检查 npm 包实际包含内容
- 清理临时文件、日志和意外产物
- 排查环境、依赖和命令失败

你描述目标，Artemis 负责执行过程。

#### 3. 持久记忆与长上下文稳定性

很多 AI 工具在长任务中会遗忘前文。Artemis 的设计目标是让任务可以持续推进。

它会把记忆、会话状态、工具证据、压缩账本和恢复上下文保存在本地，让长时间工作不会因为中断、折叠或会话变长而失去关键线索。你的偏好、项目规则、语言风格和长期约束也可以被保留下来。

适合用于：

- 大型重构
- 多阶段发布
- 长视频和视觉制作
- 长期项目维护
- 中断后继续任务
- 保持个人工作习惯和审美一致

#### 4. 视觉生成系统

Artemis 内置完整的视觉工作流，可以处理图片、视觉分析和视频生成。

它可以帮助你创建：

- 产品图
- 概念视觉
- 角色参考
- README 与品牌素材
- UI 和展示图片
- 短视频片段
- 长视频序列
- 抽象视觉和 VJ 循环
- 有剧情结构的视频场景

视觉系统会根据配置的模型和供应商选择合适路径，主动询问缺失参数，识别本地媒体引用，并把创意意图稳定传递到最终生成流程。

#### 5. Saga 长视频引擎

Saga 是 Artemis 的长视频生产工作流。它不是简单生成一个短片段，而是为需要结构、连续性和可控性的完整视频而设计。

Saga 可以：

- 把概念整理成结构化视频 brief
- 把零散灵感扩展成完整影视脚本
- 尊重用户已经写好的剧本，不随意替换剧情
- 把长视频拆成当前模型稳定支持的片段
- 保持角色身份、服装、配饰、场景逻辑、光线和运动方向一致
- 支持参考图、直接图片输入、角色照片和三视图
- 主动询问画幅比例、字幕模式、总时长、参考素材和 BGM 选择
- 使用 BGM 时自动输出原声版、完整混音版和对白智能避让版
- 支持 clean-direct / raw-look 原始质感模式
- 支持纯环境、抽象视觉和无人物视频
- 稳定控制首帧定位、人物朝向、运动方向和镜头连续性

Saga 适合用户直接说：“把这个想法做成一条真正的视频。”然后由 Artemis 引导完成创作和技术流程。

#### 6. 剧本说明书与 AI 编剧模式

Artemis 可以处理完整剧本，也可以处理只有一句话的灵感。

如果你已经有剧本，Artemis 会把它作为权威叙事来执行。如果你只有主题、氛围、人物、地点或大致想法，Artemis 可以进入 AI 编剧模式，把它扩展成 Saga 能稳定识别的结构化 brief。

包内包含完整中英文说明书：

- `docs/saga-brief-authoring-guide.html`

它详细说明了时间码、对白标记、画幅比例、角色锁定、首帧定位、世界锚点、音频意图、BGM 规划和高级长视频 brief 写法。

#### 7. 手机桥接与远程控制

Artemis 可以通过桥接系统连接 Telegram、Discord 或微信等聊天平台。

你可以：

- 在手机上发送工作指令
- 远程启动视觉或视频流程
- 在聊天窗口接收生成好的图片和视频
- 离开电脑后继续推进项目
- 把本地机器变成可远程调用的创意和工程工作站

这让 Artemis 不只是终端工具，也可以成为随时可用的 ambient agent。

#### 8. 日常工具与外部集成

Artemis 不只处理代码。它也可以接入日常工具和外部服务。

能力包括：

- 天气、时间、汇率、航班查询
- macOS 日历和提醒事项
- 明确要求时控制 Spotify 播放
- 使用浏览器自动化处理需要交互的网页
- MCP 服务发现、启用和调用
- 本地语音、媒体和桥接工具

目标是让 Artemis 成为一个实用的日常操作者，而不仅仅是编程助手。

#### 9. 后台任务与重型工作

对于耗时任务，Artemis 可以把工作转入后台执行。适合大型排查、深度重构、长时间研究和媒体处理。

你可以继续使用终端，Artemis 在后台推进任务，并在有结果后回来汇报。

---

### 安装

环境要求：

- Node.js **20+**
- npm
- 终端
- 至少配置一个可用的 AI 模型供应商

全局安装：

```bash
npm install -g artemis-code
```

进入任意项目目录并启动：

```bash
cd /path/to/your/project
artemis
```

---

### 典型用法

```text
修复现在失败的构建，并跑完测试。
```

```text
检查我当前的 Git diff，找出发布风险。
```

```text
给这个落地页生成一张高级产品视觉图。
```

```text
把这个故事想法扩展成 60 秒 Saga 电影感视频。
```

```text
清理 npm 包内容，验证、升级版本并发布。
```

```text
重写 GitHub README，让用户一眼看懂产品能力。
```

---

### 常用命令

- `/config` — 配置模型供应商、密钥和偏好
- `/team` — 让 Artemis 自动选择最合适的任务路线
- `/review` — 审查当前 Git diff，发现潜在风险
- `/nidhogg` — 把复杂或耗时任务转入后台执行
- `/wordup` — 保存重要上下文到记忆
- `/soul` — 定义长期个人风格、规则和工作偏好
- `/mcp` — 管理外部 MCP 集成

---

### 适合谁使用？

Artemis 适合开发者、创作者、设计师、创业者、运营者，以及任何希望用一个本地 AI 代理真正完成工作的人。

当你需要这些能力时，Artemis 会特别有用：

- 减少复制粘贴
- 减少手动终端操作
- 更可靠的发布流程
- 长任务中保持上下文连续
- 严肃的视觉与视频生产工作流
- 理解本地项目结构的 AI 助手
- 可以从手机远程调用的本地工作站
