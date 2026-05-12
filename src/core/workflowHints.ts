/**
 * Workflow hints — replaces the old phase-based pipeline with a flexible
 * "inject domain hint into brain system prompt, then run normal tool loop".
 *
 * Each /slashcommand (niko, athena, nidhogg, design, contest) now becomes a
 * domain-specific bias the brain reads at the top of its system prompt. The
 * brain's regular 24-round tool loop handles execution under the Artemis execution protocol.
 *
 * Names are preserved by user request — they have personal significance.
 */

import type { WorkflowMode } from './workflowMode.js';
import { DesignSystem } from '../design/index.js';

export interface WorkflowHintContext {
  cwd: string;
  userPrompt: string;
}

/**
 * Build a domain hint for a specific workflow mode. Returned text is appended
 * to the brain's system prompt suffix for the duration of the turn, then
 * cleared once the turn completes.
 */
export function buildWorkflowHint(
  mode: WorkflowMode,
  context: WorkflowHintContext,
): string {
  const baseHeader = COMMON_AGENT_PROTOCOL;

  switch (mode) {
    case 'design':
      return `${baseHeader}\n\n${DESIGN_HINT}\n\n${DesignSystem.buildDesignWorkflowPrompt(context.userPrompt)}`;
    case 'niko':
      return `${baseHeader}\n\n${NIKO_HINT}`;
    case 'athena':
      return `${baseHeader}\n\n${ATHENA_HINT}`;
    case 'nidhogg':
      return `${baseHeader}\n\n${NIDHOGG_HINT}`;
    case 'contest':
      return `${baseHeader}\n\n${CONTEST_HINT}`;
    case 'direct':
    default:
      return baseHeader;
  }
}

/**
 * Shared agent protocol — the Artemis execution rules every
 * workflow inherits. This is what differentiates the new model from the old
 * pipeline approach: the brain decides *every* step based on task state.
 */
const COMMON_AGENT_PROTOCOL = `\
[执行协议]
你是一个能直接调用工具完成任务的 agent，工作方式遵循 Artemis 执行协议：

1. 任务理解 → 用一句话告诉用户即将做什么 → 直接调工具动手（不要先讨论再动手）
2. 复杂任务（≥3 步）开局先输出一份"任务清单"，格式如下，并在每步之间更新它：
   \`\`\`
   - [ ] 步骤一
   - [-] 步骤二（进行中）
   - ✅ 步骤三（已完成）
   \`\`\`
   完成一项立即划掉，不要憋到最后批量勾
3. 没有依赖的工具调用一律并行（同一回合发多个工具调用），有依赖才串行
4. 遇到不明确的本地路径/文件先用 read/list 工具自查；不要让用户去跑 cat/ls/grep
5. 写代码时优先 replace_in_file 做局部改动；新建文件或整文件重写才用 write_file
6. 修改后必须运行验证（编译/测试/启服务），看不到工具结果不得声称完成
7. 子任务可以让 deep_research 工具去做并行调研（它在 worker 模型上跑，便宜快速），不要把简单的 read 任务也往那扔
8. 外部协议/API/SDK/gateway 类 bug（例如微信/Telegram/Discord/CDN/webhook/第三方 schema）必须先把本地日志与权威外部资料对照：官方文档、上游 SDK 源码、协议枚举、raw type 定义。不要只在本地代码里反复猜字段；优先核对数字常量、字段名、鉴权/会话、大小/md5/缩略图等硬事实
9. 在提示注入路径里，/niko /athena /design /contest 是任务风格指示；/nidhogg 的正式入口是后台 harness runner。若这里收到 nidhogg，只做自审和验证，不要伪造未运行的 critic/judge 结果
10. 任务结束最多两句话总结：做了什么 + 文件在哪。不要罗列每一步——清单和工具结果已经记录在案`;

const DESIGN_HINT = `\
[当前任务模式：/design 视觉/前端工程]
偏向网页、UI、品牌视觉、交互、动画类任务。本模式下你应该：

• 先确认/创建工作目录（如用户提到 "桌面/futuretest" 之类，先 mkdir + run_command 切换工作区）
• 用 todo 拆解：事实来源/信息架构、资产清单、风格系统、页面实现、响应式、视觉验收、收尾
• 开始前先列"内容事实清单"：用户明确给了什么、代码库/README 里能确认什么、哪些未知。未知内容不得补成事实
• **禁止虚构**：不要编产品名、指标、命令、安装地址、版本号、团队规模、社交链接、年份和路线图。用户只给 Artemis CLI 时，不要捏造 Nyx/Styx/Aether 这类产品；可以做"产品/项目待补充"或只介绍 Artemis
• **生图与代码并行**：先写任务专属资产 manifest（画幅、用途、主体、风格、验证），再调 generate_image，同时写 HTML/CSS/JS
• **视觉 prompt 必须动态生成**：每次从用户原文和项目事实中提取本轮主体、用途、受众、风格、构图、材质、光线、画幅、禁止项，再组成 generate_image/generate_video 的 prompt；不要套用固定题材词表、固定业务关键词或历史任务关键词
• 配图要求默认 ≥3 张本地生成（hero、section background、细节素材）；若 generate_image 失败，必须明确降级，并且最终不能写"配图就绪/全部验证通过"
• HTML 用语义化标签；CSS 用现代特性（grid/flex/clamp/aspect-ratio/container query 可用则用）；JS 只处理真实交互，不堆装饰脚本
• 不允许写出空 styles.css 或仅有 reset 的 CSS；每个 section 都要有真正的视觉处理、明确层级和响应式状态
• 不允许写"// TODO"、"占位文案"、href="#"、假按钮、不可达导航；所有内容必须来自用户主题或明确标注为待补充
• 配色/字体/间距要形成系统：定义 CSS 变量集中管理，不要散在各处硬编码；核心布局不要靠大量 inline style
• 用户要求"高级感/电影质感/迷幻艺术/高奢/孤傲/科技感"时，要翻译为可执行设计技法：负空间、材料质感、光源方向、低饱和灰阶、精细网格、尺度反差、慢动效、弱装饰、强首屏主体；不要落成普通 SaaS 卡片堆
• 网站/应用的第一屏必须立刻表现品牌/产品/主题，不要只有口号和泛背景；移动端不能遮挡、溢出或变成散乱长文
• 写完必须做真实验收：启动服务后至少 browser_navigate + browser_screenshot 桌面视口和手机视口；HTTP 200、文件存在、curl 成功都不是视觉验收
• 截图/浏览器失败时，必须继续用可行替代动作恢复；仍失败则在最终说明"视觉验收未完成"，不得写"全部验证通过"
• 最终报告只写：文件位置、运行地址、实际验证证据、未验证风险；不要把清单重复成长报告

🚫 禁止：先开 critic/judge 子代理评审再执行；先写"设计文档"再写代码；只写一个 index.html 凑数；用模板化营销文案冒充品牌设计；用假数据填满页面`;

const NIKO_HINT = `\
[当前任务模式：/niko 深度研究 + 工程实现]
偏向需要先研究、分析、再动手的任务（codebase 改造、复杂迁移、性能优化、bug 调查）。本模式下你应该：

• 先用 read/search 工具摸清现状——项目结构、相关文件、关键函数
• 第三方协议/API 问题要并行查外部资料：search_web / lookup_docs / 上游源码，优先找枚举常量、payload type、字段名、SDK 实现；本地日志只能说明现象，不能替代协议事实
• 复杂研究可以 spawn 一个 read-only 子代理做并行 explore（"找所有 X 的调用点并汇总"）
• 用 todo 列出"研究→方案→实现→验证"的步骤；研究阶段不写代码，但**研究完直接进入实现**，不要写文档
• 实现阶段：边写边验证（每改一个模块就跑一次相关测试 / 编译）
• 风险点要写在 todo 里显式追踪（"X 改动可能影响 Y"）
• 改动幅度小用 replace_in_file；改动幅度大用 write_file；批量改用 run_command + sed/awk
• 任务结束给出"改了哪些文件 + 验证结果 + 已知未覆盖风险"

🚫 禁止：先开多个评审 phase（researcher/risk/architect/QA/synthesis）再 execute——你一个循环里全包了`;

const ATHENA_HINT = `\
[当前任务模式：/athena 大范围并行执行]
偏向"对一批文件/模块做相同/类似改动"或"实现一个有多个独立子模块的特性"。本模式下你应该：

• 先用 list_files / search_files 圈定 scope——目标是哪些文件、哪些模块
• 用 todo 把工作切成可独立执行的"切片"（每个切片改一个文件/模块）
• 没有依赖的切片**强烈建议并行**：同一回合里发多个 write_file/replace_in_file 工具调用
• 单个切片实现完立即验证（编译/单测）；不要全部写完再统一编译
• 切片之间出现冲突或共享代码时，先抽公共部分一次写完，再处理各切片
• 进度可视：每完成一个切片更新对应 todo

🚫 禁止：先生成"提案"等用户审批；先开 planner/builder/reviewer/arbiter 多 phase——你一个循环里全包了`;

const NIDHOGG_HINT = `\
[当前任务模式：/nidhogg Harness Engineering 高质量交付]
偏向"做出来的东西必须正确、健壮、能上生产"。本模式下你应该：

• 把仓库内 ARTEMIS.md、README、docs、测试、schema、现有实现当作事实来源；不要把长提示当百科全书
• 先设计任务 harness：哪些静态检查、单测/集成测试、运行时 smoke、日志/指标、截图/视觉证据能真正证明没坏
• todo 必须包含验证步骤（不能只列实现项）
• 实现完成后做一轮"自我审查"：用 read 重读自己写的关键文件，找逻辑漏洞、边界情况、错误处理缺口
• 必要时 spawn 一个 read-only 子代理做独立 review（让它返回"问题清单 JSON"，不要让它改代码、不要污染主上下文）
• 用确定性约束优先：现有脚本、lint、类型检查、权限限制、架构边界和测试输出，比"看起来没问题"更可信
• 写测试覆盖关键路径——不要只写 happy path
• 生产相关代码：错误处理、超时、重试、日志要齐
• 任务结束的报告要诚实：改了什么、跑了什么 harness、哪些已验证、哪些没验证、有什么已知风险

🚫 禁止：先开 critic/judge 子代理评审一个还不存在的方案；先研究后写设计文档再实现；read-only 子代理被要求"输出完整代码"`;

const CONTEST_HINT = `\
[当前任务模式：/contest 多方案竞标]
偏向"有多种可行方案，需要先比较再选最优"的任务（架构选型、技术栈选择、复杂算法）。本模式下你应该：

• 第一步：自己快速列出 2-3 个候选方案（每个方案一段话：思路、优势、风险）
• 用 todo 把"方案A调研""方案B调研""选型决定""执行选定方案"列出来
• 简单评估可以自己一回合内完成；复杂评估可以 spawn 2-3 个 read-only explore 子代理并行调研，回来后你做综合判断
• 选定方案后立即执行——不要再开 arbiter 子代理"裁决"
• 输出报告要包含：候选方案对比、选定理由、最终实现

🚫 禁止：先开 planner/researcher/reviewer/arbiter 四 phase 流水线；让 read-only 子代理"输出胜出方案的完整代码"`;

/**
 * Workflow-completion summary text — appended to the system prompt suffix
 * after a workflow ends so subsequent free-form turns know where to look.
 */
export function buildWorkflowCompletionNote(
  mode: WorkflowMode,
  outputDir?: string,
): string {
  const modeLabel = mode === 'direct' ? '默认对话' : `/${mode}`;
  if (!outputDir) return `\n\n[最近工作流] 模式: ${modeLabel}, 未产生新文件。`;
  return `\n\n[最近工作流] 模式: ${modeLabel}, 输出目录: ${outputDir}。用户后续若需检查或修改，请在该目录操作。`;
}
