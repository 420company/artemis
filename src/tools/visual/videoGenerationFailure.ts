// Turns a failed video generation into a message the user can act on, for
// generate_video, Saga segment failures and the progress lines Telegram and
// the web app show. The cause is classified by generationFailure.ts, the same
// classifier generate_image uses. The raw provider error is never dropped: it
// stays in the log line and in the tool output's details, where Saga's retry
// logic and the agent read it.

import { pickLocale, type UiLocale } from '../../cli/locale.js';
import type { ToolError } from '../types.js';
import {
  classifyGenerationFailure,
  summarizeFailureDetail,
  type GenerationFailureKind,
  type GenerationStage,
} from './generationFailure.js';

export type VideoGenerationFailureInput = {
  /** Raw error text from the provider. */
  detail: string;
  /** HTTP status of the generation API call, when the provider reported one. */
  status?: number;
  stage?: GenerationStage;
};

export type VideoGenerationFailure = {
  kind: GenerationFailureKind;
  /** One plain sentence for the user, in their language, without provider internals. */
  userMessage: string;
  /** The shortened raw provider error, for logs and the tool output. */
  details: string;
  /** Whether resubmitting the same request may succeed. */
  retryable: boolean;
};

const USER_MESSAGES: Record<GenerationFailureKind, { zh: string; en: string }> = {
  insufficient_balance: {
    zh: '视频生成服务余额不足，请充值后重新发起生成。',
    en: 'The video service balance is too low. Top up, then start the generation again.',
  },
  rate_limited: {
    zh: '视频生成服务当前限流，请稍等一两分钟再重新发起生成。',
    en: 'The video service is rate-limiting requests. Wait a minute or two, then try again.',
  },
  payload_too_large: {
    zh: '请求太大（参考图或提示词过大），请减少或压缩参考素材后重试。',
    en: 'The request is too large. Use fewer or smaller reference files, or a shorter prompt, then try again.',
  },
  content_rejected: {
    zh: '视频生成服务的内容审核拒绝了这次请求，请修改描述或参考素材后重试。',
    en: "The video service's content filter rejected this request. Change the description or the reference files, then try again.",
  },
  not_configured: {
    zh: '视频生成还没有配置好，请先设置视频服务（/config visual）。',
    en: 'Video generation is not set up yet. Configure the video service (/config visual) first.',
  },
  unauthorized: {
    zh: '视频生成服务拒绝了 API 密钥，请检查视频服务的密钥设置（/config visual）。',
    en: 'The video service rejected the API key. Check the video service key (/config visual).',
  },
  download_failed: {
    zh: '视频已生成，但下载失败，请稍后重试。',
    en: 'The video was generated but could not be downloaded. Try again shortly.',
  },
  timeout: {
    zh: '视频生成服务在规定时间内没有完成，可能是排队拥堵，请稍后重新发起生成。',
    en: 'The video service did not finish in time, probably because its queue is busy. Try again later.',
  },
  upstream: {
    zh: '视频生成服务暂时出错，请稍后重新发起生成。',
    en: 'The video service had a temporary error. Try again later.',
  },
};

const RETRYABLE: ReadonlySet<GenerationFailureKind> = new Set(['rate_limited', 'download_failed', 'timeout', 'upstream']);

export function describeVideoGenerationFailure(input: VideoGenerationFailureInput, locale: UiLocale = 'en'): VideoGenerationFailure {
  const kind = classifyGenerationFailure(input);
  return {
    kind,
    userMessage: pickLocale(locale, USER_MESSAGES[kind]),
    details: summarizeFailureDetail(input.detail ?? '') || 'unknown error',
    retryable: RETRYABLE.has(kind),
  };
}

/** The ToolError a failed video tool result carries, so callers need not re-parse its text. */
export function videoFailureToolError(failure: VideoGenerationFailure, status?: number): ToolError {
  return {
    code: `video_${failure.kind}`,
    message: failure.userMessage,
    retryable: failure.retryable,
    details: { kind: failure.kind, ...(status !== undefined ? { httpStatus: status } : {}) },
  };
}

/** The failure kind a video tool result carries, when it carries one. */
export function videoFailureKindOf(error: ToolError | undefined): GenerationFailureKind | undefined {
  const kind = error?.details?.kind;
  return typeof kind === 'string' && kind in USER_MESSAGES ? (kind as GenerationFailureKind) : undefined;
}

/** The user-facing sentence for a kind, in the given locale. */
export function videoFailureUserMessage(kind: GenerationFailureKind, locale: UiLocale = 'en'): string {
  return pickLocale(locale, USER_MESSAGES[kind]);
}
