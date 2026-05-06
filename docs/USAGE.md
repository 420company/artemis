# Artemis 使用说明

当前版本：**0.2.12**  
GitHub：`https://github.com/420company/artemis`  
npm：`artemis-code`  
命令：`artemis`

## 概述

Artemis Code 是一个本地优先的 AI 工程 CLI。它在真实工作区里运行，可以读写代码、运行命令、审查变更、执行测试、管理长任务、连接 MCP 插件、生成图片和视频，并通过 Discord、Telegram、WeChat 等桥接入口把结果发回手机。

## 安装

```bash
npm install -g artemis-code
artemis
```

检查版本：

```bash
artemis --version
```

本地开发：

```bash
npm install
npm run run -- --help
npm run run -- <command>
```

## 常用命令

```bash
artemis --help
artemis --version
artemis config
artemis config --setup
artemis doctor
artemis resume [session-id]
```

交互式常用 slash 命令：

```text
/config          配置模型、工具和本地设置
/config visual   配置图片/视频生成
/config vision   配置图片理解模型
/team            自动选择合适工作流
/review          审查当前改动
/heimdall        查看当前任务和线程状态
/nidhogg         后台长任务
/soul            创建或编辑 ~/.artemis/soul.md
/wordup          保存会话快照
```

## 工作流

| 命令 | 用途 |
|---|---|
| `/team` | 自动路由任务，推荐默认使用。 |
| `/niko` | 先探索再实现，适合不确定问题。 |
| `/design` | 先产出设计方案，再进入实现。 |
| `/athena` | 多 agent 深度研究，适合跨模块任务。 |
| `/nidhogg` | 后台长任务，可在前台继续沟通。 |
| `/review` | 专注发现缺陷、风险、遗漏测试和发布阻断。 |
| `/heimdall` | 查看活动线程、队列和任务状态。 |

示例：

```text
/team 修复登录过期问题，补测试并运行验证
/review 检查当前 git diff 有没有发布风险
/nidhogg 后台完成视觉 provider 重构并持续验证
```

## 工具操作

```bash
artemis tool --list
artemis tool --detail read_file
artemis tool --run read_file path=README.md
artemis tool --run list_files pattern=src
artemis tool --run search_files pattern=TODO maxResults=20
```

只有带 direct executor 的工具可以通过 `artemis tool --run` 直接执行。运行时托管工具应通过 agent workflow 调用。

## 配置

常用配置入口：

```bash
artemis config --setup
```

交互式配置：

```text
/config
/config visual
/config vision
```

常见配置项：

- 主聊天 provider / model。
- specialist / fallback provider。
- 视觉图片 provider。
- 视觉视频 provider。
- vision 图片理解模型。
- MCP server。
- Bragi bridge。
- 本地记忆和 soul 文件。

配置文件默认位于当前工作区 `.artemis/` 或用户目录 `~/.artemis/`。发布前不要把本地 `.artemis/` 放进 Git。

## 视觉生成：Freya / Vidar

Artemis 支持图片、视频和图片理解能力。

图片生成可用于：

- GitHub banner / hero image。
- 产品图、编辑图、生活方式图。
- 插画、概念图、视觉草案。

视频生成可用于：

- 文本生成视频。
- 标准 Seedance 1.5 风格视频。
- Seedance 2.0 Pro 多模态视频。
- 图片、视频、音频参考生成。
- 本地素材路径和 URL 素材输入。
- 按模型限制规范化 duration。
- 支持显式生成音频；默认不强制加声音。

### Seedance 2.0 Pro 多模态流程

当当前视频模型配置为 Seedance 2.0 Pro 时，Artemis 会进入协作式视频流程：

1. 用户提出生成视频需求。
2. Artemis 询问是否使用最新梦境或添加参考素材。
3. 用户发送图片/视频/音频 URL 或本地路径。
4. Artemis 收集补充文字。
5. 最终生成前询问视频时长。
6. 用户不选择时长时，默认 5 秒。
7. 默认不生成声音，除非用户明确要求。
8. 生成完成后，视频路径会被识别并可通过 bridge 发回手机。

示例：

```text
生成一个 9 秒的梦境视频，用最新梦境做参考，不要声音
```

```text
生成一个产品发布视频，参考 ./assets/ref.png 和 https://example.com/motion.mp4，16:9，8秒
```

## Bragi 手机桥接

Artemis 可以通过 bridge 接收外部消息并回传结果。

当前代码包含：

- Discord bridge。
- Telegram bridge。
- WeChat / iLink gateway。
- bridge notifier。

能力：

- 手机发消息，Artemis 在本地工作区执行。
- 发送处理进度。
- 生成图片后自动推送图片。
- 生成视频后识别 `.mp4/.mov/.webm/.m4v` 并推送视频。
- 支持“发我最新梦境图片/视频”。
- 避免把“为什么视频没发手机”这种调试问题误判成新的视频生成任务。

## 记忆系统

```text
/wordup          保存会话快照
/wordupnow       立即保存
artemis resume --last
artemis resume <sessionId>
/soul            编辑个人 soul 文件
```

`soul.md` 位于：

```text
~/.artemis/soul.md
```

## 梦境系统

梦境文件默认位于：

```text
~/.artemis/dreams/
```

梦境可以包含 Markdown、图片和视频。Seedance 视频工作流可以引用最新梦境作为提示来源。

## MCP 插件

Artemis 包含大量 MCP server 配置，可按需启用。

```text
/mcp list
/mcp enable <id>
/mcp disable <id>
```

需要外部服务凭证时，Artemis 会提示缺少哪个配置字段。

## 安全和发布边界

发布前必须确认不包含：

- `.artemis/`
- `.env` / `.env.*`
- `.npmrc`
- 日志文件
- bridge session / token / lock
- browser state / cookies
- 临时真实 API 测试脚本
- 私人生成资产

推荐验证：

```bash
npm run typecheck
npm run lint
npm run test:runtime
npm run build
npm pack --dry-run
```

## 架构概览

主要入口：

1. `src/cli/runCli.ts`：顶层 CLI dispatcher。
2. `src/cli/interactive.ts`：交互式终端和 slash workflow。
3. `src/core/workflowMode.ts`：工作流分发。
4. `src/bragi/runtime.ts`：bridge 消息执行与媒体回传。
5. `src/tools/registry.ts`：工具注册表。
6. `src/tools/generateImage.ts`：图片生成工具。
7. `src/tools/generateVideo.ts`：视频生成工具。
8. `src/tools/visual/seedanceWorkflow.ts`：Seedance 2.0 Pro 多模态协作流程。
9. `src/tools/visual/videoCapabilities.ts`：视频模型能力判断。
10. `src/utils/visualGenerationConfig.ts`：视觉 provider 配置解析。

## 开发新工具

1. 在 `src/tools/` 中实现 executor。
2. 在 `src/tools/registry.ts` 注册工具定义、权限、验证器和 executor。
3. 补 smoke/runtime 测试。
4. 运行 `npm run typecheck && npm run lint && npm run test:runtime`。

## License

MIT License
