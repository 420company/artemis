import type { WorkflowMode } from '../core/workflowMode.js';
import { pickLocale, type UiLocale } from './locale.js';
import { ANSI, color, stripAnsi } from './ui.js';

type WorkflowStageStatus = 'pending' | 'active' | 'done';

const MAX_EVENTS_PER_STAGE = 64;
const MAX_NOTES_PER_STAGE = 8;

type ToolEvent = {
  tool: string;
  ok: boolean;
  path?: string;
  files?: string[];
  command?: string;
  exit?: number;
  bytes?: number;
  lines?: number;
  range?: string;
  pattern?: string;
  query?: string;
  role?: string;
  task?: string;
  prompt?: string;
  reason?: string;
  // Diff fields. Renderer shows `removed` lines with a `-` marker (red) and
  // `added` lines with a `+` marker (green), Claude-style. `patch` carries a
  // unified-diff blob whose internal +/-/space markers are preserved verbatim.
  added?: string;
  removed?: string;
  patch?: string;
  added_lines?: number;
  removed_lines?: number;
  at_line?: number;
  position?: string;
  // Tail of stdout/stderr for run_command, rendered as plain indented text.
  output_head?: string;
};

type WorkflowStage = {
  id: string;
  label: string;
  status: WorkflowStageStatus;
  startedAtMs?: number;
  endedAtMs?: number;
  promptTokens: number;
  completionTokens: number;
  notes: string[];
  events: ToolEvent[];
  latestReply?: string;
  // Live model output for the in-flight turn. Filled as `[stream-chunk]`
  // events arrive, cleared when the JSON envelope is parsed (we know that
  // happened when `[reply]` arrives). Renders as a "正在生成..." code block
  // under the active stage so the user sees the model write in real time.
  liveStream?: string;
};

export type WorkflowProgressState = {
  mode: WorkflowMode;
  locale: UiLocale;
  label: string;
  startedAtMs: number;
  note: string;
  warnings: string[];
  stages: WorkflowStage[];
  specialistCompletion: Record<string, boolean>;
};

const FACE_SPINNER_FRAMES = ['◔_◔', '◉_◉', '◑_◐', '◕_◕', '◔_◔', '◡_◡', '•_•', '◠_◠', '◔_◔'] as const;
const BRAILLE_SPINNER_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'] as const;

function makeStage(
  id: string,
  label: string,
  status: WorkflowStageStatus,
  startedAtMs?: number,
): WorkflowStage {
  return {
    id,
    label,
    status,
    startedAtMs: status === 'active' ? (startedAtMs ?? Date.now()) : undefined,
    promptTokens: 0,
    completionTokens: 0,
    notes: [],
    events: [],
  };
}

function createStages(mode: WorkflowMode, locale: UiLocale): WorkflowStage[] {
  const l = (zh: string, en: string): string => pickLocale(locale, { zh, en });
  const now = Date.now();

  switch (mode) {
    case 'niko':
      return [
        makeStage('boot', l('启动工作流', 'Boot workflow'), 'active', now),
        makeStage('research', l('研究与风险检查', 'Research + risk review'), 'pending'),
        makeStage('synthesis', l('综合建议', 'Synthesize recommendation'), 'pending'),
        makeStage('execute', l('落地执行', 'Execute in workspace'), 'pending'),
      ];
    case 'design':
      return [
        makeStage('boot', l('启动工作流', 'Boot workflow'), 'active', now),
        makeStage('art', l('艺术指导', 'Art direction'), 'pending'),
        makeStage('layout', l('排版系统', 'Layout system'), 'pending'),
        makeStage('assets', l('视觉资产', 'Visual assets'), 'pending'),
        makeStage('polish', l('设计升级', 'Design polish'), 'pending'),
        makeStage('synthesis', l('整合设计合同', 'Synthesize design contract'), 'pending'),
        makeStage('execute', l('实现设计', 'Implement design'), 'pending'),
      ];
    case 'contest':
      return [
        makeStage('boot', l('启动工作流', 'Boot workflow'), 'active', now),
        makeStage('proposal', l('构建候选路径', 'Shape candidate path'), 'pending'),
        makeStage('verdict', l('裁决执行路径', 'Select execution path'), 'pending'),
        makeStage('execute', l('落地选中路径', 'Execute selected path'), 'pending'),
      ];
    case 'athena':
      return [
        makeStage('boot', l('启动工作流', 'Boot workflow'), 'active', now),
        makeStage('research', l('切片研究', 'Slice research'), 'pending'),
        makeStage('proposal', l('收集构建提案', 'Collect builder proposals'), 'pending'),
        makeStage('execute', l('主协调执行', 'Run coordinated execution'), 'pending'),
      ];
    case 'nidhogg':
      return [
        makeStage('boot', l('启动工作流', 'Boot workflow'), 'active', now),
        makeStage('generate', l('锻造实现候选', 'Forge implementation'), 'pending'),
        makeStage('critique', l('批评团与收敛评估', 'Critic gauntlet + convergence'), 'pending'),
        makeStage('synthesis', l('综合硬化结果', 'Synthesize hardening result'), 'pending'),
      ];
    default:
      return [
        makeStage('boot', l('启动工作流', 'Boot workflow'), 'active', now),
        makeStage('work', l('处理中', 'Processing'), 'pending'),
        makeStage('finish', l('收尾输出', 'Finalize output'), 'pending'),
      ];
  }
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function buildProgressBar(
  completedStages: number,
  totalStages: number,
  hasActiveStage: boolean,
  width = 18,
): string {
  const ratio = totalStages <= 0
    ? 0
    : Math.min(1, (completedStages + (hasActiveStage ? 0.45 : 0)) / totalStages);
  const filled = Math.max(0, Math.min(width, Math.floor(ratio * width)));
  const head = hasActiveStage && filled < width ? '>' : '';
  const empty = Math.max(0, width - filled - (head ? 1 : 0));
  return `[${'='.repeat(filled)}${head}${'.'.repeat(empty)}]`;
}

function setActiveStage(
  state: WorkflowProgressState,
  stageId: string,
  note?: string,
): void {
  const targetIndex = state.stages.findIndex((stage) => stage.id === stageId);
  if (targetIndex === -1) {
    if (note) {
      state.note = note;
    }
    return;
  }

  const now = Date.now();
  for (let index = 0; index < state.stages.length; index += 1) {
    const stage = state.stages[index]!;
    if (index < targetIndex) {
      if (stage.status !== 'done') {
        stage.status = 'done';
        if (stage.endedAtMs === undefined) {
          stage.endedAtMs = now;
        }
      }
      continue;
    }
    if (index === targetIndex) {
      if (stage.status !== 'active') {
        stage.status = 'active';
        if (stage.startedAtMs === undefined) {
          stage.startedAtMs = now;
        }
      }
      continue;
    }
    if (stage.status !== 'done') {
      stage.status = 'pending';
    }
  }

  if (note) {
    state.note = note;
  }
}

function getActiveStage(state: WorkflowProgressState): WorkflowStage | undefined {
  return state.stages.find((stage) => stage.status === 'active');
}

function pushStageEvent(stage: WorkflowStage, event: ToolEvent): void {
  // De-dupe consecutive identical tool calls (same tool + same path/command).
  const last = stage.events[stage.events.length - 1];
  if (
    last &&
    last.tool === event.tool &&
    last.ok === event.ok &&
    last.path === event.path &&
    last.command === event.command &&
    last.query === event.query
  ) {
    return;
  }
  stage.events.push(event);
  if (stage.events.length > MAX_EVENTS_PER_STAGE) {
    stage.events.splice(0, stage.events.length - MAX_EVENTS_PER_STAGE);
  }
}

function pushStageNote(stage: WorkflowStage, note: string): void {
  const normalized = note.trim();
  if (!normalized) {
    return;
  }
  const last = stage.notes[stage.notes.length - 1];
  if (last === normalized) {
    return;
  }
  stage.notes.push(normalized);
  if (stage.notes.length > MAX_NOTES_PER_STAGE) {
    stage.notes.splice(0, stage.notes.length - MAX_NOTES_PER_STAGE);
  }
}

export function createWorkflowProgressState(
  mode: WorkflowMode,
  label: string,
  locale: UiLocale,
): WorkflowProgressState {
  return {
    mode,
    locale,
    label,
    startedAtMs: Date.now(),
    note: pickLocale(locale, {
      zh: `正在启用 ${label}，请稍候…`,
      en: `Starting ${label}. Please wait...`,
    }),
    warnings: [],
    stages: createStages(mode, locale),
    specialistCompletion: {},
  };
}

function pushWarning(state: WorkflowProgressState, text: string): void {
  const normalized = text.trim();
  if (!normalized) {
    return;
  }

  if (!state.warnings.includes(normalized)) {
    state.warnings = [...state.warnings.slice(-2), normalized];
  }
}

function trackSpecialistCompletion(
  state: WorkflowProgressState,
  message: string,
): boolean {
  const specialistMatch = message.match(
    /\[(?:niko|design|contest):([a-z0-9:_-]+)\][\s\S]*\bdone\b/i,
  );
  if (!specialistMatch) {
    return false;
  }

  const rawSpecialist = (specialistMatch[1] ?? '').toLowerCase();
  const specialist = rawSpecialist.split(':').at(-1) ?? rawSpecialist;
  if (!specialist) {
    return false;
  }

  state.specialistCompletion[specialist] = true;

  if (state.mode === 'niko' && state.specialistCompletion.researcher && state.specialistCompletion.reviewer) {
    state.note = pickLocale(state.locale, {
      zh: '研究员和评审员都已完成，正在整理建议。',
      en: 'Researcher and reviewer are complete. Preparing the recommendation.',
    });
  }

  return true;
}

function parseUsageMessage(
  message: string,
): { promptTokens?: number; completionTokens?: number } | null {
  if (!message.startsWith('[usage]')) return null;
  const promptMatch = message.match(/\bprompt=(\d+)/);
  const completionMatch = message.match(/\bcompletion=(\d+)/);
  if (!promptMatch && !completionMatch) return null;
  return {
    promptTokens: promptMatch ? Number(promptMatch[1]) : undefined,
    completionTokens: completionMatch ? Number(completionMatch[1]) : undefined,
  };
}

function parseReplyMessage(message: string): string | null {
  if (!message.startsWith('[reply]')) return null;
  const jsonMatch = message.match(/\btext_json=(.+)$/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]!) as unknown;
      return typeof parsed === 'string' ? parsed : null;
    } catch {
      return jsonMatch[1]?.trim() ?? null;
    }
  }
  const textMatch = message.match(/\btext=(.+)$/);
  if (!textMatch) return null;
  return textMatch[1]?.trim() ?? null;
}

function parseExplicitStageNote(
  state: WorkflowProgressState,
  message: string,
): { stageId: string; note: string } | null {
  const designMatch = message.match(/^\[design:(boot|art|layout|assets|asset-agent|asset-planner|asset-gate|polish|synthesis|execute)\]\s+(.+)$/i);
  if (designMatch && state.mode === 'design') {
    const rawStageId = designMatch[1]!.toLowerCase();
    const stageId = rawStageId.startsWith('asset-') ? 'assets' : rawStageId;
    return {
      stageId,
      note: designMatch[2]!.trim(),
    };
  }

  return null;
}

// Specialist wrappers prepend `[niko:reviewer]` / `[agent:reviewer]` /
// `[nidhogg:gen:r1]` etc. to every onInfo message. Strip those leading tags
// so downstream regexes see the original `[tool:xxx] ...` payload — without
// this, blocked/denied tool events fall through to the generic warning bucket
// and end up double-surfaced as both inline log AND a "注意" panel.
const SPECIALIST_PREFIX_RE = /^(?:\[(?:niko|design|contest|athena|nidhogg|agent)(?::[a-z0-9_-]+){0,2}\]\s+)+/i;
function stripSpecialistPrefix(message: string): string {
  return message.replace(SPECIALIST_PREFIX_RE, '');
}

function parseToolEvent(message: string): ToolEvent | null {
  // New format: [tool:write_file] ok {"path":"...", "lines":234}
  // Legacy format: [tool:write_file] ok / [tool:run_command] failed: reason
  // Permission gates: [tool:write_file] blocked by profile policy
  //                   [tool:write_file] denied
  // Simplified format: 写入(catcat/design/visual-system.md) 或 Write(catcat/design/visual-system.md)
  const simplifiedMatch = message.match(/^(写入|Write|插入|Insert|替换|Replace|命令|Bash|读取|Read|列目录|List|搜索|Search|生图|Image|生视频|Video|委托|Delegate|查文档|Docs|深度研究|Research)\((.*)\)/);
  if (simplifiedMatch) {
    let tool = simplifiedMatch[1];
    const arg = simplifiedMatch[2];
    
    // 转换中文标签到英文工具名
    const toolMap: Record<string, string> = {
      '写入': 'write_file',
      'Write': 'write_file',
      '插入': 'insert_in_file',
      'Insert': 'insert_in_file',
      '替换': 'replace_in_file',
      'Replace': 'replace_in_file',
      '命令': 'run_command',
      'Bash': 'run_command',
      '读取': 'read_file',
      'Read': 'read_file',
      '列目录': 'list_files',
      'List': 'list_files',
      '搜索': 'search_files',
      'Search': 'search_files',
      '生图': 'generate_image',
      'Image': 'generate_image',
      '生视频': 'generate_video',
      'Video': 'generate_video',
      '委托': 'delegate_task',
      'Delegate': 'delegate_task',
      '查文档': 'lookup_docs',
      'Docs': 'lookup_docs',
      '深度研究': 'deep_research',
      'Research': 'deep_research'
    };
    
    tool = toolMap[tool] || 'tool';
    
    const event: ToolEvent = { tool, ok: true };
    if (arg && arg.trim()) {
      if (tool === 'write_file' || tool === 'read_file' || tool === 'insert_in_file' || tool === 'replace_in_file') {
        event.path = arg.trim();
      } else if (tool === 'run_command') {
        event.command = arg.trim();
      }
    }
    return event;
  }
  
  const structured = message.match(/^\[tool:([a-z_]+)\]\s+(ok|failed)\s+(\{.*\})$/i);
  if (structured) {
    const tool = structured[1] ?? 'tool';
    const ok = (structured[2] ?? '').toLowerCase() === 'ok';
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(structured[3]!);
    } catch (error) {
      // 
      console.error(`Failed to parse JSON payload in tool event:`, error);
      console.error(`Raw payload:`, structured[3]);
      console.error(`Full message:`, message);
      // ignore parse failures, fall through to plain event
    }
    return { tool, ok, ...(payload as Partial<ToolEvent>) };
  }
  const blocked = message.match(/^\[tool:([a-z_]+)\]\s+(blocked|denied)(?:\s+(.*))?$/i);
  if (blocked) {
    const tool = blocked[1] ?? 'tool';
    const reason = (blocked[3] ?? blocked[2] ?? '').trim();
    return { tool, ok: false, reason: reason || 'blocked' };
  }
  const legacy = message.match(/^\[tool:([a-z_]+)\]\s+(ok|failed)(?::\s*(.*))?$/i);
  if (!legacy) return null;
  const tool = legacy[1] ?? 'tool';
  const ok = (legacy[2] ?? '').toLowerCase() === 'ok';
  const reason = (legacy[3] ?? '').trim();
  const event: ToolEvent = { tool, ok };
  if (!ok && reason) event.reason = reason;
  return event;
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}

// East-Asian wide chars (CJK ideographs, Kana, Hangul, fullwidth forms) take
// up two terminal columns; everything else counts as one. Without this, a
// line that "looks" 60 chars in source can render at 90 columns and wrap.
const WIDE_CHAR_RE =
  /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;

function charWidth(ch: string): number {
  return WIDE_CHAR_RE.test(ch) ? 2 : 1;
}

function clipDisplayWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 1) return text.length === 0 ? '' : '…';
  let used = 0;
  let out = '';
  for (const ch of text) {
    const w = charWidth(ch);
    if (used + w > maxWidth) {
      // Need room for the ellipsis; back off until we can fit it.
      while (out.length > 0 && used + 1 > maxWidth) {
        const last = out[out.length - 1]!;
        used -= charWidth(last);
        out = out.slice(0, -1);
      }
      return out + '…';
    }
    out += ch;
    used += w;
  }
  return out;
}

function wrapDisplayWidth(text: string, maxWidth: number): string[] {
  if (maxWidth <= 1 || stripAnsi(text) !== text) return [text];
  const lines: string[] = [];
  let used = 0;
  let current = '';

  for (const ch of text) {
    const width = charWidth(ch);
    if (current.length > 0 && used + width > maxWidth) {
      lines.push(current);
      current = '';
      used = 0;
    }
    current += ch;
    used += width;
  }

  lines.push(current);
  return lines;
}

function getTerminalWidth(): number {
  const cols = process.stdout?.columns;
  if (typeof cols === 'number' && cols > 0) {
    return Math.max(40, cols);
  }
  return 100;
}

const TOOL_LABELS: Record<string, { en: string; zh: string }> = {
  write_file: { en: 'Write', zh: '写入' },
  insert_in_file: { en: 'Insert', zh: '插入' },
  replace_in_file: { en: 'Replace', zh: '替换' },
  apply_patch: { en: 'Patch', zh: '补丁' },
  run_command: { en: 'Bash', zh: '命令' },
  read_file: { en: 'Read', zh: '读取' },
  list_files: { en: 'List', zh: '列目录' },
  search_files: { en: 'Search', zh: '搜索' },
  generate_image: { en: 'Image', zh: '生图' },
  generate_video: { en: 'Video', zh: '生视频' },
  delegate_task: { en: 'Delegate', zh: '委托' },
  lookup_docs: { en: 'Docs', zh: '查文档' },
  deep_research: { en: 'Research', zh: '深度研究' },
};

function toolLabel(tool: string, locale: UiLocale): string {
  const entry = TOOL_LABELS[tool];
  if (!entry) return tool;
  return pickLocale(locale, { zh: entry.zh, en: entry.en });
}

// Body lines are indented with 7 spaces — same depth as the "⎿  " detail
// line — and carry NO leading `│` character. Diff markers (`-`, `+`, ` `)
// sit right after the indent so the eye reads them as a real diff.
const BODY_INDENT = '       ';

function renderToolEvent(event: ToolEvent, locale: UiLocale): string[] {
  // Edits (replace_in_file/insert_in_file/apply_patch) read more naturally
  // as "Update(file)" because the user thinks of them as a single edit op.
  // write_file is a fresh write (no diff).
  const isUpdate =
    event.tool === 'replace_in_file' ||
    event.tool === 'insert_in_file' ||
    event.tool === 'apply_patch';
  const action = isUpdate
    ? pickLocale(locale, { zh: '更新', en: 'Update' })
    : toolLabel(event.tool, locale);
  const target =
    event.path ??
    (event.files && event.files.length > 0
      ? event.files.length === 1
        ? event.files[0]
        : `${event.files[0]} +${event.files.length - 1}`
      : undefined) ??
    event.command ??
    event.query ??
    event.pattern ??
    (event.role ? `${event.role}: ${event.task ?? ''}` : undefined) ??
    event.prompt;
  const headlineBody = target
    ? `${action}(${truncateText(String(target), 200)})`
    : action;
  const dot = event.ok ? '⏺' : '✗';
  const lines: string[] = [`     ${dot} ${headlineBody}`];

  const detail = buildToolDetail(event, locale);
  if (detail) {
    lines.push(`${BODY_INDENT}⎿  ${detail}`);
  }

  // Diff body: only changed regions, never the full file. Lines marked with
  // `-` for removed (replace_in_file/apply_patch only), `+` for added.
  const bodyLines = renderToolBody(event, locale);
  for (const line of bodyLines) {
    lines.push(`${BODY_INDENT}${line}`);
  }

  return lines;
}

function renderToolBody(event: ToolEvent, locale: UiLocale): string[] {
  // Failures: surface multi-line reasons inline (single-line reasons already
  // appear in the ⎿ detail row).
  if (!event.ok) {
    if (event.reason && event.reason.includes('\n')) {
      return event.reason.split('\n').map((line) => `  ${line}`);
    }
    return [];
  }

  switch (event.tool) {
    case 'write_file':
      // No body for write_file — the summary row already says how many lines
      // and bytes were written. Dumping a 500-line HTML file is pure noise.
      return [];
    case 'replace_in_file': {
      const out: string[] = [];
      if (event.removed) {
        for (const line of event.removed.split('\n')) out.push(`- ${line}`);
      }
      if (event.added) {
        for (const line of event.added.split('\n')) out.push(`+ ${line}`);
      }
      return out;
    }
    case 'insert_in_file': {
      if (!event.added) return [];
      return event.added.split('\n').map((line) => `+ ${line}`);
    }
    case 'apply_patch': {
      if (!event.patch) return [];
      // Unified-diff text already carries +/-/space markers — preserve them
      // and just strip diff headers (---/+++/@@) that are noisy in the UI.
      return event.patch
        .split('\n')
        .filter((line) =>
          !line.startsWith('---') &&
          !line.startsWith('+++') &&
          !line.startsWith('@@') &&
          !line.startsWith('diff '),
        )
        .map((line) => {
          if (line.startsWith('+') || line.startsWith('-')) return line;
          if (line.startsWith(' ')) return line;
          return line.length > 0 ? `  ${line}` : '';
        });
    }
    case 'run_command':
      if (!event.output_head) return [];
      return event.output_head.split('\n').map((line) => `  ${line}`);
    default:
      return [];
  }
}

function buildToolDetail(event: ToolEvent, locale: UiLocale): string | null {
  if (!event.ok) {
    if (event.reason && !event.reason.includes('\n')) return event.reason;
    return event.reason ? null : null;
  }
  switch (event.tool) {
    case 'write_file': {
      const lineLabel =
        locale === 'zh-CN'
          ? `写入 ${event.lines ?? 0} 行`
          : `Wrote ${event.lines ?? 0} lines`;
      const sizeLabel =
        typeof event.bytes === 'number' ? ` (${formatBytes(event.bytes)})` : '';
      return `${lineLabel}${sizeLabel}`;
    }
    case 'replace_in_file':
    case 'insert_in_file':
    case 'apply_patch': {
      const added = event.added_lines ?? 0;
      const removed = event.removed_lines ?? 0;
      if (added === 0 && removed === 0) {
        if (event.tool === 'apply_patch') {
          return locale === 'zh-CN'
            ? `修改了 ${(event.files ?? []).length} 个文件`
            : `Patched ${(event.files ?? []).length} files`;
        }
        return null;
      }
      return locale === 'zh-CN'
        ? `新增 ${added} 行，删除 ${removed} 行`
        : `Added ${added} lines, removed ${removed} lines`;
    }
    case 'run_command':
      if (typeof event.exit === 'number') {
        return locale === 'zh-CN' ? `退出码 ${event.exit}` : `exit ${event.exit}`;
      }
      return null;
    case 'read_file':
      return event.range
        ? locale === 'zh-CN'
          ? `第 ${event.range} 行`
          : `lines ${event.range}`
        : null;
    case 'search_files':
      if (event.pattern && event.query) {
        return `pattern=${event.pattern} query=${event.query}`;
      }
      return null;
    default:
      return null;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function applyWorkflowProgressInfo(
  state: WorkflowProgressState,
  message: string,
): void {
  const normalized = message.trim();
  if (!normalized) {
    return;
  }

  const explicitStageNote = parseExplicitStageNote(state, normalized);
  if (explicitStageNote) {
    const stage = state.stages.find((entry) => entry.id === explicitStageNote.stageId);
    if (stage) {
      pushStageNote(stage, explicitStageNote.note);
    }
    return;
  }

  // Per-stage attribution: token usage and reply snippets attach to the
  // currently-active stage so the renderer can show "this stage burned
  // N tokens and the model just said …" inline.
  const usage = parseUsageMessage(normalized);
  if (usage) {
    const active = getActiveStage(state);
    if (active) {
      if (typeof usage.promptTokens === 'number') {
        active.promptTokens += usage.promptTokens;
      }
      if (typeof usage.completionTokens === 'number') {
        active.completionTokens += usage.completionTokens;
      }
    }
    return;
  }

  // Streaming events: forward the model's raw output to a per-stage live
  // buffer so the user can see the agent write in real time.
  if (normalized.startsWith('[stream-start]')) {
    const active = getActiveStage(state);
    if (active) active.liveStream = '';
    return;
  }
  if (normalized.startsWith('[stream-chunk]')) {
    const m = normalized.match(/\bdelta=(.+)$/);
    if (m) {
      let delta = '';
      try {
        delta = JSON.parse(m[1]!) as string;
      } catch {
        delta = m[1]!;
      }
      const active = getActiveStage(state);
      if (active) {
        active.liveStream = (active.liveStream ?? '') + delta;
      }
    }
    return;
  }
  if (normalized.startsWith('[stream-end]')) {
    // Keep the buffer until [reply] / first tool event arrives, so the user
    // can read the final raw output until it's replaced by the structured
    // tool calls. (The parsed envelope replaces it almost immediately.)
    return;
  }

  const reply = parseReplyMessage(normalized);
  if (reply) {
    const active = getActiveStage(state);
    if (active) {
      // Envelope is parsed — clear the raw stream buffer and switch to the
      // structured display.
      active.liveStream = undefined;
      // Single rolling slot — replace, don't append. The model often
      // regurgitates a near-identical reply each turn; only the latest matters.
      active.latestReply = reply;
    }
    return;
  }

  const toolEvent = parseToolEvent(stripSpecialistPrefix(normalized));
  if (toolEvent) {
    const active = getActiveStage(state);
    if (active) {
      // Structured tool call replaces the raw stream view.
      active.liveStream = undefined;
      pushStageEvent(active, toolEvent);
    }
    // Tool ok/failed already lives inline under the stage. Returning here
    // prevents the failure from also being added to the global warnings
    // queue and double-surfaced as a top-level "注意" panel.
    return;
  }

  if (trackSpecialistCompletion(state, normalized)) {
    return;
  }

  const runtimeLog = normalized.match(/^\[log:(info|warn|error)\]\s+([\s\S]+)$/i);
  if (runtimeLog) {
    const active = getActiveStage(state);
    if (active) {
      pushStageNote(active, runtimeLog[2]!.trim());
    }
    if ((runtimeLog[1] ?? '').toLowerCase() !== 'info') {
      pushWarning(state, runtimeLog[2]!.trim());
    }
    return;
  }

  if (/\b(error|failed|denied)\b/i.test(normalized)) {
    pushWarning(state, normalized);
    state.note = pickLocale(state.locale, {
      zh: '流程出现错误，正在输出详细信息。',
      en: 'The workflow hit an error. Showing details.',
    });
    return;
  }

  if (/\bblocked\b/i.test(normalized)) {
    pushWarning(state, normalized);
    state.note = pickLocale(state.locale, {
      zh: '流程遇到阻塞，正在说明原因。',
      en: 'The workflow is blocked and is explaining why.',
    });
    return;
  }

  if (/\[verification\]\s+reminder injected/i.test(normalized)) {
    state.note = pickLocale(state.locale, {
      zh: '正在做结束前检查。',
      en: 'Running the final checks before completion.',
    });
    return;
  }

  switch (state.mode) {
    case 'niko':
      if (/\[niko\]\s+launching researcher and reviewer/i.test(normalized)) {
        setActiveStage(
          state,
          'research',
          pickLocale(state.locale, {
            zh: '正在启动 researcher 和 reviewer，请稍候。',
            en: 'Launching the researcher and reviewer now.',
          }),
        );
        return;
      }
      if (/\[niko\]\s+synthesizing final recommendation/i.test(normalized)) {
        setActiveStage(
          state,
          'synthesis',
          pickLocale(state.locale, {
            zh: '正在综合建议并收敛最终方向。',
            en: 'Synthesizing the final recommendation.',
          }),
        );
        return;
      }
      if (/\[niko\]\s+executing recommended path/i.test(normalized)) {
        setActiveStage(
          state,
          'execute',
          pickLocale(state.locale, {
            zh: '正在把建议真正落地到工作区。',
            en: 'Executing the recommended path in the workspace.',
          }),
        );
        return;
      }
      break;
    case 'design':
      if (/\[design\]\s+(?:launching researcher, reviewer, and planner|building read-only design brief|building design brief and assets|phase 1: research \+ design review|phase 1: design synthesis|phase 1: art direction)/i.test(normalized)) {
        setActiveStage(
          state,
          'art',
          pickLocale(state.locale, {
            zh: 'art-director 正在建立视觉方向、材质、摄影和高级感边界。',
            en: 'Art director is establishing visual direction, material, photography, and quality boundaries.',
          }),
        );
        return;
      }
      if (/\[design\]\s+(?:phase 2: layout system|phase 1 complete: art direction ready)/i.test(normalized)) {
        setActiveStage(
          state,
          'layout',
          pickLocale(state.locale, {
            zh: 'layout agent 正在把方向落成首屏、商品网格和响应式排版合同。',
            en: 'Layout agent is turning direction into first viewport, product grid, and responsive rules.',
          }),
        );
        return;
      }
      if (/\[design\]\s+phase 3: raster product assets|\[design:asset-/i.test(normalized)) {
        setActiveStage(
          state,
          'assets',
          pickLocale(state.locale, {
            zh: 'asset agent 正在规划并生成任务专属栅格视觉素材。',
            en: 'Asset agent is planning and generating task-specific raster visuals.',
          }),
        );
        return;
      }
      if (/\[design\]\s+phase 4: design polish/i.test(normalized)) {
        setActiveStage(
          state,
          'polish',
          pickLocale(state.locale, {
            zh: 'polish agent 正在升级设计合同并检查占位素材、排版和质感风险。',
            en: 'Polish agent is upgrading the design contract and checking asset, layout, and quality risks.',
          }),
        );
        return;
      }
      if (/\[design\]\s+(?:synthesizing frontend design brief|phase 1 complete: design brief ready|design brief complete)|\[design:synthesis\]/i.test(normalized)) {
        setActiveStage(
          state,
          'synthesis',
          pickLocale(state.locale, {
            zh: '正在整合多阶段设计合同并完成实现交接。',
            en: 'Packaging the multi-stage design contract and implementation handoff.',
          }),
        );
        return;
      }
      if (/\[design\]\s+(?:implementing approved direction|phase 2: implementation|phase 5: implementation)/i.test(normalized)) {
        setActiveStage(
          state,
          'execute',
          pickLocale(state.locale, {
            zh: '正在按设计合同在目标目录实现页面与资产。',
            en: 'Implementing the design contract in the target directory.',
          }),
        );
        return;
      }
      break;
    case 'contest':
      if (/\[contest\]\s+generating proposal/i.test(normalized)) {
        setActiveStage(
          state,
          'proposal',
          pickLocale(state.locale, {
            zh: '正在构建候选路径并形成初步论证。',
            en: 'Shaping the candidate path and first-pass case.',
          }),
        );
        return;
      }
      if (/\[contest\]\s+judging final path/i.test(normalized)) {
        setActiveStage(
          state,
          'verdict',
          pickLocale(state.locale, {
            zh: '正在裁决最终执行路径。',
            en: 'Selecting the final execution path.',
          }),
        );
        return;
      }
      if (/\[contest\]\s+executing winning path/i.test(normalized)) {
        setActiveStage(
          state,
          'execute',
          pickLocale(state.locale, {
            zh: '正在落地选中的路径。',
            en: 'Executing the selected path now.',
          }),
        );
        return;
      }
      break;
    case 'athena':
      if (/\[athena\]\s+launching/i.test(normalized)) {
        setActiveStage(
          state,
          'research',
          pickLocale(state.locale, {
            zh: '正在分片研究代码库。',
            en: 'Launching the slice research pass.',
          }),
        );
        return;
      }
      if (/\[athena\]\s+collecting builder proposals/i.test(normalized)) {
        setActiveStage(
          state,
          'proposal',
          pickLocale(state.locale, {
            zh: '正在收集各切片的构建提案。',
            en: 'Collecting builder proposals for each slice.',
          }),
        );
        return;
      }
      if (/\[athena\]\s+executing main coordinated pass/i.test(normalized)) {
        setActiveStage(
          state,
          'execute',
          pickLocale(state.locale, {
            zh: '正在进行主协调执行。',
            en: 'Running the main coordinated execution pass.',
          }),
        );
        return;
      }
      break;
    case 'nidhogg': {
      // Generator phase entry — "round X/Y — generator" (no "done" suffix).
      const genStart = normalized.match(/\[nidhogg\]\s+round (\d+)\/(\d+) — generator(?!\s+done)/i);
      if (genStart) {
        const [, r, total] = genStart;
        setActiveStage(
          state,
          'generate',
          pickLocale(state.locale, {
            zh: `第 ${r}/${total} 轮 · 正在锻造实现候选…`,
            en: `Round ${r}/${total} · forging implementation…`,
          }),
        );
        return;
      }
      const genDone = normalized.match(/\[nidhogg\]\s+round (\d+)\/(\d+) — generator done/i);
      if (genDone) {
        const [, r, total] = genDone;
        state.note = pickLocale(state.locale, {
          zh: `第 ${r}/${total} 轮 · 候选已生成，准备进入批评团`,
          en: `Round ${r}/${total} · candidate ready, preparing critic gauntlet`,
        });
        return;
      }
      // Critic pool phase entry: "round X/Y — critic pool (spec, test_adversary, security)"
      const poolStart = normalized.match(/\[nidhogg\]\s+round (\d+)\/(\d+) — critic pool \(([^)]+)\)/i);
      if (poolStart) {
        const [, r, total, kindsRaw] = poolStart;
        const count = kindsRaw!.split(',').length;
        setActiveStage(
          state,
          'critique',
          pickLocale(state.locale, {
            zh: `第 ${r}/${total} 轮 · ${count} 个批评者并行评估 (${kindsRaw!.trim()})`,
            en: `Round ${r}/${total} · running ${count} critics in parallel (${kindsRaw!.trim()})`,
          }),
        );
        return;
      }
      // Per-critic start.
      const criticStart = normalized.match(/\[nidhogg\]\s+round (\d+) — critic:([a-z_]+) starting/i);
      if (criticStart) {
        const [, r, kind] = criticStart;
        state.note = pickLocale(state.locale, {
          zh: `第 ${r} 轮 · ${kind} 评审中…`,
          en: `Round ${r} · ${kind} critic reviewing…`,
        });
        return;
      }
      // Per-critic done with score.
      const criticDone = normalized.match(/\[nidhogg\]\s+round (\d+) — critic:([a-z_]+) done \(score ([0-9.]+)\)/i);
      if (criticDone) {
        const [, r, kind, score] = criticDone;
        state.note = pickLocale(state.locale, {
          zh: `第 ${r} 轮 · ${kind} 完成 (得分 ${score})`,
          en: `Round ${r} · ${kind} done (score ${score})`,
        });
        return;
      }
      // Per-critic timeout warning.
      const criticTimeout = normalized.match(/\[nidhogg\]\s+round (\d+) — critic:([a-z_]+) soft timeout/i);
      if (criticTimeout) {
        const [, r, kind] = criticTimeout;
        pushWarning(
          state,
          pickLocale(state.locale, {
            zh: `第 ${r} 轮 · ${kind} 评审超时，使用中性分继续`,
            en: `Round ${r} · ${kind} critic timed out, neutral score used`,
          }),
        );
        return;
      }
      // Critic pool completion summary.
      const poolDone = normalized.match(/\[nidhogg\]\s+round (\d+)\/(\d+) — critic pool done/i);
      if (poolDone) {
        const [, r, total] = poolDone;
        state.note = pickLocale(state.locale, {
          zh: `第 ${r}/${total} 轮 · 批评团结束，准备进入收敛判断`,
          en: `Round ${r}/${total} · critic gauntlet finished, preparing convergence check`,
        });
        return;
      }
      // Judge phase.
      const judgeStart = normalized.match(/\[nidhogg\]\s+round (\d+)\/(\d+) — judge/i);
      if (judgeStart) {
        const [, r, total] = judgeStart;
        state.note = pickLocale(state.locale, {
          zh: `第 ${r}/${total} 轮 · 聚合得分并判断是否继续迭代…`,
          en: `Round ${r}/${total} · aggregating scores and deciding whether to continue…`,
        });
        return;
      }
      // Round finished with score.
      const roundDone = normalized.match(/\[nidhogg\]\s+round (\d+) finished\. score: ([0-9.]+) \(([↑→])\)/);
      if (roundDone) {
        const [, r, score, trend] = roundDone;
        state.note = pickLocale(state.locale, {
          zh: `第 ${r} 轮完成 · 综合得分 ${score} ${trend === '↑' ? '(上升)' : '(持平)'}`,
          en: `Round ${r} complete · overall score ${score} ${trend === '↑' ? '(up)' : '(flat)'}`,
        });
        return;
      }
      // Approval.
      const approved = normalized.match(/\[nidhogg\]\s+judge approved at round (\d+) \(score=([0-9.]+)\)/i);
      if (approved) {
        const [, r, score] = approved;
        state.note = pickLocale(state.locale, {
          zh: `第 ${r} 轮 · 已通过！综合得分 ${score}`,
          en: `Round ${r} · approved! overall score ${score}`,
        });
        return;
      }
      // Synthesis phase.
      if (/\[nidhogg\]\s+synthesizing final output/i.test(normalized)) {
        setActiveStage(
          state,
          'synthesis',
          pickLocale(state.locale, {
            zh: '正在综合多轮硬化结果…',
            en: 'Synthesizing the hardened result…',
          }),
        );
        return;
      }
      break;
    }
  }
}

export function markWorkflowProgressComplete(state: WorkflowProgressState): void {
  const now = Date.now();
  for (const stage of state.stages) {
    stage.status = 'done';
    if (stage.startedAtMs !== undefined && stage.endedAtMs === undefined) {
      stage.endedAtMs = now;
    }
  }
  state.note = pickLocale(state.locale, {
    zh: '流程已完成，正在整理结果。',
    en: 'Workflow complete. Finalizing the result.',
  });
}

// Write/execution tools whose completion is worth surfacing to permanent scrollback.
const SCROLLBACK_TOOLS = new Set([
  'write_file', 'insert_in_file', 'replace_in_file', 'apply_patch',
  'run_command', 'generate_image', 'generate_video',
]);

const TOOL_DISPLAY_LABELS: Record<string, string> = {
  write_file: 'Write', insert_in_file: 'Insert', replace_in_file: 'Replace',
  apply_patch: 'Patch', run_command: 'Bash', generate_image: 'Image', generate_video: 'Video',
};

// Returns a short display line for permanent scrollback (so users can scroll up
// and see what the workflow did), or null if the message is internal/noise.
export function formatWorkflowInfoForScrollback(message: string): string | null {
  const stripped = stripSpecialistPrefix(message.trim());

  // Tool ok events for write/execution tools → one-liner in scrollback
  const toolOkMatch = stripped.match(/^\[tool:([a-z_]+)\]\s+ok\b(.*)/);
  if (toolOkMatch) {
    const tool = toolOkMatch[1]!;
    if (!SCROLLBACK_TOOLS.has(tool)) return null;
    const rest = toolOkMatch[2]?.trim() ?? '';
    let detail = '';
    try {
      const info = JSON.parse(rest) as Record<string, unknown>;
      if (typeof info.path === 'string') {
        detail = `(${info.path})`;
      } else if (typeof info.command === 'string') {
        detail = `(${String(info.command).slice(0, 80)})`;
      }
    } catch { /* fall through */ }
    const label = TOOL_DISPLAY_LABELS[tool] ?? tool;
    return `  ⏺ ${label}${detail}`;
  }

  // Tool failures / blocks → surface as-is (errors are important)
  if (/^\[tool:[a-z_]+\]\s+(failed|blocked|denied)/i.test(stripped)) {
    return stripped;
  }

  // Free-text errors/blocks not caught above
  if (/\b(error|failed|denied)\b/i.test(stripped) || /\bblocked\b/i.test(stripped)) {
    return stripped;
  }

  return null;
}

export function shouldSurfaceWorkflowInfo(message: string): boolean {
  // Tool ok/fail messages are now folded into per-stage event streams, so
  // don't double-surface them as separate top-level "Notice" panels. Same
  // for blocked / denied / running / authorize_error which are already
  // visible via either the stage events or the bail-out reply.
  // Strip any `[niko:reviewer] [agent:reviewer]` prefixes so the [tool:...]
  // pattern matches even when wrapped by specialist agents.
  const stripped = stripSpecialistPrefix(message);
  if (/^\[tool:[a-z_]+\]\s+(ok|failed|blocked|denied|running|authorize_error|error|heimdall_artifact_error)/i.test(stripped)) return false;
  // Same for usage / reply / stream meta-events the workflow renderer consumes.
  if (/^\[usage\]/i.test(stripped)) return false;
  if (/^\[stream-(start|chunk|end)\]/i.test(stripped)) return false;
  if (/^\[reply\]/i.test(stripped)) return false;
  if (/^\[log:(info|warn|error)\]/i.test(stripped)) return false;
  return /\b(error|failed|denied)\b/i.test(stripped) || /\bblocked\b/i.test(stripped);
}

export function renderWorkflowProgress(
  state: WorkflowProgressState,
  now = Date.now(),
): string {
  const completedStages = state.stages.filter((stage) => stage.status === 'done').length;
  const hasActiveStage = state.stages.some((stage) => stage.status === 'active');
  const totalStages = Math.max(1, state.stages.length);
  const ratio = Math.min(1, (completedStages + (hasActiveStage ? 0.45 : 0)) / totalStages);
  const spinner = FACE_SPINNER_FRAMES[Math.floor(Math.max(0, now - state.startedAtMs) / 500) % FACE_SPINNER_FRAMES.length];
  const brailleFrame = BRAILLE_SPINNER_FRAMES[
    Math.floor(now / 100) % BRAILLE_SPINNER_FRAMES.length
  ]!;
  const lines = [
    pickLocale(state.locale, {
      zh: `◈ ${state.label} 工作流 · ${spinner} 运行中`,
      en: `◈ ${state.label} workflow · ${spinner} running`,
    }),
    `${buildProgressBar(completedStages, totalStages, hasActiveStage)} ${Math.round(ratio * 100)}% · ${formatElapsed(now - state.startedAtMs)} · ${pickLocale(state.locale, { zh: '实时事件流', en: 'live event stream' })}`,
    '',
  ];

  for (let index = 0; index < state.stages.length; index += 1) {
    const stage = state.stages[index]!;
    const marker =
      stage.status === 'done'
        ? color('✓', ANSI.green)
        : stage.status === 'active'
          ? color(brailleFrame, ANSI.yellow)
          : color('·', ANSI.gray);

    // Per-stage stats: only show timer/tokens once the stage has actually
    // started. Use Claude's ↑/↓ convention for input/output tokens so the
    // display is self-documenting (no mystery 📥/📤 icons).
    const stats: string[] = [];
    // 
    if (stage.startedAtMs !== undefined && stage.label !== '启动工作流' && stage.label !== 'Boot workflow') {
      const endMs = stage.endedAtMs ?? now;
      stats.push(`${formatElapsed(endMs - stage.startedAtMs)}`);
    }
    if (stage.promptTokens > 0 || stage.completionTokens > 0) {
      const tokensLabel = pickLocale(state.locale, {
        zh: 'tokens',
        en: 'tokens',
      });
      stats.push(
        `↑ ${stage.promptTokens} ↓ ${stage.completionTokens} ${tokensLabel}`,
      );
    }
    const statsSuffix = stats.length > 0 ? `  · ${stats.join(' · ')}` : '';
    const label =
      stage.status === 'done'
        ? color(stage.label, ANSI.green)
        : stage.status === 'active'
          ? color(stage.label, ANSI.yellow)
          : color(stage.label, ANSI.gray);
    const rail =
      stage.status === 'active'
        ? color('›', ANSI.yellow)
        : stage.status === 'done'
          ? color('│', ANSI.gray)
          : color('·', ANSI.gray);
    lines.push(`${rail} ${marker} ${label}${statsSuffix}`);

    // Stream events under each stage in Claude-style tool-call format:
    //   ⏺ Write(birthday.html)
    //      ⎿  Wrote 234 lines (12.3 KB)
    if (stage.status !== 'pending') {
      for (const note of stage.notes) {
        lines.push(`     › ${note}`);
      }
      for (const event of stage.events) {
        for (const eventLine of renderToolEvent(event, state.locale)) {
          lines.push(eventLine);
        }
      }
      if (stage.latestReply) {
        // Wrap long replies properly instead of hard truncation.
        const termWidth = Math.max(20, getTerminalWidth() - 12);
        for (const paragraph of stage.latestReply.split('\n')) {
          if (paragraph.length === 0) {
            lines.push('     ↪');
            continue;
          }
          let remaining = paragraph;
          while (remaining.length > 0) {
            let cutAt = termWidth;
            // Prefer breaking at space if possible.
            if (remaining.length > termWidth) {
              const lastSpace = remaining.lastIndexOf(' ', termWidth);
              if (lastSpace > termWidth / 2) {
                cutAt = lastSpace;
              }
            }
            const line = remaining.slice(0, cutAt);
            remaining = remaining.slice(cutAt).trimStart();
            lines.push(`     ↪ ${line}`);
          }
        }
      }
      // Real-time model output for the in-flight turn. Shown as plain
      // indented text (no `│` rail) so the visual style matches the
      // structured tool calls that replace it once the envelope is parsed.
      if (stage.liveStream && stage.liveStream.length > 0) {
        lines.push(
          `     ⏺ ${pickLocale(state.locale, {
            zh: '正在生成...',
            en: 'Generating...',
          })}`,
        );
        for (const streamLine of stage.liveStream.split('\n')) {
          lines.push(`       ${streamLine}`);
        }
      }
    }
  }

  if (state.note.trim()) {
    lines.push('');
    lines.push(
      `› ${pickLocale(state.locale, { zh: '当前状态', en: 'Current status' })}: ${state.note.trim()}`,
    );
    // Braille spinner + per-stage elapsed seconds. Animates because the host
    // (handleWorkflowTurn) re-renders this block every ~180ms via workflowTick.
    if (hasActiveStage) {
      const activeStage = getActiveStage(state);
      const stageElapsedMs = activeStage?.startedAtMs
        ? Math.max(0, now - activeStage.startedAtMs)
        : Math.max(0, now - state.startedAtMs);
      const stageElapsedSec = Math.floor(stageElapsedMs / 1000);
      lines.push(
        pickLocale(state.locale, {
          zh: `         ${brailleFrame} 进行中 · 本阶段已用时 ${stageElapsedSec}s · 按 Esc 中断`,
          en: `         ${brailleFrame} Working · ${stageElapsedSec}s in this stage · press Esc to cancel`,
        }),
      );
    }
  }

  if (state.warnings.length > 0) {
    lines.push('');
    lines.push(
      ...state.warnings.map((warning) =>
        `${pickLocale(state.locale, { zh: '注意', en: 'Notice' })}: ${warning}`,
      ),
    );
  }

  // Wrap long plain-text lines instead of clipping them. Users need the full
  // model reply and the full tool failure reason when debugging workflows.
  const termWidth = getTerminalWidth();
  return lines.flatMap((line) => wrapDisplayWidth(line, termWidth)).join('\n');
}
