export type UiLocale = 'zh-CN' | 'en'

export const DEFAULT_UI_LOCALE: UiLocale = 'en'

function inferSystemLocale(): UiLocale {
  const env = (
    process.env.ARTEMIS_LOCALE ||
    process.env.LC_ALL ||
    process.env.LC_MESSAGES ||
    process.env.LANG ||
    ''
  ).toLowerCase()
  return env.includes('zh') ? 'zh-CN' : DEFAULT_UI_LOCALE
}

export function normalizeUiLocale(value: string | undefined): UiLocale {
  if (value === 'zh-CN') return 'zh-CN'
  if (value === 'en') return 'en'
  return inferSystemLocale()
}

export function isChineseLocale(locale: UiLocale): boolean {
  return locale === 'zh-CN'
}

export function pickLocale(locale: UiLocale, values: { zh: string; en: string }): string {
  return isChineseLocale(locale) ? values.zh : values.en
}

export function formatUiLocaleLabel(locale: UiLocale): string {
  return pickLocale(locale, { zh: '中文', en: 'English' })
}
