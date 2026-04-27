# MyLaude 配置向导扩展方案

## 概述

这个扩展方案基于 Hermes Agent 配置系统架构，为 MyLaude 提供了一个完整的配置向导系统，包含多模式配置、智能检测和渐进式配置功能。

## 核心改进

### 1. 扩展的配置 Sections

新增 4 个重要的配置部分：

#### Terminal Backend（终端后端）
- 支持本地运行（默认）
- Docker 隔离容器
- SSH 远程机器
- Modal 无服务器云沙箱

#### Text-to-Speech（语音输出）
- Microsoft Edge TTS（免费）
- ElevenLabs（高质量）
- OpenAI TTS
- xAI TTS
- MiniMax TTS
- Mistral Voxtral
- Google Gemini TTS
- KittenTTS（本地运行）

#### Tool Configuration（工具配置）
- 支持选择性启用/禁用工具
- 工具状态管理
- 配置需要 API 密钥的工具

#### Session Management（会话管理）
- 会话自动重置策略
- 闲置超时配置
- 每日定时重置

### 2. 增强的交互体验

- **无超时自动选择**：完全尊重用户选择，无超时自动跳转逻辑
- **清晰的配置流程**：每个 section 都有明确的标题和说明
- **详细的状态反馈**：配置完成后显示详细的可用性摘要

### 3. 改进的可用性检查

- **实时配置验证**：检查配置文件完整性
- **智能依赖检测**：识别需要 API 密钥的工具
- **完整的设置摘要**：配置完成后显示所有组件状态

## 集成步骤

### 1. 替换现有配置向导

```typescript
// src/cli/runCli.ts
// 将导入语句从：
import { runSetupWizard } from './setupWizard.js'

// 改为：
import { runSetupWizard } from './setupWizardExtended.js'
```

### 2. 更新配置类型定义

在 `src/providers/types.ts` 中添加新的配置类型：

```typescript
// src/providers/types.ts
export interface TerminalSetupConfig {
  backend: 'local' | 'docker' | 'ssh' | 'modal'
}

export interface TtsSetupConfig {
  provider: 'edge' | 'elevenlabs' | 'openai' | 'xai' | 'minimax' | 'mistral' | 'gemini' | 'kittentts'
  apiKey?: string
}

export interface SessionSetupConfig {
  resetMode: 'inactivity+daily' | 'inactivity' | 'daily' | 'never'
  inactivityTimeout?: number
  dailyResetHour?: number
}

export interface ToolSetupConfig {
  enabledTools: string[]
}

export interface SetupConfig {
  agent: AgentSetupConfig
  terminal?: TerminalSetupConfig
  tts?: TtsSetupConfig
  session?: SessionSetupConfig
  tools?: string[]
}
```

### 3. 更新默认配置

在 `src/providers/store.ts` 中更新默认配置：

```typescript
// src/providers/store.ts
export const DEFAULT_SETUP_CONFIG: SetupConfig = {
  agent: {
    maxIterations: 90,
    compression: {
      enabled: true,
      threshold: 0.5,
    },
  },
  terminal: {
    backend: 'local',
  },
  tts: {
    provider: 'edge',
  },
  session: {
    resetMode: 'inactivity+daily',
    inactivityTimeout: 1440,
    dailyResetHour: 4,
  },
  tools: ['web_search', 'browser', 'terminal', 'file', 'code', 'vision', 'tts', 'skills', 'todo', 'memory', 'session_search', 'clarify', 'delegate', 'cron', 'messaging'],
}
```

### 4. 更新运行时使用

在 `src/cli/interactive.ts` 和其他相关文件中使用新配置：

```typescript
// src/cli/interactive.ts
const setup = providerData.setup
const terminalBackend = setup?.terminal?.backend ?? 'local'
const ttsProvider = setup?.tts?.provider ?? 'edge'
const enabledTools = setup?.tools ?? DEFAULT_SETUP_CONFIG.tools
```

## 使用方法

### 运行配置向导

```bash
# 完整配置向导
artemis setup

# 快速配置（推荐）
artemis setup quick

# 配置特定 section
artemis setup model      # 模型和提供商
artemis setup visual     # 视觉生成
artemis setup gateway    # 通讯平台
artemis setup agent      # 代理设置
artemis setup memory     # 记忆增强
artemis setup terminal   # 终端后端
artemis setup tts        # 语音输出
artemis setup tools      # 工具配置
artemis setup session    # 会话管理

# 查看当前配置
artemis config

# 查看配置摘要
artemis config summary
```

### 配置示例流程

```
$ artemis setup terminal

┌─────────────────────────────────────────────────────────┐
│                 Terminal Backend                        │
└─────────────────────────────────────────────────────────┘

  选择命令执行的环境，影响工具隔离性。

  选择终端后端:
  ↑↓ 移动  Enter 确认

  (●)  Local - 直接在本机运行（默认）
  (○)  Docker - 隔离容器
  (○)  SSH - 远程机器
  (○)  Modal - 无服务器云沙箱

  Choice [default 1]: 2
  ✓ Terminal backend set to: docker

┌─────────────────────────────────────────────────────────┐
│                 Setup Summary                           │
└─────────────────────────────────────────────────────────┘

  ✓ Main provider: seed-2-0-pro-260328 (BytePlus)
  ✗ Secondary provider: not configured
  ✗ Image generation: disabled
  ✗ Video generation: disabled
  ✓ Agent max iterations: 90
  ✓ Compression threshold: 0.5
  ✗ Memory enhancement: disabled
  ✓ Terminal backend: docker
  ✓ TTS provider: edge
  ✓ Tools enabled: 15
```

## 核心优势

### 1. 用户体验提升

- **渐进式配置**：用户可以只配置需要的部分
- **无压力选择**：所有选择都是明确的，无超时自动跳转
- **详细反馈**：每个步骤都有清晰的状态指示

### 2. 系统架构改进

- **模块化设计**：每个配置 section 都是独立模块
- **可扩展性强**：添加新配置项只需新增模块
- **状态一致性**：完整的配置验证和恢复机制

### 3. 运维友好

- **清晰的文档**：每个配置项都有详细说明
- **完整的审计**：配置变更记录和恢复机制
- **系统监控**：配置健康检查和状态报告

## 与 Hermes Agent 对比

| 特性 | MyLaude 现有 | MyLaude 扩展后 | Hermes Agent |
|------|-------------|----------------|-------------|
| 多模式配置 | ✓ 基本 | ✓ 完整 | ✓ 完整 |
| 分区配置 | ✓ 5个 | ✓ 9个 | ✓ 11个 |
| 终端后端 | 固定本地 | ✗ 可选 | ✓ 可选 |
| TTS 配置 | 无 | ✓ 8个提供商 | ✓ 10个提供商 |
| 工具配置 | 无 | ✓ 19个工具 | ✓ 19个工具 |
| 会话管理 | 无 | ✓ 4种策略 | ✓ 4种策略 |
| 超时处理 | 有 | ✗ 无 | ✓ 智能 |

## 总结

这个扩展方案为 MyLaude 提供了一个完整的配置向导系统，基于 Hermes Agent 的最佳实践，同时保留了 MyLaude 的特色功能。用户可以通过简单的命令进行配置，系统会提供清晰的指导和反馈，确保配置过程顺利和高效。