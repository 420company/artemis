/**
 * cli/bundleOnboarding.ts — One-time Bundle setup shown after Bifrost is configured.
 *
 * Offers the user three choices per settings axis:
 *   1. enable/disable
 *   2. trigger mode: auto (on long prompts) vs manual (/bundle only)
 *   3. which provider does polishing: main vs brain
 *
 * If the user declines outright, we still mark `bundleConfigured = true` so we
 * don't keep asking on every Bifrost re-setup.
 */

import { chooseInteractiveOption } from './prompt.js'
import type { CliSettingsStore, BundleMode, BundleModelChoice } from './settings.js'
import type { UiLocale } from './locale.js'

export async function runBundleOnboarding(options: {
  locale: UiLocale
  settingsStore: CliSettingsStore
  printPanel: (title: string, lines: string[]) => void
}): Promise<void> {
  const { locale, settingsStore, printPanel } = options
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en

  const enable = await chooseInteractiveOption<boolean | '__cancel__'>({
    title: t('◆ Bundle 润色增强 — 要开启吗？',
             '◆ Bundle Prompt Polisher — enable?'),
    hint:  t('把自然语言需求自动改写成结构化技术提示词，可以用主模型或副模型做润色',
             'Rewrites natural-language requests into structured technical prompts (main or brain model)'),
    escapeValue: '__cancel__',
    initialIndex: 0,
    choices: [
      {
        label:       t('开启 Bundle', 'Enable Bundle'),
        value:       true,
        description: t('长提问时自动弹出"原版 vs 增强版"对比',
                       'Show original-vs-enhanced diff on long prompts'),
      },
      {
        label:       t('暂不开启', 'Skip for now'),
        value:       false,
        description: t('之后可以用 /bundle on 随时启用',
                       'You can run /bundle on later'),
      },
    ],
  })

  if (enable === '__cancel__' || enable === false) {
    await settingsStore.setBundleConfig({
      enabled: false,
      mode: 'auto',
      modelChoice: 'brain',
    })
    printPanel(
      t('Bundle 未启用', 'Bundle disabled'),
      [t('随时输入 /bundle on 开启。', 'Type /bundle on anytime to enable.')],
    )
    return
  }

  const mode = await chooseInteractiveOption<BundleMode>({
    title: t('选择触发方式', 'Choose trigger mode'),
    hint:  t('auto = 长输入自动弹窗；manual = 只在 /bundle 主动调用',
             'auto = popup on long input; manual = only when you run /bundle'),
    initialIndex: 0,
    choices: [
      {
        label:       'auto',
        value:       'auto',
        description: t('输入 ≥ 60 字且是自然语言时弹窗', 'Pops up when input ≥ 60 chars and looks descriptive'),
      },
      {
        label:       'manual',
        value:       'manual',
        description: t('只能用 /bundle <文字> 主动触发', 'Only via explicit /bundle <text>'),
      },
    ],
  })

  const modelChoice = await chooseInteractiveOption<BundleModelChoice>({
    title: t('润色模型使用哪一个？', 'Which model should polish?'),
    hint:  t('主模型 = 执行 API；副模型 = 思维 API',
             'Main = Execution API; Brain = Raven API'),
    initialIndex: 1,
    choices: [
      {
        label:       t('副模型（Brain / Raven）— 推荐', 'Brain (Raven) — recommended'),
        value:       'brain',
        description: t('通常成本低、速度快，适合做润色', 'Usually cheaper and faster, ideal for rewrites'),
      },
      {
        label:       t('主模型（Main）', 'Main model'),
        value:       'main',
        description: t('跟实际执行用同一个模型', 'Same model that executes the prompt'),
      },
    ],
  })

  await settingsStore.setBundleConfig({
    enabled: true,
    mode,
    modelChoice,
  })

  printPanel(
    t('Bundle 已启用', 'Bundle enabled'),
    [
      `${t('模式', 'Mode')}:       ${mode}`,
      `${t('润色模型', 'Polisher')}:   ${modelChoice}`,
      '',
      t('随时用 /bundle 调整或关闭。', 'Run /bundle anytime to tweak or turn off.'),
    ],
  )
}
