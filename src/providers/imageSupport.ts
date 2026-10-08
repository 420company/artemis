/**
 * Whether a chat model accepts image input.
 *
 * A provider profile can say so explicitly with `supportsImages`; otherwise the
 * answer is inferred from the model name, conservatively: known vision
 * families say yes, DeepSeek and everything unrecognised say no. A wrong "no"
 * only hides view_image and rejects --image (the profile flag fixes it); a
 * wrong "yes" makes requests fail, so unknown models stay text-only.
 */

/** Families that never take images, checked first (some share a vendor prefix with vision models). */
const TEXT_ONLY_MODEL_PATTERNS: readonly RegExp[] = [
  /deepseek(?![\w.-]*-vl)/,
  /claude-(?:instant|2)/,
  /gpt-3\.5/,
  /\bo[13]-mini\b/,
  /\bqwq\b/,
  /coder/,
  /embedding/,
];

/** Model families known to accept images. */
const VISION_MODEL_PATTERNS: readonly RegExp[] = [
  /claude/,
  /gpt-4o|gpt-4\.1|gpt-4\.5|gpt-4-turbo|gpt-4-vision|gpt-5|chatgpt-4o/,
  /(?:^|[/:])o[134](?:-pro|-mini)?(?:$|[-:])/,
  /gemini|gemma-3/,
  /qwen[\w.-]*-vl|qwen-vl|qvq|qwen[\w.-]*-omni|qwen3\.5|qwen3-vl/,
  /glm-[\d.]+v|glm-4v/,
  /grok-(?:2-)?vision|grok-4/,
  /llama-?4|llama-?3\.2[\w.-]*vision/,
  /pixtral|mistral-medium-3|mistral-small-3\.[12]/,
  /doubao[\w.-]*(?:vision|seed)/,
  /kimi-k2\.5|kimi-vl|kimi-latest|moonshot-v1[\w.-]*-vision/,
  /minimax-vl|step-1v|step-1o|internvl|llava|minicpm-v/,
  /(?:^|[-_/.:])(?:vl|vision|omni|multimodal)(?:$|[-_/.:])/,
];

export function inferModelSupportsImages(model: string): boolean {
  const name = model.trim().toLowerCase();
  if (!name) return false;
  if (TEXT_ONLY_MODEL_PATTERNS.some((pattern) => pattern.test(name))) return false;
  return VISION_MODEL_PATTERNS.some((pattern) => pattern.test(name));
}

/** The explicit profile flag when set, otherwise the inference from the model name. */
export function modelSupportsImages(config: { model: string; supportsImages?: boolean }): boolean {
  if (typeof config.supportsImages === 'boolean') return config.supportsImages;
  return inferModelSupportsImages(config.model);
}

/**
 * Text that stands in for images a model cannot see, so the request still
 * makes sense. Worded so it does not invite switching models.
 */
export function describeOmittedImages(count: number): string {
  return `[${count} image${count === 1 ? '' : 's'} not shown: they cannot be read in this request]`;
}
