import { CliSettingsStore } from '../cli/settings.js';
import { pickLocale } from '../cli/locale.js';
import {
  formatGeminiDeepResearchReport,
  runGeminiDeepResearch,
} from '../research/geminiDeepResearch.js';
import { runLocalDeepResearch } from '../research/localDeepResearch.js';
import { reportLocale, writeResearchReport, type ReportSource } from '../research/researchReport.js';
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
      const saved = await saveReport(context.cwd, action.query, local.reportBody ?? local.reportMarkdown ?? '', local.sources);
      return {
        action,
        ok: true,
        output: [
          pickLocale(locale, {
            zh: `[本地研究引擎] 轮次: ${local.roundsRun} · 读取页面: ${local.pagesRead} · 来源: ${local.sources.length}`,
            en: `[Local research engine] rounds: ${local.roundsRun} · pages read: ${local.pagesRead} · sources: ${local.sources.length}`,
          }),
          ...reportNotice(saved),
          '',
          saved?.markdown ?? local.reportMarkdown ?? '',
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
    const saved = result.status === 'completed' && result.text.trim()
      ? await saveReport(context.cwd, action.query, result.text, [])
      : undefined;
    return {
      action,
      ok: result.status === 'completed',
      output: [
        formatGeminiDeepResearchReport({
          query: action.query,
          result,
          locale,
        }),
        ...reportNotice(saved),
      ].join('\n'),
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

type SavedReport = { markdownPath: string; htmlPath: string; pdfPath?: string; markdown: string };

/** Writes the cited report into the workspace (reports/); a failure leaves the answer in the tool output only. */
async function saveReport(cwd: string, question: string, body: string, sources: ReportSource[]): Promise<SavedReport | undefined> {
  if (!body.trim()) return undefined;
  try {
    const written = await writeResearchReport(cwd, { question, body, sources, locale: reportLocale(question) });
    return {
      markdownPath: written.markdownPath,
      htmlPath: written.htmlPath,
      ...(written.pdfPath ? { pdfPath: written.pdfPath } : {}),
      markdown: written.report.markdown,
    };
  } catch {
    return undefined;
  }
}

/** What the model is told about the saved report, so its reply names it (the app shows it as a report card). */
function reportNotice(saved: SavedReport | undefined): string[] {
  if (!saved) return [];
  return [
    `[Report saved] ${saved.markdownPath} (web page: ${saved.htmlPath}${saved.pdfPath ? `; PDF: ${saved.pdfPath}` : ''})`,
    `In your reply: give the answer in a short summary (3-5 key findings, each keeping its [n] citation), then put the path ${saved.markdownPath} alone on its own line so the user can open the full report with its sources. Do not paste the whole report.`,
  ];
}
