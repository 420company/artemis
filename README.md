# Artemis — AI Engineering CLI

> Built by [420.COMPANY](https://www.420.company)

Artemis is a full-featured AI assistant CLI for software engineers. It gives you a conversational interface to 30+ AI providers, 90 pre-bundled MCP plugins, 999 specialized skills, and an optional messaging bridge — all from a single `npm install`.

---

## Table of Contents

- [What is Artemis](#what-is-artemis)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Supported AI Providers](#supported-ai-providers)
- [Core Workflows](#core-workflows)
- [All Slash Commands](#all-slash-commands)
- [MCP Plugins](#mcp-plugins)
- [Skills](#skills)
- [Messaging Bridge](#messaging-bridge)
- [Session Management & WordUP](#session-management--wordup)
- [Permission Modes](#permission-modes)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Development](#development)
- [License](#license)

---

## What is Artemis

Artemis is not a wrapper around a single AI API. It is a **multi-model, multi-tool engineering agent** that:

- Routes your task to the best workflow (or you pick one manually)
- Calls tools — web search, file operations, code execution, external APIs — through MCP plugins
- Applies 999 specialized skills bundled with the CLI
- Continues across sessions via **WordUP** memory snapshots
- Optionally receives tasks from Telegram (and optionally WeChat) through the **Bragi bridge**

The same agent pipeline runs whether you type in the terminal or message from your phone.

---

## Quick Start

```bash
# Install globally
npm install -g artemis-code

# Launch
artemis

# First run: guided setup wizard walks you through picking a provider and API key
# After setup, type your task or pick a workflow from the menu
```

---

## Installation

**Requirements:**
- Node.js ≥ 20
- npm ≥ 8

```bash
npm install -g artemis-code
```

The `postinstall` script automatically fetches npm-based MCP plugin dependencies into an isolated `mcp-packages/` directory inside the CLI install — your global `node_modules` is not polluted.

**First run** seeds `~/.artemis/mcp-servers.json` with 90 pre-configured MCP servers (all disabled by default; enable the ones you need with `/mcp enable <id>`).

---

## Supported AI Providers

Configure any provider via `/config` or `/bifrost`. Artemis speaks both the OpenAI-compatible API and the native Anthropic Messages API.

| Provider | Notes |
|---|---|
| **Anthropic** | Claude 3/4 family; native Messages API |
| **OpenAI** | GPT-4o, o1, o3, Codex |
| **DeepSeek** | DeepSeek-V3, R1, Coder |
| **Google Gemini** | Gemini 2.0/2.5 Flash & Pro; also OAuth (free tier) |
| **Kimi (Moonshot AI)** | kimi-k2.6, kimi-k2.5, kimi-k2 |
| **Kimi Coding Plan** | Separate coding-optimized endpoint |
| **Kimi China** | Domestic endpoint |
| **MiniMax** | MiniMax-Text, MiniMax-01 |
| **MiniMax China** | Domestic endpoint |
| **Zhipu AI (GLM)** | GLM-4, GLM-Z1 |
| **Z.AI / GLM** | Z.AI hosted GLM |
| **OpenRouter** | 200+ models via single key |
| **Nous Portal** | Hermes, Mixtral |
| **Vercel AI Gateway** | Aggregated access via Vercel |
| **OpenAI Codex** | Codex-mini-latest, responses API |
| **Qwen OAuth** | Alibaba Qwen, free OAuth flow |
| **GitHub Copilot** | Copilot token auth |
| **GitHub Copilot ACP** | Copilot ACP protocol |
| **Xiaomi MiMo** | MiMo reasoning model |
| **NVIDIA NIM** | Llama, Mistral, Nemotron via NIM |
| **Hugging Face** | Inference Providers (serverless) |
| **StepFun** | Step-2 series |
| **Alibaba Cloud** | DashScope / Qwen Coding |
| **Ollama Cloud** | OpenAI-compat Ollama endpoint |
| **Arcee AI** | Arcee Blitz, Agent |
| **Kilo Code** | Kilo Code specialized endpoint |
| **OpenCode Zen** | OpenCode Zen model |
| **OpenCode Go** | OpenCode Go model |
| **Any OpenAI-compatible** | Custom base URL + API key |

**Dual-model mode** (`/bifrost`): configure a separate *brain model* for reasoning/planning and a faster *execution model* for code/tool calls. Recommended setup: a large reasoning model as brain, a fast coding model as executor.

---

## Core Workflows

Type the workflow name at the prompt, or let `/team` pick for you.

### `/team` — AI Auto-Router *(recommended)*

Describe your task in plain language. Artemis analyzes it and dispatches to the most appropriate specialist workflow automatically. Best starting point for new users.

```
> /team I need to add OAuth to my Express app and write tests for it
```

---

### `/niko` — Explore → Build

Structured two-phase approach: first explores the problem space and gathers evidence, then builds a concrete implementation. Ideal for tasks where you're not sure of the best approach.

```
> /niko add dark mode support to my React app
```

---

### `/design` — Design → Implement

Produces a design document (architecture, data model, interfaces, component breakdown) and gets your approval before writing any code. Best for features with non-obvious structure.

```
> /design a real-time collaborative editing feature for our docs app
```

---

### `/athena` — Deep Research + Coordinated Execution

Deploys multiple sub-agents to do parallel deep research across your codebase, then coordinates their findings into a unified execution plan. Use for large refactors, security audits, or complex multi-file changes.

```
> /athena audit all our API endpoints for missing auth checks
```

---

### `/nidhogg` — Adversarial Hardening

The most thorough (and slowest) workflow. Implements a solution, then adversarially challenges it, finds weaknesses, and hardens the result. Produces the most robust output. Use when correctness is critical.

```
> /nidhogg implement the payment processing module
```

---

### `/contest` — Path Debate

Generates multiple competing implementation approaches, debates their trade-offs, then selects the winner and implements it. Useful when there are several plausible designs and you want the reasoning made explicit.

```
> /contest should we use REST or GraphQL for this new API
```

---

### `/run` — Background Workflow

Runs the current workflow as a non-blocking background task. The CLI stays interactive while the agent works. Results are delivered when complete.

```
> /run generate unit tests for all files in src/services/
```

---

## All Slash Commands

### Workflows
| Command | Description |
|---|---|
| `/team [task]` | AI auto-router — picks the right workflow for you |
| `/niko` | Explore then build |
| `/design` | Design first, implement second |
| `/athena` | Deep research + coordinated multi-agent execution |
| `/nidhogg` | Adversarial hardening — slowest but strongest |
| `/contest` | Debate competing approaches, pick the winner |
| `/run` | Run current workflow in background |

### MCP Plugins
| Command | Description |
|---|---|
| `/mcp` | List all 90 pre-bundled MCP servers |
| `/mcp list [keyword]` | Search servers by keyword |
| `/mcp suggest <intent>` | AI ranks the most relevant servers for a task |
| `/mcp enable <id>` | Enable a specific MCP server |
| `/mcp disable <id>` | Disable a specific MCP server |

### Skills
| Command | Description |
|---|---|
| `/skills` | Browse all 999 skills |
| `/skills [keyword]` | Search skills by keyword |

### Configuration
| Command | Description |
|---|---|
| `/config` | Reconfigure AI provider and model |
| `/config visual` | Configure the visual/vision model |
| `/config memory` | Configure memory enhancement |
| `/bifrost` | Set up dual brain + execution models |
| `/model [name]` | Switch model mid-session |
| `/permission [mode]` | Set permission mode (see below) |
| `/newborn` | Wipe all config and re-run setup wizard |

### Session
| Command | Description |
|---|---|
| `/clear` | Reset conversation history (start fresh) |
| `/wordup` | Create a WordUP snapshot of current session |
| `/wordupnow` | Force-create a WordUP snapshot immediately |
| `/history` | Browse prompt history |
| `/help` | Show all available commands |

---

## MCP Plugins

Artemis ships with **90 pre-configured MCP servers** from the official Claude plugin marketplace. All are disabled by default — enable what you need.

### Plugin Types

| Type | Count | Notes |
|---|---|---|
| Streamable HTTP | 53 | Zero local setup; calls remote service |
| stdio (npm/npx) | 22 | Auto-installed via `postinstall` |
| stdio (uvx/Python) | 9 | Requires `uv`/`uvx` on your PATH |
| stdio (bun) | 2 | Source bundled in CLI; requires Bun |
| stdio (binary) | 4 | Requires external binary (e.g. semgrep, jbang) |

### Lazy Dependency Install

When you invoke a tool that needs a missing runtime (e.g. a uvx plugin without `uv` installed), Artemis stops immediately and tells you exactly what to install — it never loops or retries silently:

```
⚠ Missing dependency

Plugin `cco-zscaler-zscaler-mcp-server` failed to start.

Requires uv/uvx (Python package manager):
  curl -LsSf https://astral.sh/uv/install.sh | sh

This requires manual installation. Please install it and retry.
```

npm packages are auto-installed silently on first use.

### Selected Plugins (highlights)

| ID | What it does |
|---|---|
| `cco-vercel-vercel` | Deploy and manage Vercel projects |
| `cco-azure-azure` | Azure resource management |
| `cco-azure-context7` | Context7 — up-to-date docs for any library |
| `cco-prisma-prisma-local` | Prisma ORM schema + migrations |
| `cco-circleback-circleback` | Meeting notes and action items |
| `cco-atlassian-forge-skills-forge` | Atlassian Forge apps |
| `cco-atlassian-forge-skills-ads-mcp` | Atlassian Developer Skills |
| `cco-aikido-aikido-mcp` | Aikido security scanning |
| `cco-goodmem-goodmem` | GoodMem knowledge base |
| `cco-aws-serverless-aws-serverless-mcp` | AWS Serverless Application Model |
| `cco-sagemaker-ai-aws-mcp` | Amazon SageMaker AI |
| `cco-amazon-location-service-aws-mcp` | Amazon Location Service |
| `cco-migration-to-aws-awspricing` | AWS pricing calculator |
| `cco-migration-to-aws-awsknowledge` | AWS knowledge base |
| `cco-fakechat-fakechat` | Generate realistic fake chat screenshots |
| `cco-imessage-imessage` | Read/send iMessages (macOS) |
| `cco-plugin-semgrep` | Static analysis via Semgrep |
| `cco-fiftyone-fiftyone` | Computer vision dataset management |
| `cco-cockroachdb-cockroachdb-toolbox` | CockroachDB toolbox |
| `cco-quarkus-agent-quarkus-agent` | Quarkus Java microservices |
| `cco-zscaler-zscaler-mcp-server` | Zscaler zero-trust policy |

Use `/mcp suggest <your task description>` to get AI-ranked recommendations.

---

## Skills

Artemis bundles **999 skills** — reusable prompt templates, workflows, and reference materials that the agent can invoke during task execution.

Browse them:

```
> /skills
> /skills image generation
> /skills logo design
```

Skills cover: design generation, code review, architecture planning, content creation, data analysis, security auditing, and much more. They are stored in `skills/` and loaded from `skills/registry.json` at startup.

---

## Messaging Bridge

Artemis includes **Bragi**, a messaging bridge that connects Telegram (and optionally WeChat) to the same agent pipeline as the CLI.

- Send a task from your phone — the agent executes it on your machine
- Responses stream back to your chat
- File operations, code generation, MCP tool calls — all work the same as in the terminal
- Configured via `~/.artemis/bragi-config.json`

The bridge runs as a separate process alongside the CLI. Start it with:

```bash
artemis bridge start
```

---

## Session Management & WordUP

### WordUP Snapshots

WordUP is Artemis's session memory system. It automatically saves compressed snapshots of your conversation context at key moments, and you can restore them to continue where you left off — even after restarting the CLI.

```
> /wordup          # save a snapshot
> /wordupnow       # force-save immediately
```

Snapshots are stored in `~/.artemis/sessions/`.

### Context Compression

When your conversation approaches the model's context limit, Artemis automatically compresses older context while preserving the working state — you can keep working without losing track of what was decided earlier.

---

## Permission Modes

Control how much the agent can do without asking:

| Mode | Behavior |
|---|---|
| `default` | Asks before file writes, shell commands, and external calls |
| `accept-edits` | Auto-approves file edits; asks for shell/network |
| `accept-all` | Full autonomy — runs without confirmation (WhosYourDaddy mode) |

Set with:

```
> /permission accept-all
```

Or per-session at the prompt when the agent asks for confirmation.

---

## Configuration

All user data lives in `~/.artemis/`:

```
~/.artemis/
├── config.json          # Active provider, model, preferences
├── mcp-servers.json     # 90 MCP server configs (seeded from defaults on first run)
├── bragi-config.json    # Messaging bridge config
├── sessions/            # WordUP session snapshots
└── memory/              # Persistent user memory (facts, preferences)
```

**Key commands:**

```
> /config              # Re-run provider setup wizard
> /bifrost             # Configure dual brain/execution models
> /model gpt-4o        # Switch model inline
> /permission          # Adjust permission mode
> /newborn             # Full reset — wipes ~/.artemis/config.json and re-runs setup
                       # (Does NOT re-trigger MCP install; that's based on disk state)
```

---

## Architecture

```
┌─────────────────────────────────────────────┐
│                   artemis                    │
│                                              │
│  CLI (blessed TUI)   Bragi Bridge           │
│       │                   │                 │
│       └────────┬──────────┘                 │
│                │                            │
│           Agent Pipeline                    │
│    ┌───────────┴───────────┐                │
│    │  Brain Model          │  (reasoning)   │
│    │  Execution Model      │  (code/tools)  │
│    └───────────┬───────────┘                │
│                │                            │
│    ┌───────────┼───────────┐                │
│    │           │           │                │
│  Tools      Skills       MCP               │
│  (built-in) (999)        (90 servers)      │
│                                              │
│  Providers: Anthropic, OpenAI, DeepSeek,   │
│  Gemini, Kimi, Qwen, OpenRouter, 20+ more  │
└─────────────────────────────────────────────┘
```

**How a request flows:**

1. User types a task in the CLI or sends it via Bragi bridge
2. Agent pipeline receives the message (same code path for both)
3. Brain model analyzes the task and produces a plan
4. Execution model runs the plan: calls tools, reads files, executes commands, calls MCP plugins
5. If a tool needs a missing dependency: stops, informs user, does not retry
6. Results stream back to the terminal / messaging app
7. WordUP auto-saves a snapshot at session milestones

---

## Project Structure

```
artemis/
├── src/
│   ├── cli/             # TUI, prompt, branding, setup wizard
│   ├── core/            # Agent pipeline, system prompt, workflows
│   │   ├── agent.ts     # Main agent loop
│   │   ├── systemPrompt.ts
│   │   ├── agentProfiles.ts  # Specialist role definitions
│   │   └── providers/   # AI provider adapters
│   ├── mcp/
│   │   ├── client.ts    # MCP transport (http, stdio)
│   │   ├── store.ts     # MCP server config storage
│   │   └── installer.ts # Dependency detection & install
│   ├── bragi/           # Messaging bridge runtime
│   ├── tools/           # Built-in tool definitions
│   └── providers/       # Provider presets & onboarding
├── skills/              # 999 skill definitions
│   └── registry.json
├── plugins/             # Bundled bun-based MCP plugin sources
│   ├── cco-fakechat-fakechat/
│   └── cco-imessage-imessage/
├── mcp-packages/        # npm MCP packages (installed via postinstall)
│   └── package.json
├── defaults/
│   └── mcp-servers.json # Default 90-server MCP config (seeded on first run)
└── dist/                # Compiled output (TypeScript → ESM)
```

---

## Development

```bash
# Clone and install
git clone https://github.com/420company/artemis
cd artemis
npm install

# Run in dev mode (tsx, no build needed)
npm run run

# Type-check
npm run typecheck

# Build
npm run build

# Lint
npm run lint

# Run smoke tests
npm run test:all
```

**Dev scripts:**
- `npm run test:system` — system smoke test
- `npm run test:prompt` — prompt pipeline test
- `npm run test:runtime` — runtime behavior test
- `npm run test:queryEngine` — query engine test
- `npm run test:features` — feature smoke test

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Bug reports and feature requests: [GitHub Issues](https://github.com/420company/artemis/issues)

---

## License

MIT — see [LICENSE](LICENSE)

---

*Artemis is built and maintained by [420.COMPANY](https://www.420.company)*
