/**
 * World clock tools — pure JS Intl, no external API.
 *
 * Usage scenarios for an ambient agent that travels:
 *   - "Bangkok / Beijing / NYC 现在几点？" → world_clock with multiple cities
 *   - "我在曼谷，给上海家人打电话现在合适吗？" → time_diff
 *
 * IANA timezone names accepted; common Chinese / English city aliases mapped.
 */

export interface ToolResult {
  ok: boolean;
  output: string;
  error?: { code: string; message: string };
}

export interface WorldClockAction {
  type: 'world_clock';
  cities: string[]; // City names or IANA tz like "Asia/Bangkok"
}

export interface TimeDiffAction {
  type: 'time_diff';
  fromCity: string;
  toCity: string;
}

// Common name → IANA timezone mapping. Brain can also pass IANA directly.
const CITY_TZ: Record<string, string> = {
  // China
  '北京': 'Asia/Shanghai', 'beijing': 'Asia/Shanghai',
  '上海': 'Asia/Shanghai', 'shanghai': 'Asia/Shanghai',
  '广州': 'Asia/Shanghai', 'guangzhou': 'Asia/Shanghai',
  '深圳': 'Asia/Shanghai', 'shenzhen': 'Asia/Shanghai',
  '香港': 'Asia/Hong_Kong', 'hongkong': 'Asia/Hong_Kong', 'hong kong': 'Asia/Hong_Kong',
  '台北': 'Asia/Taipei', 'taipei': 'Asia/Taipei',
  // SE Asia
  '曼谷': 'Asia/Bangkok', 'bangkok': 'Asia/Bangkok', 'bkk': 'Asia/Bangkok',
  '新加坡': 'Asia/Singapore', 'singapore': 'Asia/Singapore',
  '吉隆坡': 'Asia/Kuala_Lumpur', 'kuala lumpur': 'Asia/Kuala_Lumpur', 'kl': 'Asia/Kuala_Lumpur',
  '雅加达': 'Asia/Jakarta', 'jakarta': 'Asia/Jakarta',
  '马尼拉': 'Asia/Manila', 'manila': 'Asia/Manila',
  '河内': 'Asia/Ho_Chi_Minh', 'hanoi': 'Asia/Ho_Chi_Minh',
  '胡志明市': 'Asia/Ho_Chi_Minh', 'ho chi minh': 'Asia/Ho_Chi_Minh', 'saigon': 'Asia/Ho_Chi_Minh',
  // East Asia
  '东京': 'Asia/Tokyo', 'tokyo': 'Asia/Tokyo',
  '首尔': 'Asia/Seoul', 'seoul': 'Asia/Seoul',
  // Americas
  '纽约': 'America/New_York', 'new york': 'America/New_York', 'nyc': 'America/New_York',
  '洛杉矶': 'America/Los_Angeles', 'los angeles': 'America/Los_Angeles', 'la': 'America/Los_Angeles',
  '旧金山': 'America/Los_Angeles', 'san francisco': 'America/Los_Angeles', 'sf': 'America/Los_Angeles',
  '芝加哥': 'America/Chicago', 'chicago': 'America/Chicago',
  '多伦多': 'America/Toronto', 'toronto': 'America/Toronto',
  '温哥华': 'America/Vancouver', 'vancouver': 'America/Vancouver',
  // Europe
  '伦敦': 'Europe/London', 'london': 'Europe/London',
  '巴黎': 'Europe/Paris', 'paris': 'Europe/Paris',
  '柏林': 'Europe/Berlin', 'berlin': 'Europe/Berlin',
  '罗马': 'Europe/Rome', 'rome': 'Europe/Rome',
  '阿姆斯特丹': 'Europe/Amsterdam', 'amsterdam': 'Europe/Amsterdam',
  '马德里': 'Europe/Madrid', 'madrid': 'Europe/Madrid',
  // Middle East
  '迪拜': 'Asia/Dubai', 'dubai': 'Asia/Dubai',
  '伊斯坦布尔': 'Europe/Istanbul', 'istanbul': 'Europe/Istanbul',
  // Oceania
  '悉尼': 'Australia/Sydney', 'sydney': 'Australia/Sydney',
  '墨尔本': 'Australia/Melbourne', 'melbourne': 'Australia/Melbourne',
  '奥克兰': 'Pacific/Auckland', 'auckland': 'Pacific/Auckland',
};

function resolveTimeZone(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  // Direct IANA tz
  if (trimmed.includes('/')) {
    try {
      // Validate by trying to format
      new Intl.DateTimeFormat('en', { timeZone: trimmed });
      return trimmed;
    } catch {
      return null;
    }
  }
  // Try name lookup (case-insensitive)
  const key = trimmed.toLowerCase();
  if (CITY_TZ[key]) return CITY_TZ[key];
  // Last resort: try as-is anyway (Intl will throw on unknown)
  try {
    new Intl.DateTimeFormat('en', { timeZone: trimmed });
    return trimmed;
  } catch {
    return null;
  }
}

function formatTime(tz: string): string {
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: tz,
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return fmt.format(new Date());
}

function getOffsetMinutes(tz: string): number {
  // Compute UTC offset for a tz at "now". Intl doesn't expose offsets directly,
  // so we format an epoch time and reverse-engineer the offset.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = fmt.formatToParts(new Date());
  const obj: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') obj[p.type] = p.value;
  }
  const localUtc = Date.UTC(
    parseInt(obj.year), parseInt(obj.month) - 1, parseInt(obj.day),
    parseInt(obj.hour === '24' ? '0' : obj.hour), parseInt(obj.minute), parseInt(obj.second),
  );
  return Math.round((localUtc - Date.now()) / 60000);
}

export async function executeWorldClock(action: WorldClockAction): Promise<ToolResult> {
  if (!Array.isArray(action.cities) || action.cities.length === 0) {
    return {
      ok: false,
      output: '请提供至少一个城市名',
      error: { code: 'invalid_input', message: 'cities required' },
    };
  }
  const lines: string[] = [];
  for (const city of action.cities) {
    const tz = resolveTimeZone(city);
    if (!tz) {
      lines.push(`  ${city.padEnd(15)} ⚠ 未知时区（试试 IANA 格式如 "Asia/Tokyo"）`);
      continue;
    }
    lines.push(`  ${city.padEnd(15)} ${formatTime(tz)} (${tz})`);
  }
  return { ok: true, output: '🕐 世界时间\n' + lines.join('\n') };
}

export async function executeTimeDiff(action: TimeDiffAction): Promise<ToolResult> {
  const fromTz = resolveTimeZone(action.fromCity);
  const toTz = resolveTimeZone(action.toCity);
  if (!fromTz || !toTz) {
    const which = !fromTz ? action.fromCity : action.toCity;
    return {
      ok: false,
      output: `未知时区：${which}`,
      error: { code: 'unknown_tz', message: which },
    };
  }
  const fromOff = getOffsetMinutes(fromTz);
  const toOff = getOffsetMinutes(toTz);
  const diffMin = toOff - fromOff;
  const sign = diffMin >= 0 ? '+' : '-';
  const absH = Math.abs(diffMin) / 60;
  const direction = diffMin >= 0 ? `比 ${action.fromCity} 快` : `比 ${action.fromCity} 慢`;
  return {
    ok: true,
    output: [
      `🕐 时差`,
      `  ${action.fromCity}: ${formatTime(fromTz)}`,
      `  ${action.toCity}:   ${formatTime(toTz)}`,
      `  ${action.toCity} ${direction} ${absH} 小时 (${sign}${absH}h)`,
    ].join('\n'),
  };
}
