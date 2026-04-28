# Artemis 使用说明

## 概述

Artemis 是一个 AI 编程助手 CLI。当前全局命令统一为 `artemis`。

## 安装和使用

### 本地开发

```bash
npm install
npm run run -- --help
npm run run -- <command>
```

### 本地链接

```bash
npm link
artemis --help
npm unlink artemis
```

### 全局安装

```bash
npm install -g artemis-code
artemis --help
```

## 命令

### 基本命令

```bash
artemis --help
artemis --version
artemis config
artemis config --setup
artemis doctor
artemis resume [session-id]
```

### 工作流命令

这些命令会进入真实 agent workflow，需要已配置 provider。

```bash
artemis run "修复一个 bug"
artemis design "做一个产品首页"
artemis athena "研究这个模块"
artemis niko "实现这个功能"
artemis contest "给出三个方案并比较"
artemis nidhogg "审查这次改动"
```

### 工具操作

```bash
artemis tool --list
artemis tool --detail read_file
artemis tool --run read_file path=README.md
artemis tool --run list_files pattern=src
artemis tool --run search_files pattern=TODO maxResults=20
```

只有带 direct executor 的工具可以通过 `artemis tool --run` 直接执行。运行时托管工具会提示通过 agent workflow 调用。

### 查询引擎

```bash
artemis analyze "分析当前项目的代码质量"
artemis execute "帮我优化这段代码"
```

`analyze` 和 `execute` 使用本地 QueryEngine，不等同于完整 agent workflow。需要真实代码执行时使用 `artemis run`。

### 技能管理

```bash
artemis skill --list
artemis skill --detail <name>
```

技能发现基于本地 `skills/**/SKILL.md` 和 `plugins/**/SKILL.md`。

### 会话管理

```bash
artemis session --list
artemis session --create
artemis session show <id>
artemis session --delete <id>
```

### 安全审计

```bash
artemis audit --scan
artemis audit --report
artemis audit --stats
```

`--scan` 会检查数据根目录、工具注册表和 direct executor 覆盖情况。

## 配置

常用环境变量：

```bash
ARTEMIS_MODEL=<model>
ARTEMIS_BASE_URL=<url>
ARTEMIS_API_KEY=<key>
ARTEMIS_LOCALE=zh-CN
```

配置文件默认位于 `.artemis/` 或用户目录下的 `.artemis/`。

## 架构概览

1. `src/cli/parseArgs.ts`：命令和选项解析。
2. `src/cli/runCli.ts`：顶层 CLI dispatcher。
3. `src/cli/interactive.ts`：交互式终端和 slash workflow。
4. `src/core/workflowMode.ts`：`run`、`athena`、`design`、`niko`、`contest`、`nidhogg` 分发。
5. `src/tools/registry.ts`：工具注册表。
6. `src/tools/index.ts`：直接工具执行入口。
7. `src/storage/sessions.ts`：会话持久化。
8. `src/design/`：`/design` 风格词库、设计 brief 和 workflow 增强。

## 开发新技能

1. 在本地插件或 `skills/` 目录中添加 `SKILL.md`。
2. 用 `artemis skill --list` 确认可发现。
3. 如果需要 agent 自动调用，再在相关 workflow 或工具注册表中接入。

## 开发新工具

1. 在 `src/tools/` 中实现 executor。
2. 在 `src/tools/registry.ts` 注册工具定义、权限、验证器和 executor。
3. 用 `artemis tool --list` 和 `artemis audit --scan` 验证注册状态。

## 故障排除

如果 `artemis` 命令不可用：

```bash
npm unlink artemis
npm link
artemis --help
```

如果 provider 未配置：

```bash
artemis config --setup
artemis doctor --test-providers
```

MIT License
