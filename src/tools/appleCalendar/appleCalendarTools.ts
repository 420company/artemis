/**
 * Apple Calendar tools — driven by osascript on macOS, no OAuth needed.
 *
 * Works because Calendar.app on macOS exposes a rich AppleScript dictionary.
 * First time use, macOS will prompt for Calendar access — once granted,
 * everything works silently.
 *
 * For Telegram bridge users: home Mac runs Artemis → Telegram message arrives
 * → osascript → Calendar.app → returns events. Works fully remote.
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
      output: 'Apple Calendar 工具仅在 macOS 上可用。Linux/Windows 用户请考虑接 Google Calendar MCP（/mcp enable cco-people-management-google-calendar）。',
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
    // Pass via stdin to avoid quoting hell with single-quoted -e args.
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
          'macOS 拒绝 Calendar 访问。请去「系统设置 → 隐私与安全性 → 日历」给 Terminal/Artemis 授权。',
      };
    }
    return { error: msg };
  }
}

// ── calendar_list_today / calendar_list_upcoming ───────────────────────

export interface CalendarListAction {
  type: 'calendar_list_today' | 'calendar_list_upcoming';
  daysAhead?: number; // for upcoming, default 7
}

export async function executeCalendarList(action: CalendarListAction): Promise<ToolResult> {
  const guard = platformGuard();
  if (guard) return guard;

  const isToday = action.type === 'calendar_list_today';
  const daysAhead = isToday ? 1 : Math.max(1, Math.min(30, Math.floor(action.daysAhead ?? 7)));

  const script = `
    set startDate to current date
    set time of startDate to 0
    set endDate to startDate + (${daysAhead} * days)
    set output to ""
    tell application "Calendar"
      repeat with cal in calendars
        try
          set evts to (every event of cal whose start date >= startDate and start date < endDate)
          repeat with e in evts
            set evTitle to (summary of e as string)
            set evStart to (start date of e as string)
            set evCal to (title of cal as string)
            set output to output & evCal & " | " & evStart & " | " & evTitle & "\\n"
          end repeat
        end try
      end repeat
    end tell
    return output
  `;

  const result = await runAppleScript(script, 30_000);
  if ('error' in result) {
    return {
      ok: false,
      output: `日历查询失败：${result.error}`,
      error: { code: 'calendar_error', message: result.error },
    };
  }

  const lines = result.stdout.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return {
      ok: true,
      output: isToday ? '📅 今日没有日历事件' : `📅 未来 ${daysAhead} 天没有日历事件`,
    };
  }

  const events = lines
    .map((line) => {
      const parts = line.split(' | ');
      if (parts.length < 3) return null;
      return { calendar: parts[0]!, start: parts[1]!, title: parts.slice(2).join(' | ') };
    })
    .filter((x): x is { calendar: string; start: string; title: string } => x !== null)
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  const header = isToday ? '📅 今日事件' : `📅 未来 ${daysAhead} 天事件 (${events.length})`;
  const out = [header];
  for (const e of events.slice(0, 30)) {
    out.push(`  ${e.start} · ${e.title} [${e.calendar}]`);
  }
  if (events.length > 30) out.push(`  … +${events.length - 30}`);
  return { ok: true, output: out.join('\n') };
}

// ── calendar_add_event ─────────────────────────────────────────────────

export interface CalendarAddAction {
  type: 'calendar_add_event';
  title: string;
  startISO: string; // ISO 8601
  endISO?: string;
  notes?: string;
  calendarName?: string;
}

function buildAddEventScript(
  title: string,
  start: Date,
  end: Date,
  notes: string | undefined,
  calendarName: string | undefined,
): string {
  const escapeStr = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const calClause = calendarName
    ? `calendar "${escapeStr(calendarName)}"`
    : `(first calendar whose writable is true)`;
  const notesField = notes ? `, description: "${escapeStr(notes)}"` : '';

  return `
    on makeDate(y, m, d, h, mi, s)
      set out to (current date)
      set year of out to y
      set month of out to m
      set day of out to d
      set time of out to (h * hours + mi * minutes + s)
      return out
    end makeDate
    tell application "Calendar"
      set startDate to my makeDate(${start.getFullYear()}, ${start.getMonth() + 1}, ${start.getDate()}, ${start.getHours()}, ${start.getMinutes()}, ${start.getSeconds()})
      set endDate to my makeDate(${end.getFullYear()}, ${end.getMonth() + 1}, ${end.getDate()}, ${end.getHours()}, ${end.getMinutes()}, ${end.getSeconds()})
      tell ${calClause}
        make new event with properties {summary: "${escapeStr(title)}", start date: startDate, end date: endDate${notesField}}
      end tell
    end tell
    return "ok"
  `;
}

export async function executeCalendarAddEvent(action: CalendarAddAction): Promise<ToolResult> {
  const guard = platformGuard();
  if (guard) return guard;
  if (!action.title || !action.startISO) {
    return {
      ok: false,
      output: 'title 和 startISO 是必填项',
      error: { code: 'invalid_input', message: 'title and startISO required' },
    };
  }
  const start = new Date(action.startISO);
  if (isNaN(start.getTime())) {
    return {
      ok: false,
      output: `startISO 格式错误：${action.startISO}（用 ISO 8601 如 "2026-04-28T19:00:00"）`,
      error: { code: 'invalid_date', message: 'invalid startISO' },
    };
  }
  const end = action.endISO ? new Date(action.endISO) : new Date(start.getTime() + 60 * 60_000);
  const script = buildAddEventScript(action.title, start, end, action.notes, action.calendarName);
  const result = await runAppleScript(script, 20_000);
  if ('error' in result) {
    return {
      ok: false,
      output: `添加事件失败：${result.error}`,
      error: { code: 'calendar_error', message: result.error },
    };
  }
  return {
    ok: true,
    output: `✅ 已添加事件：${action.title}\n   ${start.toLocaleString('zh-CN')} ~ ${end.toLocaleString('zh-CN')}`,
  };
}
