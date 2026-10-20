/**
 * tools/enhanceScript.ts — the Saga panel's script pass, as a tool.
 *
 * One model call, no tools, and the result comes back to the caller instead
 * of disappearing into a render: that is the whole point. The panel put it in
 * the same box the owner pasted into, so the owner read it, edited it, and
 * only then pressed start. A pass whose output nobody can read before it is
 * filmed is not the same feature.
 *
 * The prompts themselves are in visual/scriptEnhance.ts, carried over from
 * the panel as the owner wrote them.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { AgentAction } from '../core/types.js';
import { chatCompletionContent, postSagaChatCompletion, resolveSagaChatEndpoint } from './visual/sagaChat.js';
import {
  buildScriptEnhancePrompt,
  checkSourceLength,
  describeScriptEnhanceMode,
  detectScriptEnhanceMode,
  parseEnhancedScript,
  type DirectorPackInput,
  type ScriptEnhanceMode,
} from './visual/scriptEnhance.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';
import { getMediaOutputRoot } from '../utils/mediaOutputRoot.js';
import { toolLog } from '../utils/log.js';
import { resolveConfiguredVisualProvider } from '../utils/visualGenerationConfig.js';
import { resolveVideoModelLimits } from './visual/videoModelLimits.js';
import { sagaSegmentPromptReserve } from './generateVideo.js';
import type { ScriptLimits } from './visual/scriptEnhance.js';

type EnhanceScriptAction = Extract<AgentAction, { type: 'enhance_script' }>;

/** A whole five-part script takes longer than a chat turn. */
const ENHANCE_TIMEOUT_MS = 6 * 60_000;

/** The configured video model's real limits; the action may name one instead. */
async function resolveScriptLimits(action: EnhanceScriptAction, cwd: string): Promise<ScriptLimits> {
  let provider = action.provider;
  let model = action.model;
  if (!provider || !model) {
    const configured = await resolveConfiguredVisualProvider(cwd, 'video').catch(() => null);
    provider = provider ?? configured?.config.video?.provider;
    model = model ?? configured?.config.video?.model;
  }
  if (!provider || !model) return { segmentPromptReserve: sagaSegmentPromptReserve() };
  const limits = resolveVideoModelLimits(provider, model);
  return {
    maxClipSeconds: limits.maxSegmentSeconds,
    maxPromptChars: limits.maxPromptChars,
    segmentPromptReserve: sagaSegmentPromptReserve(),
  };
}

/** Seconds as something a person reads: 4500 is "1 小时 15 分", not 4500. */
function formatDuration(seconds: number): string {
  if (seconds < 90) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

function directorInput(action: EnhanceScriptAction): DirectorPackInput {
  return {
    subject: action.subject ?? 'lead',
    ...(action.identityMode ? { identityMode: action.identityMode } : {}),
    ...(action.slots ? { slots: action.slots } : {}),
    ...(action.firstFrame ? { firstFrame: action.firstFrame } : {}),
    ...(action.lastFrame ? { lastFrame: action.lastFrame } : {}),
    ratio: action.ratio ?? '16:9',
    totalSeconds: action.totalSeconds ?? 60,
    ...(action.segmentCapSeconds ? { segmentCapSeconds: action.segmentCapSeconds } : {}),
    ...(action.subtitleMode ? { subtitleMode: action.subtitleMode } : {}),
  };
}

export async function executeEnhanceScript(
  action: EnhanceScriptAction,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  // A novel is pasted by dropping the file in, not by pasting 100,000
  // characters into a text box.
  let story = String(action.story ?? '').trim();
  if (!story && action.storyPath) {
    try {
      story = (await readFile(action.storyPath, 'utf8')).trim();
    } catch (error) {
      return { action, ok: false, output: `读不到剧本文件 ${action.storyPath}：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (!story) return { action, ok: false, output: '请先输入故事描述或粘贴剧本。' };

  // Checked before the call, not after: a text far longer than the film can
  // hold cannot be structured as written, and asking the model to try costs
  // the owner a long call to be told so. The budget comes from the model
  // actually configured -- a clip is 15 seconds on Seedance 2.0 and 30 on
  // 2.5, so the guide's old 6-10 is wrong by a factor of three.
  const totalSeconds = action.totalSeconds ?? 60;
  const limits = await resolveScriptLimits(action, context.cwd);
  const length = checkSourceLength(story, totalSeconds, limits);
  if (!length.fits && action.allowAdaptation !== true) {
    const { budget } = length;
    return {
      action,
      ok: false,
      output: [
        `这份文字 ${length.chars} 字，而 ${totalSeconds} 秒的片子装得下约 ${budget.minChars}-${budget.maxChars} 字（${budget.segments} 段 × 单段 ${budget.clipSeconds} 秒）——超了约 ${length.timesOver} 倍。`,
        '',
        '「不改你的字」在这个长度上做不到，所以先定一件事：',
        '· 拍其中一段：告诉我拍哪一章/哪一段，那一段按原文结构化，一个字不改。',
        '· 改编全文：我按总时长抽主线改成剧本，会丢掉大量原文，改完给你看了再拍。',
        `· 或者把总时长拉到约 ${formatDuration(length.secondsNeeded)}，这份文字就装得下了。`,
      ].join('\n'),
      data: { tooLong: true, chars: length.chars, budget, secondsNeeded: length.secondsNeeded },
    };
  }

  const mode: ScriptEnhanceMode = action.mode ?? detectScriptEnhanceMode(story);
  toolLog(describeScriptEnhanceMode(mode));

  const endpoint = await resolveSagaChatEndpoint(context.cwd);
  if (!endpoint) {
    return { action, ok: false, output: '增强失败：没有可用的模型配置。' };
  }

  const prompt = buildScriptEnhancePrompt({ mode, story, director: directorInput(action) });
  const response = await postSagaChatCompletion(
    endpoint,
    { model: endpoint.model, messages: [{ role: 'user', content: prompt }], temperature: 0.7 },
    { timeoutMs: ENHANCE_TIMEOUT_MS, ...(context.abortSignal ? { signal: context.abortSignal } : {}) },
  );
  if (!response.ok) {
    return { action, ok: false, output: `增强失败：${response.text}` };
  }
  const content = chatCompletionContent(response.text);
  if (!content || !content.trim()) {
    return { action, ok: false, output: '增强失败：模型没有返回剧本。' };
  }

  const result = parseEnhancedScript(content);
  if (!result.script) {
    // The model declined and offered nothing: the owner's own text stands.
    return {
      action,
      ok: false,
      output: `AI 判断这份剧本无法按原样结构化：${result.degraded?.reason ?? '未说明原因'}。你的原文没有被改动。`,
    };
  }

  // Written to disk as well as returned: the caller shows it in the box, and
  // a run that is interrupted has not lost the pass it already paid for.
  const dir = path.join(getMediaOutputRoot(), 'saga-scripts');
  await mkdir(dir, { recursive: true });
  const scriptPath = path.join(dir, `${Date.now()}-${mode}.txt`);
  await writeFile(scriptPath, result.script, 'utf8');

  const notice = result.degraded
    ? `\n\n注意：AI 检测到 ${result.degraded.reason}，无法以原样输出，上面是降级版本。你的原文没有被改动，要用哪一份由你决定。`
    : '';
  return {
    action,
    ok: true,
    output: `${mode === 'have_script' ? '已按原文补齐 saga 结构（没有改你的字）' : '已写出完整剧本'}：\n\n${result.script}${notice}`,
    data: {
      mode,
      script: result.script,
      scriptPath,
      original: story,
      ...(result.degraded ? { degraded: result.degraded } : {}),
    },
  };
}
