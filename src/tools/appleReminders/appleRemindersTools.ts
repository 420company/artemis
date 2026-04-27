/**
 * Apple Reminders tools — driven by osascript on macOS, no OAuth needed.
 *
 * macOS Reminders.app exposes AppleScript for full read/write access. Like
 * Calendar, first run prompts for permission via System Settings → Privacy.
 *
 * Brain-callable tools:
 *   reminders_list      — list pending (or completed) reminders
 *   reminders_add       — add a new reminder (with optional due date + list)
 *   reminders_complete  — mark a reminder by name as completed
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface ToolResult {
  ok: boolean;
  output: string;
  error?: { code: string; message: string };
}

function platformGuard(): ToolResult | null {
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      output: 'Apple Reminders 工具仅在 macOS 上可用。Linux/Windows 用户可考虑接 Notion / Things MCP。',
      error: { code: 'platform_unsupported', message: 'macOS only' },
    };
  }
  return null;
}

async function runAppleScript(
  script: string,
  timeoutMs = 15_000,
): Promise<{ stdout: string; stderr: string } | { error: string }> {
  try {
    const { stdout, stderr } = await execAsync(
      `osascript - <<'ARTEMIS_SCRIPT_END'\n${script}\nARTEMIS_SCRIPT_END\n`,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, shell: '/bin/bash' },
    );
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    const e = err as { message?: string; stderr?: string };
    const msg = e.stderr || e.message || 'unknown osascript error';
    if (/not authorized to access|access not allowed/i.test(msg)) {
      return {
        error:
          'macOS 拒绝 Reminders 访问。请去「系统设置 → 隐私与安全性 → 提醒事项」给 Terminal/Artemis 授权。',
      };
    }
    return { error: msg };
  }
}

const escapeStr = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

// ── reminders_list ──────────────────────────────────────────────────────

export interface RemindersListAction {
  type: 'reminders_list';
  list?: string; // specific list name; default: all
  includeCompleted?: boolean; // default false
}

export async function executeRemindersList(action: RemindersListAction): Promise<ToolResult> {
  const guard = platformGuard();
  if (guard) return guard;

  const includeCompleted = action.includeCompleted === true;
  const completedFilter = includeCompleted ? '' : 'whose completed is false';
  const listFilter = action.list
    ? `(every list whose name is "${escapeStr(action.list)}")`
    : 'every list';

  const script = `
    set output to ""
    tell application "Reminders"
      repeat with l in ${listFilter}
        try
          set listName to (name of l as string)
          set rems to (every reminder of l ${completedFilter})
          repeat with r in rems
            set rName to (name of r as string)
            set rDue to ""
            try
              set rDue to (due date of r as string)
            end try
            set rCompl to (completed of r as boolean)
            set output to output & listName & " | " & rDue & " | " & (rCompl as string) & " | " & rName & "\\n"
          end repeat
        end try
      end repeat
    end tell
    return output
  `;

  const result = await runAppleScript(script, 20_000);
  if ('error' in result) {
    return {
      ok: false,
      output: `提醒事项查询失败：${result.error}`,
      error: { code: 'reminders_error', message: result.error },
    };
  }

  const lines = result.stdout.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return {
      ok: true,
      output: action.list ? `📝 列表 "${action.list}" 没有待办事项` : '📝 没有待办事项',
    };
  }

  const items = lines
    .map((line) => {
      const parts = line.split(' | ');
      if (parts.length < 4) return null;
      return {
        list: parts[0]!,
        due: parts[1]!,
        completed: parts[2]! === 'true',
        title: parts.slice(3).join(' | '),
      };
    })
    .filter((x): x is { list: string; due: string; completed: boolean; title: string } => x !== null);

  const header = action.list
    ? `📝 ${action.list} (${items.length})`
    : `📝 全部待办 (${items.length})`;
  const out = [header];
  for (const it of items.slice(0, 40)) {
    const mark = it.completed ? '✓' : '○';
    const due = it.due ? ` · 截止 ${it.due}` : '';
    out.push(`  ${mark} ${it.title}${due} [${it.list}]`);
  }
  if (items.length > 40) out.push(`  … +${items.length - 40}`);
  return { ok: true, output: out.join('\n') };
}

// ── reminders_add ───────────────────────────────────────────────────────

export interface RemindersAddAction {
  type: 'reminders_add';
  title: string;
  list?: string; // default: 'Reminders' (the default list)
  dueISO?: string;
  notes?: string;
}

export async function executeRemindersAdd(action: RemindersAddAction): Promise<ToolResult> {
  const guard = platformGuard();
  if (guard) return guard;

  if (!action.title) {
    return {
      ok: false,
      output: 'title 是必填项',
      error: { code: 'invalid_input', message: 'title required' },
    };
  }

  let dueClause = '';
  if (action.dueISO) {
    const due = new Date(action.dueISO);
    if (isNaN(due.getTime())) {
      return {
        ok: false,
        output: `dueISO 格式错误：${action.dueISO}`,
        error: { code: 'invalid_date', message: 'invalid dueISO' },
      };
    }
    dueClause = `, due date: my makeDate(${due.getFullYear()}, ${due.getMonth() + 1}, ${due.getDate()}, ${due.getHours()}, ${due.getMinutes()}, ${due.getSeconds()})`;
  }

  const notesField = action.notes ? `, body: "${escapeStr(action.notes)}"` : '';

  const listClause = action.list
    ? `list "${escapeStr(action.list)}"`
    : `default list`;

  const script = `
    on makeDate(y, m, d, h, mi, s)
      set out to (current date)
      set year of out to y
      set month of out to m
      set day of out to d
      set time of out to (h * hours + mi * minutes + s)
      return out
    end makeDate
    tell application "Reminders"
      tell ${listClause}
        make new reminder with properties {name: "${escapeStr(action.title)}"${dueClause}${notesField}}
      end tell
    end tell
    return "ok"
  `;

  const result = await runAppleScript(script, 15_000);
  if ('error' in result) {
    return {
      ok: false,
      output: `添加待办失败：${result.error}`,
      error: { code: 'reminders_error', message: result.error },
    };
  }
  const dueDisplay = action.dueISO ? ` · 截止 ${new Date(action.dueISO).toLocaleString('zh-CN')}` : '';
  return {
    ok: true,
    output: `✅ 已添加待办：${action.title}${dueDisplay}${action.list ? ` [${action.list}]` : ''}`,
  };
}

// ── reminders_complete ──────────────────────────────────────────────────

export interface RemindersCompleteAction {
  type: 'reminders_complete';
  title: string; // matches first reminder by exact title; falls back to substring
  list?: string;
}

export async function executeRemindersComplete(action: RemindersCompleteAction): Promise<ToolResult> {
  const guard = platformGuard();
  if (guard) return guard;
  if (!action.title) {
    return {
      ok: false,
      output: 'title 是必填项',
      error: { code: 'invalid_input', message: 'title required' },
    };
  }

  const listFilter = action.list
    ? `list "${escapeStr(action.list)}"`
    : 'every list';

  // Prefer exact match, fall back to first contains match.
  const script = `
    set targetTitle to "${escapeStr(action.title)}"
    set found to false
    set foundName to ""
    tell application "Reminders"
      repeat with l in ${action.list ? listFilter : 'every list'}
        try
          set rems to (every reminder of l whose completed is false)
          -- exact match first
          repeat with r in rems
            if (name of r as string) is equal to targetTitle then
              set completed of r to true
              set found to true
              set foundName to (name of r as string)
              exit repeat
            end if
          end repeat
          if found then exit repeat
          -- substring fallback
          repeat with r in rems
            if (name of r as string) contains targetTitle then
              set completed of r to true
              set found to true
              set foundName to (name of r as string)
              exit repeat
            end if
          end repeat
          if found then exit repeat
        end try
      end repeat
    end tell
    if found then
      return "OK|" & foundName
    else
      return "NOT_FOUND"
    end if
  `;

  const result = await runAppleScript(script, 15_000);
  if ('error' in result) {
    return {
      ok: false,
      output: `完成待办失败：${result.error}`,
      error: { code: 'reminders_error', message: result.error },
    };
  }

  if (result.stdout === 'NOT_FOUND') {
    return {
      ok: false,
      output: `没找到匹配 "${action.title}" 的未完成提醒`,
      error: { code: 'not_found', message: 'reminder not found' },
    };
  }

  if (result.stdout.startsWith('OK|')) {
    const name = result.stdout.slice(3);
    return { ok: true, output: `✓ 已完成：${name}` };
  }

  return {
    ok: false,
    output: `未知响应：${result.stdout}`,
    error: { code: 'unknown_response', message: result.stdout },
  };
}
