/**
 * utils/vendorNames.ts — AI vendors', products' and models' names in skill
 * text that hosts show their users (`artemis skills catalog|show --json`).
 *
 * The bundled skills and the optional pack are third-party playbooks: many
 * name the model or the coding assistant they were written for. A host must
 * not tell its users which vendor or model powers the agent, so the text a
 * host reads has those names replaced, and the skill-text guard
 * (scripts/skillTextGuard.ts) walks the whole catalog for any left.
 *
 * artemis-online keeps the same list (server/src/skills.ts), scrubs again,
 * and its CI walks the catalog against both lists.
 */

/**
 * Replaced in this order: model ids and names first (with a version or
 * tier, spaced or not), then the vendors' and their products' names, so
 * "Claude 3 Opus" becomes "a model", not "the agent 3 Opus".
 */
export const VENDOR_SCRUBS: ReadonlyArray<readonly [RegExp, string | ((match: string, ...groups: string[]) => string)]> = [
  // Links to the vendors' sites: the link text stays (scrubbed below), the address goes.
  [/\[([^\]\n]*)\]\(https?:\/\/(?:[\w-]+\.)*(?:claude\.ai|claude\.com|anthropic\.com|openai\.com|chatgpt\.com)(?:\/[^)\s]*)?\)/gi, '$1'],
  [/\bhttps?:\/\/(?:[\w-]+\.)*(?:claude\.ai|claude\.com|anthropic\.com|openai\.com|chatgpt\.com)(?:\/(?:[^\s)\]>"'`]*[^\s)\]>"'`.,;:!?])?)?/gi, "the provider's site"],
  // Model ids and names.
  [/\bclaude(?:[- ]\d+(?:[.-]\d+)*)?[- ](?:opus|sonnet|haiku|instant)(?:[- ]\d+(?:[.-]\d+)*)?(?:-\d{8})?/gi, 'a model'],
  [/\bclaude-\d(?:[\w.-]*\w)?/gi, 'a model'],
  [/\ban?\s+(?:sonnet|opus|haiku)\b/gi, (match) => (match[0] === 'A' ? 'A model' : 'a model')],
  [/\b(?:sonnet|opus|haiku)(?:[- ]\d+(?:[.-]\d+)*)?\b/gi, 'a model'],
  [/\bgpt[- ]?\d(?:[\w.]*\w)?(?:-[\w.]*\w)*/gi, 'a model'],
  [/\bgemini[- ](?:\d(?:[\w.]*\w)?|pro|flash|ultra|nano)(?:[- ](?:pro|flash|ultra|nano|lite|exp|preview|image|\d(?:[\w.]*\w)?))*/gi, 'a model'],
  [/\bdeepseek-[\w.-]*\w/gi, 'a model'],
  [/\b(?:llama|qwen|doubao|glm|kimi|mistral|kling|veo|sora|flux)-?\d[\w.-]*\w|\b(?:llama|qwen|glm|kimi|kling|veo|sora|flux)\d\b/gi, 'a model'],
  [/\bo[1-9](?:-(?:mini|pro|preview|high|low))*\b/g, 'a model'],
  [/\bdall-?e(?:[- ]?\d)?\b/gi, 'an image model'],
  [/\bwhisper(?:[- ](?:large|medium|small|base|tiny|v?\d)(?:-v?\d)*)?\b/gi, 'speech recognition'],
  [/\btext-embedding-[\w.-]*\w/gi, 'an embedding model'],
  // Products and vendors.
  [/\bclaude[- ]desktop\b/gi, 'a desktop AI app'],
  [/\bclaude\.ai\b/gi, 'an AI chat app'],
  [/\bclaude[- ]code\b/gi, 'the agent'],
  [/\bclaude\.md\b/gi, 'the instruction file'],
  // A path under the assistant's settings folder: the folder is dropped ("~/.claude/skills/x" → "~/skills/x").
  [/(^|[^\w.])\.claude\//gim, '$1'],
  [/(^|[^\w.])\.claude\b/gim, '$1'],
  [/\bclaude\b/gi, 'the agent'],
  [/\banthropic\b/gi, 'the provider'],
  [/\bchatgpt\b/gi, 'an AI assistant'],
  [/\bopenai\b/gi, 'an AI provider'],
  [/\bgpts\b/gi, 'AI assistants'],
  [/\bgpt\b/gi, 'AI'],
  [/\bgemini\b/gi, 'an AI assistant'],
  [/\bdeepseek\b/gi, 'an AI provider'],
]

/** Any of those names left in text: what the guards check the whole catalog against. */
export const VENDOR_NAMES = /\b(?:claude|anthropic|chatgpt|openai|gemini|deepseek|sonnet|opus|haiku|whisper|gpts?)\b|claude\.md|\bgpt[- ]?\d|\bdall-?e\b|text-embedding|\bo[1-9](?:-mini)?\b/i

/**
 * Skills whose very subject is wiring an app to third-party model APIs, for
 * developers: their instructions (the body only) keep the vendors' real
 * names, which the code they describe must use. Their name, summary and
 * description are scrubbed like any other. Keep this list short.
 */
export const VENDOR_BODY_ALLOWLIST: ReadonlySet<string> = new Set([
  // Vercel's AI SDK: the provider packages and model ids an app imports are the vendors' names.
  'cco-vercel-ai-sdk',
  // Vercel's AI Gateway: an app routes its model calls by the vendors' model ids.
  'cco-vercel-ai-gateway',
])

/** The platform's internal system names: never in what a host shows (third-party text included). */
export const HOST_INTERNAL_NAMES = /\b(?:saga|nidhogg|bragi|heimdall|bifrost|seedance|seedream|byteplus|dreamina|mnemosyne)\b/i

/** Text a host shows its users: internal names, AI vendors', products' and models' names replaced. */
export function scrubVendorNames(text: string, { keepVendors = false }: { keepVendors?: boolean } = {}): string {
  let out = text.replace(new RegExp(HOST_INTERNAL_NAMES.source, 'gi'), '…')
  if (keepVendors) return out
  for (const [pattern, to] of VENDOR_SCRUBS) out = out.replace(pattern, to as string)
  return out
}

/** Whether a skill's id or name is a vendor's (such a skill is left out of what hosts show). */
export function namesVendor(text: string): boolean {
  const spaced = text.replace(/[-_]/g, ' ')
  return VENDOR_NAMES.test(spaced) || HOST_INTERNAL_NAMES.test(spaced)
}
