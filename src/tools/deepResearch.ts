import { CliSettingsStore } from '../cli/settings.js';
import { pickLocale } from '../cli/locale.js';
import {
  formatGeminiDeepResearchReport,
  runGeminiDeepResearch,
} from '../research/geminiDeepResearch.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';
import type { AgentAction } from '../core/types.js';

export async function executeDeepResearch(
  action: Extract<AgentAction, { type: 'deep_research' }>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const locale = context.locale ?? 'en';
  try {
    const settingsStore = new CliSettingsStore(context.cwd);
    const settings = await settingsStore.load();
    const hasGeminiApiKey = Boolean(
      process.env.ARTEMIS_GEMINI_API_KEY ||
      process.env.GEMINI_API_KEY ||
      settings.geminiApiKey,
    );
    if (settings.researchEngine !== 'gemini-deep-research' && !hasGeminiApiKey) {
      return {
        action,
        ok: false,
        output: pickLocale(locale, {
          zh: 'Gemini Deep Research 尚未配置。请运行 `artemis setup docs` 并选择 Gemini Deep Research，或设置 ARTEMIS_GEMINI_API_KEY / GEMINI_API_KEY。',
          en: 'Gemini Deep Research is not configured. Run `artemis setup docs` and choose Gemini Deep Research, or set ARTEMIS_GEMINI_API_KEY / GEMINI_API_KEY.',
        }),
      };
    }
    const result = await runGeminiDeepResearch({
      prompt: action.query,
      settings,
      systemInstruction: action.systemInstruction,
      maxPolls: action.maxPolls,
      pollIntervalMs: action.pollIntervalMs,
    });
    return {
      action,
      ok: result.status === 'completed',
      output: formatGeminiDeepResearchReport({
        query: action.query,
        result,
        locale,
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      action,
      ok: false,
      output: pickLocale(locale, {
        zh: `Gemini Deep Research 执行失败：${message}`,
        en: `Gemini Deep Research failed: ${message}`,
      }),
    };
  }
}
