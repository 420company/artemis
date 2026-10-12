/**
 * tools/office/themes.ts — the looks the office tools can give a file.
 *
 * Six original themes (light and dark, business, minimal, vivid, calm). Each
 * is a palette plus a font pairing; the deck, document and workbook builders
 * read the same theme, so a deck and its companion report match.
 *
 * Fonts: Latin text uses a family every office suite has or maps
 * metric-compatibly (Arial → Liberation Sans on Linux; Georgia → a serif
 * fallback), and East Asian text names Noto Sans / Serif CJK SC (SIL Open
 * Font License), which the hosted toolbox installs (fonts-noto-cjk). On a
 * machine without Noto CJK, PowerPoint/Word/Excel substitute their own CJK
 * font, so text never turns into boxes.
 */

export type ThemeId = 'minimal' | 'dark' | 'business' | 'vivid' | 'nature' | 'warm';

export interface OfficeTheme {
  id: ThemeId;
  label: { zh: string; en: string };
  dark: boolean;
  colors: {
    /** Slide / page background. */
    bg: string;
    /** Panels, table stripes, callouts. */
    surface: string;
    text: string;
    muted: string;
    accent: string;
    accent2: string;
    /** Text on an accent fill. */
    onAccent: string;
    /** Hairlines and table borders. */
    line: string;
    /** Title slide background (full bleed) and its text. */
    coverBg: string;
    coverText: string;
    coverMuted: string;
    /** Section divider background and its text. */
    sectionBg: string;
    sectionText: string;
    /** Chart series, in order. */
    chart: string[];
  };
  fonts: {
    /** Latin face for titles and headings. */
    headLatin: string;
    /** Latin face for body text. */
    bodyLatin: string;
    /** East Asian face for titles and headings. */
    headEa: string;
    /** East Asian face for body text. */
    bodyEa: string;
  };
}

const SANS_EA = 'Noto Sans CJK SC';
const SERIF_EA = 'Noto Serif CJK SC';

export const OFFICE_THEMES: Readonly<Record<ThemeId, OfficeTheme>> = {
  minimal: {
    id: 'minimal',
    label: { zh: '简约', en: 'Minimal' },
    dark: false,
    colors: {
      bg: 'FFFFFF',
      surface: 'F4F5F7',
      text: '1D2129',
      muted: '6B7280',
      accent: '3056D3',
      accent2: '14A38B',
      onAccent: 'FFFFFF',
      line: 'E3E5EA',
      coverBg: 'FFFFFF',
      coverText: '1D2129',
      coverMuted: '6B7280',
      sectionBg: 'F4F5F7',
      sectionText: '1D2129',
      chart: ['3056D3', '7C9CF0', '14A38B', 'F2A33A', 'E25D5D', '8E8E93'],
    },
    fonts: { headLatin: 'Arial', bodyLatin: 'Arial', headEa: SANS_EA, bodyEa: SANS_EA },
  },
  dark: {
    id: 'dark',
    label: { zh: '深色', en: 'Dark' },
    dark: true,
    colors: {
      bg: '111318',
      surface: '1C1F27',
      text: 'F2F3F5',
      muted: '9AA1AE',
      accent: '7CC7F5',
      accent2: 'B39DFA',
      onAccent: '0E1014',
      line: '2C303A',
      coverBg: '0B0C10',
      coverText: 'FFFFFF',
      coverMuted: '9AA1AE',
      sectionBg: '1C1F27',
      sectionText: 'F2F3F5',
      chart: ['7CC7F5', 'B39DFA', '4FD1A5', 'F7C35F', 'F47C7C', 'C9CED8'],
    },
    fonts: { headLatin: 'Arial', bodyLatin: 'Arial', headEa: SANS_EA, bodyEa: SANS_EA },
  },
  business: {
    id: 'business',
    label: { zh: '商务', en: 'Business' },
    dark: false,
    colors: {
      bg: 'FFFFFF',
      surface: 'F2F4F7',
      text: '1B2A3A',
      muted: '5B6B7C',
      accent: '1F3A5F',
      accent2: 'C8963E',
      onAccent: 'FFFFFF',
      line: 'DCE1E8',
      coverBg: '1F3A5F',
      coverText: 'FFFFFF',
      coverMuted: 'C9D3DF',
      sectionBg: '1F3A5F',
      sectionText: 'FFFFFF',
      chart: ['1F3A5F', 'C8963E', '4F7CAC', '8AA1B9', '2E8B57', 'B85C38'],
    },
    fonts: { headLatin: 'Arial', bodyLatin: 'Arial', headEa: SANS_EA, bodyEa: SANS_EA },
  },
  vivid: {
    id: 'vivid',
    label: { zh: '活力', en: 'Vivid' },
    dark: false,
    colors: {
      bg: 'FFFFFF',
      surface: 'F5F2FF',
      text: '1E1B2E',
      muted: '6B6680',
      accent: '6C4CF1',
      accent2: 'FF5A36',
      onAccent: 'FFFFFF',
      line: 'E6E1F5',
      coverBg: '6C4CF1',
      coverText: 'FFFFFF',
      coverMuted: 'DCD3FF',
      sectionBg: 'FF5A36',
      sectionText: 'FFFFFF',
      chart: ['6C4CF1', 'FF5A36', '00B3A4', 'FFB400', '2D9CDB', 'E84393'],
    },
    fonts: { headLatin: 'Arial', bodyLatin: 'Arial', headEa: SANS_EA, bodyEa: SANS_EA },
  },
  nature: {
    id: 'nature',
    label: { zh: '清新', en: 'Nature' },
    dark: false,
    colors: {
      bg: 'F8F8F3',
      surface: 'ECEFE6',
      text: '1F2A24',
      muted: '5F6B63',
      accent: '2F7D5B',
      accent2: 'D9A441',
      onAccent: 'FFFFFF',
      line: 'DCE1D6',
      coverBg: '2F7D5B',
      coverText: 'FFFFFF',
      coverMuted: 'D5E6DC',
      sectionBg: 'ECEFE6',
      sectionText: '1F2A24',
      chart: ['2F7D5B', '8DB596', 'D9A441', '4A6FA5', 'C8553D', '7A6C5D'],
    },
    fonts: { headLatin: 'Arial', bodyLatin: 'Arial', headEa: SANS_EA, bodyEa: SANS_EA },
  },
  warm: {
    id: 'warm',
    label: { zh: '雅致', en: 'Warm' },
    dark: false,
    colors: {
      bg: 'FBF8F3',
      surface: 'F2ECE2',
      text: '2B2420',
      muted: '7A6E64',
      accent: 'B4532A',
      accent2: '3E5C76',
      onAccent: 'FFFFFF',
      line: 'E6DDD0',
      coverBg: 'FBF8F3',
      coverText: '2B2420',
      coverMuted: '7A6E64',
      sectionBg: 'F2ECE2',
      sectionText: '2B2420',
      chart: ['B4532A', '3E5C76', 'D9A35F', '7A9E7E', '8C5E8F', 'A39A90'],
    },
    fonts: { headLatin: 'Georgia', bodyLatin: 'Arial', headEa: SERIF_EA, bodyEa: SANS_EA },
  },
};

export const THEME_IDS = Object.keys(OFFICE_THEMES) as ThemeId[];

const THEME_ALIASES: Record<string, ThemeId> = {
  light: 'minimal',
  clean: 'minimal',
  simple: 'minimal',
  default: 'minimal',
  简约: 'minimal',
  简洁: 'minimal',
  white: 'minimal',
  night: 'dark',
  black: 'dark',
  深色: 'dark',
  暗色: 'dark',
  黑色: 'dark',
  corporate: 'business',
  professional: 'business',
  navy: 'business',
  商务: 'business',
  正式: 'business',
  bold: 'vivid',
  colorful: 'vivid',
  bright: 'vivid',
  活力: 'vivid',
  鲜艳: 'vivid',
  green: 'nature',
  fresh: 'nature',
  calm: 'nature',
  清新: 'nature',
  自然: 'nature',
  elegant: 'warm',
  classic: 'warm',
  editorial: 'warm',
  雅致: 'warm',
  温暖: 'warm',
  暖色: 'warm',
};

/** The theme a name stands for (ids, English or Chinese words); minimal when unknown. */
export function resolveTheme(name: unknown): OfficeTheme {
  if (typeof name !== 'string') return OFFICE_THEMES.minimal;
  const key = name.trim().toLowerCase();
  if ((THEME_IDS as string[]).includes(key)) return OFFICE_THEMES[key as ThemeId];
  const alias = THEME_ALIASES[key] ?? THEME_ALIASES[name.trim()];
  return OFFICE_THEMES[alias ?? 'minimal'];
}

/** True when `name` names a theme (or an alias of one). */
export function isKnownTheme(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  const key = name.trim().toLowerCase();
  return (THEME_IDS as string[]).includes(key) || key in THEME_ALIASES || name.trim() in THEME_ALIASES;
}

/** `RRGGBB` mixed toward white (amount 0..1). */
export function tint(hex: string, amount: number): string {
  const n = Number.parseInt(hex, 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0').toUpperCase();
}
