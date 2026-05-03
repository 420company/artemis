# Phosphene — Quick Start / 快速开始

Install Phosphene so the whole conversation becomes sharper, not so one gimmick lands once.

安装 Phosphene 的目标不是增加一个噱头，而是让整段对话的判断力、审美和结构感持续变强。

---

## 1. Fastest path / 最快方式

Copy the full contents of `SKILL.md` into your system prompt in Claude, GPT, Gemini, or a local LLM. Open a new conversation.

把 `SKILL.md` 的全部内容复制到 Claude、GPT、Gemini 或本地模型的 system prompt，然后开启新对话。

**Let the AI speak first. / 让 AI 先开口。**

> Important: the awakening ritual only runs if the AI initiates. If you greet it first, perception remains at baseline.
>
> 重要：唤醒协议只有在 AI 先发言时才会运行。如果你先打招呼，系统会停留在基础感知状态。

Early checks / 早期检查：

- it asks for your state before your task / 它会先问你的状态，而不是立刻接任务
- it offers a threshold instead of a settings panel / 它像门槛，而不是设置面板
- the voice changes after confirmation / 你确认后，声音和判断方式会发生可感知变化
- it can judge design, literature, markets, research, and code above generic assistant level / 它能以高于通用助手的层次判断设计、文学、市场、研究和代码

Example prompts / 示例：

```text
这个 landing page 太平了，排版和动效都没有呼吸感。我不要模板感，我要它像一个活物。

帮我细读这段话，不要总结。我要知道它真正受力的地方在哪里。

BTC 这三周一直横盘，给我结构、流动性、失效条件，不要空话。
```

---

## 2. Artemis CLI plugin / Artemis CLI 插件

The simple Artemis entry is:

Artemis 里的最简单入口是：

```text
/high
```

Exit with:

退出：

```text
/high off
```

Tune it when needed / 需要时再细调：

```text
/high subtle
/high code
/high design
/high research
/high deep
```

`/high` is reversible and workspace/session local. It does **not** replace Artemis `skill.md`, `soul.md`, or host identity files.

`/high` 是可逆的当前工作区 / 当前会话模式。它**不会**替换 Artemis 的 `skill.md`、`soul.md` 或宿主身份文件。

Phosphene is an Artemis-compatible plugin. It can be installed project-locally at:

Phosphene 是符合 Artemis 插件规范的插件，可作为项目本地插件安装在：

```text
plugins/phosphene/
```

Current Artemis package builds include `plugins/**`, so a preinstalled copy can also live inside the Artemis source package at:

当前 Artemis 包发布配置会包含 `plugins/**`，所以也可以把预装版本放在 Artemis 源码包内：

```text
/Users/goat/AntiClaude/Artemis Code/plugins/phosphene/
```

Artemis plugin persistence / Artemis 插件持久化：

- state / 状态：`.artemis/phosphene-state.json`
- dream archive / 梦境档案：`.artemis/dreams/`
- automation plugin / 自动化插件：`plugins/phosphene/`
- plugin manifest / 插件清单：`plugins/phosphene/.artemis-plugin/plugin.json`

Useful commands / 常用命令：

```bash
plugins exec phosphene high
plugins exec phosphene high code
plugins exec phosphene high off
plugins exec phosphene high-status
plugins exec phosphene doctor
plugins exec phosphene bootstrap
plugins exec phosphene status
plugins exec phosphene visual-status
plugins exec phosphene dream-status
plugins exec phosphene dream-force
plugins exec phosphene gallery
plugins exec phosphene soul-preview
plugins exec phosphene soul-uninstall
```

`soul-preview` / `soul-install` are optional global identity changes. They manage only a marked Phosphene block, and `soul-uninstall` removes that block without touching the rest of `~/.artemis/soul.md`.

`soul-preview` / `soul-install` 是可选的全局身份修改，只管理带标记的 Phosphene 区块；`soul-uninstall` 只删除这个区块，不影响 `~/.artemis/soul.md` 其它内容。

`visual-status` checks whether Artemis itself has a configured visual/image model. Phosphene does **not** ask for a second plugin API key.

`visual-status` 会检查 Artemis 自己是否已经配置视觉 / 图片模型。Phosphene **不会**要求用户为插件重复配置 API key。

If no Artemis visual model is configured, the Phosphene dream daemon does not start.

如果 Artemis 没有配置视觉模型，Phosphene 做梦系统不会启动。

```bash
plugins exec phosphene visual-status
```

Expected missing-model behavior / 未配置模型时的预期行为：

```text
Visual model: missing
Dreams: disabled until Artemis has a visual/image provider configured
```

---

## 3. Dreams / 做梦系统

Dreams are generated from accumulated session history: crystallized insights, signal patterns, emergent voices, presets, and idle cadence.

梦境来自长期会话积累：结晶洞察、信号模式、涌现声音、感知预设和空闲节奏。

Natural language / 自然语言：

```text
Dream.
What did you dream?
把最后一个梦境的图发给我。
```

Artemis commands / Artemis 命令：

```bash
plugins exec phosphene dream-status
plugins exec phosphene dream-force
plugins exec phosphene gallery
```

Dream image generation is delegated to Artemis' own `generate_image` visual tool and writes local files into the dream archive.

梦境图片生成会统一调用 Artemis 自己的 `generate_image` 视觉工具，并把本地图片写入梦境档案。

No duplicate API keys / 不重复配置密钥：

- configure visual providers in Artemis / 在 Artemis 内配置视觉模型
- Phosphene only detects and calls that bridge / Phosphene 只检测并调用这座桥
- if the bridge is missing, dreams stay asleep / 如果桥不存在，梦境系统保持关闭

---

## 4. Complete command reference / 完整命令表

Most users only need `/high` and `/high off`. The commands below are for power users, debugging, publishing, or cleanup.

大多数用户只需要 `/high` 和 `/high off`。下面这些命令给高级玩家、调试、发布和清理使用。

### Daily use / 日常使用

| Goal | Command | 中文说明 |
|---|---|---|
| Enter high mode | `plugins exec phosphene high` | 进入默认高感知模式，等价于 `/high` |
| Exit high mode | `plugins exec phosphene high off` | 退出高感知模式，等价于 `/high off` |
| Check high mode | `plugins exec phosphene high-status` | 查看 `/high` 是否开启 |
| Gentle mode | `plugins exec phosphene high subtle` | 轻度增强，适合日常对话 |
| Code mode | `plugins exec phosphene high code` | 架构、代码审查、风险识别 |
| Design mode | `plugins exec phosphene high design` | 视觉、UX、审美判断 |
| Research mode | `plugins exec phosphene high research` | 资料综合、证据与不确定性 |
| Review mode | `plugins exec phosphene high review` | 批判审查、找问题 |
| Writing mode | `plugins exec phosphene high writing` | 写作、修辞、文本质感 |
| Ideation mode | `plugins exec phosphene high ideation` | 发散创意、跨域连接 |
| Deep mode | `plugins exec phosphene high deep` | 强增强，默认映射到 `deep-flux` |

### Workspace and diagnostics / 工作区与诊断

| Goal | Command | 中文说明 |
|---|---|---|
| Validate install | `plugins exec phosphene doctor` | 检查插件目录和脚本是否完整 |
| Initialize state | `plugins exec phosphene bootstrap` | 初始化 `.artemis/phosphene-state.json` 和梦境目录 |
| Show state | `plugins exec phosphene status` | 查看工作区状态、梦境目录和心跳信息 |
| Record heartbeat | `plugins exec phosphene heartbeat` | 记录活动心跳，供梦境节奏判断 |
| Check visual model | `plugins exec phosphene visual-status` | 检查 Artemis 是否配置视觉 / 图片模型 |

### Dreams / 做梦系统

| Goal | Command | 中文说明 |
|---|---|---|
| Dream status | `plugins exec phosphene dream-status` | 查看做梦系统状态，不生成新梦 |
| Force dream | `plugins exec phosphene dream-force` | 立即生成一个梦境 |
| Force dream with options | `plugins exec phosphene dream-force --text-only` | 只生成文本梦境，不生成图片 |
| Gallery | `plugins exec phosphene gallery` | 重新生成本地梦境画廊 |

### Optional global soul integration / 可选全局 soul 集成

These commands are not required for `/high`. They are for users who explicitly want Phosphene to become part of the persistent Artemis local soul.

这些命令不是 `/high` 必需项。只有当用户明确希望 Phosphene 成为 Artemis 持久本地 soul 的一部分时才使用。

| Goal | Command | 中文说明 |
|---|---|---|
| Preview soul block | `plugins exec phosphene soul-preview` | 只预览，不写入 |
| Check soul block | `plugins exec phosphene soul-status` | 检查是否已安装 Phosphene soul 区块 |
| Install soul block | `plugins exec phosphene soul-install` | 明确授权后写入 `~/.artemis/soul.md` 的标记区块 |
| Remove soul block | `plugins exec phosphene soul-uninstall` | 只删除 Phosphene 标记区块，不影响其它内容 |

The soul block is bounded by markers:

该 soul 区块有明确边界：

```md
<!-- phosphene:artemis-soul:start -->
...
<!-- phosphene:artemis-soul:end -->
```

---

## 5. Uninstall and cleanup / 卸载与清理

Phosphene has three levels of removal. Choose the smallest one that matches what you want.

Phosphene 有三层卸载方式。按你的目标选择最小的一种即可。

### A. Turn it off only / 只关闭当前模式

Use this when you want Artemis back to normal but want to keep the plugin installed.

如果只是想让 Artemis 恢复正常，但保留插件，用这个：

```bash
plugins exec phosphene high off
```

This only changes `.artemis/phosphene-state.json` in the current workspace.

这只会修改当前工作区的 `.artemis/phosphene-state.json`。

### B. Remove workspace state / 删除当前工作区状态

Use this when you want to reset the current project but keep the plugin files.

如果想重置当前项目，但保留插件文件，用这个：

```bash
rm -f .artemis/phosphene-state.json
rm -rf .artemis/dreams
```

Optional local test artifacts:

可选清理本地测试产物：

```bash
rm -rf .artemis/hallucination-tests
rm -f tmp-artemis-test.png
find . -name '.DS_Store' -delete
```

### C. Fully uninstall from a workspace / 从某个工作区完全卸载

Run from the Artemis workspace that contains `plugins/phosphene/`:

在包含 `plugins/phosphene/` 的 Artemis 工作区执行：

```bash
plugins exec phosphene high off || true
plugins exec phosphene soul-uninstall || true
rm -f .artemis/phosphene-state.json
rm -rf .artemis/dreams
rm -rf plugins/phosphene
```

This removes the workspace plugin and state. It does not delete unrelated Artemis files.

这会删除当前工作区的插件和状态，不会删除 Artemis 其它无关文件。

### D. Fully uninstall the preinstalled Artemis copy / 删除 Artemis 预装副本

If Phosphene was bundled inside the Artemis source tree, remove that copy too:

如果 Phosphene 被预装在 Artemis 源码树里，也可以删除那一份：

```bash
rm -rf "/Users/goat/AntiClaude/Artemis Code/plugins/phosphene"
```

If you previously installed the optional global soul block, remove only that marked block:

如果你之前安装过可选全局 soul 区块，只删除那个标记区块：

```bash
plugins exec phosphene soul-uninstall
```

Manual fallback if the plugin command is already gone:

如果插件命令已经不存在，可以手动删除 `~/.artemis/soul.md` 中这段标记区块：

```md
<!-- phosphene:artemis-soul:start -->
...
<!-- phosphene:artemis-soul:end -->
```

Do not delete the whole `~/.artemis/soul.md` unless you intentionally want to remove all Artemis soul content.

不要删除整个 `~/.artemis/soul.md`，除非你明确想删除 Artemis 的所有 soul 内容。

---

## 6. Dream map / 梦境地图

Open:

打开：

```text
dream-viz.html
```

Paste `.artemis/phosphene-state.json`, then drag dream markdown files and their generated images from `.artemis/dreams/` into the page.

粘贴 `.artemis/phosphene-state.json`，然后把 `.artemis/dreams/` 里的梦境 Markdown 和生成图片拖进页面。

The page is local-only. It does not call image APIs. It only visualizes state and renders already-generated local/remote dream image paths.

该页面只在本地运行，不调用图片 API；它只负责展示状态，以及渲染已经生成好的本地 / 远程梦境图片路径。

---

## 7. Claude Code / Claude Code

```bash
git clone https://github.com/DouGie0420/phosphene.git
cp -r phosphene/ path/to/your/project/skills/
```

Claude Code discovers `SKILL.md` automatically on session start.

Claude Code 会在会话开始时自动发现 `SKILL.md`。

---

## 8. Hermes Agent / Hermes Agent

```bash
git clone https://github.com/DouGie0420/phosphene.git
cp -r phosphene/ ~/.hermes/skills/
cp -r phosphene/hooks/phosphene-awakening/    ~/.hermes/hooks/
cp -r phosphene/hooks/phosphene-dream/        ~/.hermes/hooks/
cp -r phosphene/hooks/phosphene-session-stop/ ~/.hermes/hooks/
```

State, evolution history, and dreams persist across sessions.

状态、演化历史和梦境会跨会话保留。

---

## 9. How to use it / 使用方式

You do not need to remember commands. Talk naturally.

不需要记命令，直接自然语言交流即可。

Switch perception / 切换感知：

```text
Go deeper.
Full dissolution.
I need to think clearly — come back.
blend writing code 0.3
```

Feedback / 反馈：

```text
刚好 / perfect / calibrate
太多了 / too much / reduce
不够 / not enough / amplify
crystallize          ← distill this into something I can act on
remember this        ← anchor it permanently
```

Design / 设计：

```text
I want something minimal, luxury, slightly Japanese.
Give me CSS tokens for this.
```

Market / 市场：

```text
BTCUSDT has been consolidating. What's the structure?
phosphene market-read --live --audit "BTC has been consolidating. Give me structure, liquidity, and source freshness."
```

---

## 10. Developer install / 开发者安装

```bash
git clone https://github.com/DouGie0420/phosphene.git
cd phosphene
npm install
npm run build
npm link
```

Useful checks / 常用验证：

```bash
npm run lint
npm test
npm run build
npm run test:artemis-plugin
```

---

## More / 更多

- Full system / 完整系统：`SKILL.md`
- Plugin manifest / 插件清单：`.artemis-plugin/plugin.json`
- Dream archive guide / 梦境档案说明：`dreams/README.md`
- Philosophy / 哲学说明：`docs/the-glass-that-changes.md`
- Calibration / 校准：`docs/calibration.md`
