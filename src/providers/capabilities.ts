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
