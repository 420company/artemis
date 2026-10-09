// Short rendering rules for Saga's generated images and video segments. They
// are constraints on how to render, not on what: they never change the user's
// content, and raw mode (cleanDirect) never gets them.
//
//   - one protagonist body unless the script asks for more (motion and
//     montage are not a request for clones);
//   - no unrequested on-screen text, and requested text spelled correctly
//     (no wrong or invented Chinese characters);
//   - side-specific features stay on the character's own left or right.

/** Keep side-specific features on the character's anatomical side in every view and shot. */
export const ANATOMICAL_SIDE_RULE =
  "Side-specific features (a ring, a mole, a bag strap, a hair parting) stay on the character's own left or right in every view and shot; never mirror them.";

/** One protagonist body unless more were asked for. */
export const SINGLE_PROTAGONIST_RULE =
  'Exactly one protagonist body unless the script asks for twins or clones; movement and montage are one moving figure. Reflections and named secondary characters are fine.';

/** No unrequested text; requested text spelled exactly. */
export const ON_SCREEN_TEXT_RULE =
  'No on-screen text unless requested; requested text is spelled exactly, with no wrong or invented Chinese characters.';

/** The block appended to a Saga video segment prompt. */
export const SAGA_VIDEO_RENDERING_GUARDRAILS = [
  'Rendering rules:',
  `- ${SINGLE_PROTAGONIST_RULE}`,
  `- ${ON_SCREEN_TEXT_RULE}`,
  `- ${ANATOMICAL_SIDE_RULE}`,
].join('\n');

/** Characters the rules add to a prompt, separator included. */
export function renderingGuardrailsLength(): number {
  return SAGA_VIDEO_RENDERING_GUARDRAILS.length + 2;
}

/**
 * Appends the rendering rules when the whole prompt still fits the model's
 * limit; otherwise the prompt is returned unchanged, since the user's content
 * always has priority over the rules.
 */
export function appendRenderingGuardrails(prompt: string, maxPromptChars: number): { prompt: string; added: number } {
  const withRules = `${prompt}\n\n${SAGA_VIDEO_RENDERING_GUARDRAILS}`;
  if (withRules.length > maxPromptChars) return { prompt, added: 0 };
  return { prompt: withRules, added: withRules.length - prompt.length };
}
