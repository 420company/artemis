/**
 * Model capabilities written by the agent server.
 *
 * On the hosted platform the engine talks to a gateway that serves chat
 * models under alias names (`gpt-6-sol` may be a text-only GLM model), so
 * nothing can be inferred from the name. The server writes the real values
 * into the provider profile and marks it `capabilitiesSource: "platform"`:
 *
 *   supportsImages   boolean  (also honoured without the marker, see imageSupport.ts)
 *   contextLength    tokens
 *   maxOutputTokens  tokens
 *
 * With the marker, these values win over every name-based rule (known-model
 * tables, the GPT-5.6 / GPT-6 caps, /models metadata). Without it nothing
 * changes.
 */
import type { SessionMessage } from '../core/types.js'
import { estimateImageTokens, estimateMessagesTokens, estimateTokens } from '../core/tokenEstimation.js'
import type { ProviderRequestOptions } from './types.js'

/** Profile fields that decide the context window and max output. */
export type ModelCapabilityConfig = {
  model?: string
  contextLength?: number
  maxOutputTokens?: number
  capabilitiesSource?: string
}

function positiveTokens(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const rounded = Math.round(value)
  return rounded > 0 ? rounded : undefined
}

/** True when the agent server wrote the profile's capabilities. */
export function hasPlatformCapabilities(config: ModelCapabilityConfig | null | undefined): boolean {
  return config?.capabilitiesSource === 'platform'
}

/** The platform-supplied context window, or undefined for any other profile. */
export function platformContextLength(config: ModelCapabilityConfig | null | undefined): number | undefined {
  return hasPlatformCapabilities(config) ? positiveTokens(config?.contextLength) : undefined
}

/** The platform-supplied max output tokens, or undefined for any other profile. */
export function platformMaxOutputTokens(config: ModelCapabilityConfig | null | undefined): number | undefined {
  return hasPlatformCapabilities(config) ? positiveTokens(config?.maxOutputTokens) : undefined
}

/** Smallest output budget a request is ever given, even with a nearly full window. */
const MIN_OUTPUT_TOKENS = 256

/**
 * Estimated prompt size of one request: its messages, any attached images and
 * the tool definitions. Image data is counted per image, not by its base64.
 */
export function estimateRequestPromptTokens(
  messages: readonly SessionMessage[],
  options?: Pick<ProviderRequestOptions, 'imageAttachments' | 'nativeFunctionTools'>,
): number {
  return estimateMessagesTokens([...messages]) +
    estimateImageTokens(options?.imageAttachments?.length ?? 0) +
    (options?.nativeFunctionTools?.length ? estimateTokens(JSON.stringify(options.nativeFunctionTools)) : 0)
}

/**
 * Lowers an output limit so prompt + output stays inside the context window:
 * min(limit, window − estimated prompt − margin). Some providers reject a
 * request whose prompt plus max_tokens exceeds the window, and output caps
 * can be large (128K–384K). The margin (2% of the window, at least 1024
 * tokens) absorbs estimation error. Unknown window: the limit is unchanged.
 */
export function fitOutputTokensToWindow(
  limit: number,
  contextLength: number | undefined,
  promptTokens: number,
): number {
  if (!contextLength || contextLength <= 0) return limit
  const margin = Math.max(1024, Math.ceil(contextLength * 0.02))
  const room = Math.floor(contextLength - promptTokens - margin)
  return Math.min(limit, Math.max(MIN_OUTPUT_TOKENS, room))
}
