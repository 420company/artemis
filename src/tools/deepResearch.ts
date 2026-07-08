import { CliSettingsStore } from '../cli/settings.js';
import { pickLocale } from '../cli/locale.js';
import {
  formatGeminiDeepResearchReport,
  runGeminiDeepResearch,
} from '../research/geminiDeepResearch.js';
import { runLocalDeepResearch } from '../research/localDeepResearch.js';
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

    // Gemini Deep Research when configured (explicit engine choice or key
    // present) — it is the deeper engine. Otherwise fall back to the builtin
    // local loop (worker provider + web search) instead of erroring out.
    const useGemini = settings.researchEngine === 'gemini-deep-research' || hasGeminiApiKey;

    if (!useGemini) {
      const local = await runLocalDeepResearch({
        prompt: action.query,
        cwd: context.cwd,
        locale,
        systemInstruction: action.systemInstruction,
      });
      if (local.status !== 'completed') {
        return {
          action,
          ok: false,
          output: pickLocale(locale, {
            zh: `本地深度研究失败：${local.error ?? '未知原因'}\n（配置 Gemini Deep Research 可获得更强的研究能力：artemis setup docs）`,
            en: `Local deep research failed: ${local.error ?? 'unknown reason'}\n(Configure Gemini Deep Research for a deeper engine: artemis setup docs)`,
          }),
        };
      }
      return {
        action,
        ok: true,
        output: [
          pickLocale(locale, {
            zh: `[本地研究引擎] 轮次: ${local.roundsRun} · 读取页面: ${local.pagesRead} · 来源: ${local.sources.length}`,
            en: `[Local research engine] rounds: ${local.roundsRun} · pages read: ${local.pagesRead} · sources: ${local.sources.length}`,
          }),
          '',
          local.reportMarkdown ?? '',
        ].join('\n'),
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
        zh: `Deep Research 执行失败：${message}`,
        en: `Deep Research failed: ${message}`,
      }),
    };
  }
}
