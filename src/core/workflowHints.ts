/**
 * Workflow hints — playbooks injected for one turn, then the normal tool loop
 * runs under the Artemis execution protocol.
 *
 * Users never pick these by name any more: core/workflowRouter.ts chooses one
 * from the request (or the model switches with the use_workflow tool). The
 * internal names (niko, athena, contest, nidhogg, design) are kept by user
 * request — they have personal significance — but never shown as commands.
 * The design playbook lives in the design-workflow skill
 * (skills/design-workflow/SKILL.md).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
      return `${baseHeader}\n\n${loadDesignWorkflowSkill()}\n\n${DesignSystem.buildDesignWorkflowPrompt(context.userPrompt)}`;
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
9. 工作流（深度规划 / 并行分工 / 多方案对比 / 设计）由 Artemis 按任务自动选择，用户不需要也不会输入工作流名；任务中途发现比预想复杂时可调用 use_workflow 切换。子代理数量受预算限制，超出会被拒绝；不要伪造未运行的 critic/judge 结果
10. 任务结束最多两句话总结：做了什么 + 文件在哪。不要罗列每一步——清单和工具结果已经记录在案`;

const DESIGN_SKILL_FALLBACK = `\
[设计工作流]
网站/UI/视觉前端任务：先列内容事实清单（禁止虚构），建立视觉系统与资产清单，真实生成配图，实现页面，
最后用 browser_navigate + browser_screenshot 做桌面与手机视口验收；截图失败时如实说明视觉验收未完成。`;

let designSkillCache: string | undefined;

/** The design playbook from skills/design-workflow/SKILL.md (front matter removed). */
export function loadDesignWorkflowSkill(): string {
  if (designSkillCache !== undefined) return designSkillCache;
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.resolve(here, '../../skills/design-workflow/SKILL.md'),
    path.resolve(process.cwd(), 'skills/design-workflow/SKILL.md'),
  ]) {
    try {
      const body = readFileSync(candidate, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
      if (body) {
        designSkillCache = `[当前任务模式：设计工作流（视觉/前端工程），来自 design-workflow 技能]\n${body.replace(/^#[^\n]*\n+/, '')}`;
        return designSkillCache;
      }
    } catch {
      // try the next location
    }
  }
  designSkillCache = DESIGN_SKILL_FALLBACK;
  return designSkillCache;
}

const NIKO_HINT = `\
[当前任务模式：深度规划（研究 → 方案 → 实现 → 验证）]
偏向需要先研究、分析、再动手的任务（codebase 改造、复杂迁移、性能优化、bug 调查）。本模式下你应该：

• 先用 read/search 工具摸清现状——项目结构、相关文件、关键函数
• 第三方协议/API 问题要并行查外部资料：search_web / lookup_docs / 上游源码，优先找枚举常量、payload type、字段名、SDK 实现；本地日志只能说明现象，不能替代协议事实
• 复杂研究可以派 1 个 read-only 子代理做并行 explore（"找所有 X 的调用点并汇总"）
• 风险较高的改动可以派 1 个 reviewer 子代理（delegate_task）做独立评审，把它的问题清单当作待办逐条处理（子代理合计不超过预算）
• 用 todo 列出"研究→方案→实现→验证"的步骤；研究阶段不写代码，但**研究完直接进入实现**，不要写文档
• 实现阶段：边写边验证（每改一个模块就跑一次相关测试 / 编译）
• 风险点要写在 todo 里显式追踪（"X 改动可能影响 Y"）
• 改动幅度小用 replace_in_file；改动幅度大用 write_file；批量改用 run_command + sed/awk
• 任务结束给出"改了哪些文件 + 验证结果 + 已知未覆盖风险"`;

const ATHENA_HINT = `\
[当前任务模式：并行分工（大范围多切片执行）]
偏向"对一批文件/模块做相同/类似改动"或"实现一个有多个独立子模块的特性"。本模式下你应该：

• 先用 list_files / search_files 圈定 scope——目标是哪些文件、哪些模块
• 用 todo 把工作切成可独立执行的"切片"（每个切片改一个文件/模块）
• 没有依赖的切片**强烈建议并行**：同一回合里发多个 write_file/replace_in_file 工具调用
• 单个切片实现完立即验证（编译/单测）；不要全部写完再统一编译
• 切片之间出现冲突或共享代码时，先抽公共部分一次写完，再处理各切片
• 进度可视：每完成一个切片更新对应 todo
• 真正独立、较大的切片可以交给子代理（delegate_task）并行实现，其余切片自己在同一回合并行改；子代理总数不超过预算（最多 4 个）
• 切片全部完成后，可以派 1 个 reviewer 子代理对整体改动做一致性评审

🚫 禁止：先生成"提案"等用户审批`;

const NIDHOGG_HINT = `\
[当前任务模式：Nidhogg Harness Engineering 高质量交付]
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

🚫 禁止：先研究后写设计文档再实现；read-only 子代理被要求"输出完整代码"`;

const CONTEST_HINT = `\
[当前任务模式：多方案对比（候选 → 评审 → 裁决 → 实现）]
偏向"有多种可行方案，需要先比较再选最优"的任务（架构选型、技术栈选择、复杂算法）。本模式下你应该：

• 第一步：自己快速列出 2-3 个候选方案（最多 3 个；每个方案一段话：思路、优势、风险）
• 用 todo 把"方案A调研""方案B调研""评审""选型决定""执行选定方案"列出来
• 简单评估自己一回合内完成；只有复杂、高风险的评估才派子代理并行调研或评审（每个候选最多 1 个，合计不超过预算）
• 评审只做一轮：reviewer / critic 挑出各候选的毛病后，由你根据证据裁决，不要反复辩论
• 裁决后立即执行选定方案
• 输出报告要包含：候选方案对比、评审意见、选定理由、最终实现

🚫 禁止：让 read-only 子代理"输出胜出方案的完整代码"`;

const WORKFLOW_NOTE_LABELS: Record<WorkflowMode, string> = {
  direct: '默认对话',
  niko: '深度规划',
  athena: '并行分工',
  contest: '多方案对比',
  design: '设计',
  nidhogg: 'Nidhogg',
};

/**
 * Workflow-completion summary text — appended to the system prompt suffix
 * after a workflow ends so subsequent free-form turns know where to look.
 */
export function buildWorkflowCompletionNote(
  mode: WorkflowMode,
  outputDir?: string,
): string {
  const modeLabel = mode === 'direct' ? '默认对话' : WORKFLOW_NOTE_LABELS[mode];
  if (!outputDir) return `\n\n[最近工作流] 模式: ${modeLabel}, 未产生新文件。`;
  return `\n\n[最近工作流] 模式: ${modeLabel}, 输出目录: ${outputDir}。用户后续若需检查或修改，请在该目录操作。`;
}
