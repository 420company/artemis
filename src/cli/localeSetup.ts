import type { PromptIO } from '../providers/types.js';
import { CliSettingsStore } from './settings.js';
import { choosePromptOption } from './prompt.js';
import {
  formatUiLocaleLabel,
  pickLocale,
  type UiLocale,
} from './locale.js';

export async function ensureUiLocaleConfigured(options: {
  cwd: string;
  promptIO?: PromptIO;
  onInfo?: (message: string) => void;
}): Promise<UiLocale> {
  const settingsStore = new CliSettingsStore(options.cwd);
  const settings = await settingsStore.load();

  if (settings.uiLocaleConfigured) {
    return settings.uiLocale;
  }

  if (options.promptIO?.available !== true) {
    return settings.uiLocale;
  }

  const locale = await choosePromptOption(options.promptIO, {
    title: 'Choose language / 选择语言',
    choices: [
      {
        label: 'Chinese / 中文',
        value: 'zh-CN' as UiLocale,
      },
      {
        label: 'English / 英文',
        value: 'en' as UiLocale,
      },
    ],
    initialIndex: 0,
    hint: 'Use ↑ ↓ and Enter',
  });
  await settingsStore.setUiLocale(locale);

  options.onInfo?.(
    pickLocale(locale, {
      zh: `[ui] 界面语言 -> ${formatUiLocaleLabel(locale)}`,
      en: `[ui] interface language -> ${formatUiLocaleLabel(locale)}`,
    }),
  );

  return locale;
}
