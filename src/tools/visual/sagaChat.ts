/**
 * Chat-completions requests made by the Saga pipeline itself (narrative
 * analysis, shot rewrites, framing, storyboard and character vision, the
 * language director), outside the agent loop.
 *
 * Two things every one of them needs:
 *   - a hard timeout, so a hung relay cannot freeze the wizard or a render;
 *   - parameter fallbacks: reasoning models (o-series, GPT-5.x and gateway
 *     aliases of them) reject a custom `temperature`, and some reject
 *     `max_tokens` in favour of `max_completion_tokens`. The request is
 *     retried without the rejected parameter, whatever the model is called.
 */
import { modelSupportsImages } from '../../providers/imageSupport.js';
import type { ProviderProfile } from '../../providers/types.js';
import { anyAbortSignal, resolveVisionProfile } from '../../core/visionHelper.js';
import { resolveConfiguredVisualProvider } from '../../utils/visualGenerationConfig.js';

/** Time limit for one Saga chat request. */
export const SAGA_CHAT_TIMEOUT_MS = 90_000;

export type SagaChatEndpoint = {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Where the endpoint came from, for logs. */
  source: 'main-profile' | 'vision-profile' | 'image-provider';
};

export type SagaChatResponse =
  | { ok: true; status: number; text: string }
  | { ok: false; status?: number; text: string; timedOut: boolean };

/** Model used when the endpoint names none (a main profile without a model, or the image provider without a vision model). */
const DEFAULT_CHAT_MODEL = 'gpt-5.5';

/**
 * Models known to accept only the default temperature. The request still
 * falls back on the API's answer for any other model; this only saves the
 * first round trip for the well-known families.
 */
export function rejectsCustomTemperature(model: string | undefined): boolean {
  const name = String(model ?? '').split('/').pop()?.trim() ?? '';
  return /^(?:o[1-9]|gpt-5)/i.test(name);
}

function isParameterRejection(status: number, text: string, parameter: RegExp): boolean {
  return (status === 400 || status === 422) && parameter.test(text);
}

/**
 * Removes or renames the parameter a 400/422 answer complains about.
 * Returns false when nothing in the body explains the rejection.
 */
function relaxRejectedParameter(body: Record<string, unknown>, status: number, text: string): boolean {
  if ('temperature' in body && isParameterRejection(status, text, /temperature/i)) {
    delete body.temperature;
    return true;
  }
  if ('max_tokens' in body && isParameterRejection(status, text, /max_completion_tokens|max_tokens/i)) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
    return true;
  }
  return false;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/**
 * POSTs one chat-completions request with a timeout and the parameter
 * fallbacks above. Callers keep their own retry policy for 429/5xx and
 * network errors; a timeout comes back as `timedOut: true`.
 */
export async function postSagaChatCompletion(
  endpoint: { apiKey: string; baseUrl: string },
  requestBody: Record<string, unknown>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<SagaChatResponse> {
  const body: Record<string, unknown> = { ...requestBody };
  if (rejectsCustomTemperature(typeof body.model === 'string' ? body.model : undefined)) delete body.temperature;
  const url = endpoint.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const timeoutMs = options.timeoutMs ?? SAGA_CHAT_TIMEOUT_MS;
  // One retry per parameter the API may reject.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${endpoint.apiKey}` },
        body: JSON.stringify(body),
        signal: anyAbortSignal(AbortSignal.timeout(timeoutMs), options.signal),
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        return { ok: false, text: `no response within ${Math.round(timeoutMs / 1000)}s`, timedOut: true };
      }
      return { ok: false, text: error instanceof Error ? error.message : String(error), timedOut: false };
    }
    let text: string;
    try {
      text = await res.text();
    } catch (error) {
      return { ok: false, status: res.status, text: error instanceof Error ? error.message : String(error), timedOut: isTimeoutError(error) };
    }
    if (res.ok) return { ok: true, status: res.status, text };
    if (relaxRejectedParameter(body, res.status, text)) continue;
    return { ok: false, status: res.status, text, timedOut: false };
  }
  return { ok: false, text: 'the chat API kept rejecting the request parameters', timedOut: false };
}

/** The text content of a chat-completions response, or undefined. */
export function chatCompletionContent(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = parsed.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : undefined;
  } catch {
    return undefined;
  }
}

function endpointOf(profile: ProviderProfile, source: SagaChatEndpoint['source']): SagaChatEndpoint | null {
  const apiKey = profile.apiKey?.trim();
  const baseUrl = profile.baseUrl?.trim();
  if (!apiKey || !baseUrl) return null;
  return { apiKey, baseUrl, model: profile.model?.trim() || DEFAULT_CHAT_MODEL, source };
}

/**
 * The chat endpoint for a Saga request: the main profile, or the image
 * provider's endpoint as a last resort. When the request carries images and
 * the main model cannot see them, the configured vision profile
 * (visionProfileId) is used instead, the same one the agent's vision helper
 * uses; only an OpenAI-protocol profile qualifies, since these requests are
 * chat completions.
 */
export async function resolveSagaChatEndpoint(
  cwd: string,
  options: { needsImages?: boolean } = {},
): Promise<SagaChatEndpoint | null> {
  let main: ProviderProfile | undefined;
  try {
    const { ProviderStore } = await import('../../providers/store.js');
    const store = await new ProviderStore(cwd).load();
    main = store?.profiles?.find((profile) => profile.id === (store?.defaultMainProfileId ?? 'main'));
  } catch { /* fall through to the other sources */ }

  if (options.needsImages && (!main || !modelSupportsImages(main))) {
    const vision = await resolveVisionProfile(cwd).catch(() => undefined);
    if (vision && vision.profile.protocol === 'openai') {
      const endpoint = endpointOf(vision.profile, 'vision-profile');
      if (endpoint) return endpoint;
    }
  }
  if (main) {
    const endpoint = endpointOf(main, 'main-profile');
    if (endpoint) return endpoint;
  }

  const imageConfigured = await resolveConfiguredVisualProvider(cwd, 'image');
  const apiKey = imageConfigured?.config.image.apiKey?.trim();
  const baseUrl = imageConfigured?.config.image.baseUrl?.trim();
  if (!apiKey || !baseUrl) return null;
  // Prefer the image provider's configured vision model over a guessed name;
  // image-generation model names are never sent to chat completions.
  const visionModel = imageConfigured?.config.image.visionModel?.trim();
  const model = visionModel && !/image|dall[-_]?e/i.test(visionModel) ? visionModel : DEFAULT_CHAT_MODEL;
  return { apiKey, baseUrl, model, source: 'image-provider' };
}
