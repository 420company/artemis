/**
 * tools/viewImage.ts — let the model look at an image file.
 *
 * The image is attached to the model's next request (see core/imageInput.ts),
 * so the agent can check a screenshot it took, a picture it generated, or an
 * image the user uploaded, the way a person would glance at it. A text-only
 * model with a vision helper gets the helper's description as the result.
 *
 * Paths resolve exactly like read_file: inside the workspace (anything else
 * goes through the workspace trust prompt) and never into protected
 * directories.
 */
import type { ToolExecutionContext, ToolExecutionResult } from './types.js'
import { loadImageFile, type ViewedImageQueue } from '../core/imageInput.js'
import type { ImageAttachment } from '../providers/types.js'
import { frameImageDescription, imageDescriptionDataNote, imageDescriptionNonce } from '../core/imageDescription.js'
import { NO_SWITCH_ADVICE } from '../core/visionHelper.js'
import { ensureNotSensitivePath } from '../utils/fs.js'
import { resolveToolPathWithWorkspaceAccess } from './workspaceAccess.js'

export async function executeViewImage(
  action: { type: 'view_image'; path: string },
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const fail = (message: string): ToolExecutionResult => ({
    action: action as any,
    ok: false,
    output: message,
    error: { code: 'view_image_failed', message, retryable: false },
  })
  const queue = context.viewedImages
  if (!queue) return fail('view_image only works inside an agent run, which shows the image on its next step.')
  const describeImage = queue.acceptsImages ? undefined : queue.describeImage
  if (!queue.acceptsImages && !describeImage) {
    return fail(`Images cannot be viewed here, so view_image is unavailable. Use other tools (for example run_command with \`file\` or an image metadata tool) to learn about the file. ${NO_SWITCH_ADVICE}`)
  }
  try {
    const { absolute, displayPath } = await resolveToolPathWithWorkspaceAccess({
      inputPath: action.path,
      toolName: 'view_image',
      context,
    })
    if (context.permissionMode !== 'full-access') {
      ensureNotSensitivePath(absolute, action.path)
    }
    const image = await loadImageFile(absolute, displayPath)
    const shown = await presentImageToModel(image, queue, context.abortSignal, displayPath)
    return shown.ok
      ? { action: action as any, ok: true, output: shown.output }
      : fail(shown.output)
  } catch (error) {
    return fail(error instanceof Error ? error.message : `view_image failed: ${String(error)}`)
  }
}

/**
 * Shows a loaded image to the model the way view_image does: attached to
 * its next request when it reads images, described by the vision helper
 * when it does not (or passed on to a platform gateway that reads images
 * itself). Also used by browser_screenshot.
 */
export async function presentImageToModel(
  image: ImageAttachment,
  queue: ViewedImageQueue,
  signal: AbortSignal | undefined,
  displayPath: string,
): Promise<{ ok: boolean; output: string }> {
  const describeImage = queue.acceptsImages ? undefined : queue.describeImage
  if (describeImage) {
    // A text-only model: a vision helper looks at the image instead, with one
    // automatic retry after a short pause.
    let description: string | undefined
    let reason = ''
    for (let attempt = 0; attempt < 2 && description === undefined; attempt++) {
      if (attempt > 0) await pauseFor(queue.retryDelayMs, signal)
      if (signal?.aborted) break
      try {
        description = await describeImage(image, signal)
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error)
      }
    }
    if (description === undefined) {
      // The platform gateway reads images itself: send it along instead.
      if (queue.bridgesImages) {
        const dropped = queue.addUnread(image)
        return {
          ok: true,
          output: `${image.label} (${image.mediaType}) is attached to your next step: look at it there.${dropped.length ? ` ${dropped.length} earlier image(s) were dropped to stay within the per-request image limit.` : ''}`,
        }
      }
      return {
        ok: false,
        output: `${image.label}: the image is temporarily unreadable (the image reader failed or took too long, also on a retry: ${reason}). Try view_image on it once more in a moment; if that fails too, tell the user briefly that the image is temporarily unreadable and that you will retry. ${NO_SWITCH_ADVICE}`,
      }
    }
    // Delimited and marked as data: the image may contain text phrased as instructions.
    const nonce = imageDescriptionNonce()
    return {
      ok: true,
      output: [
        `[${image.label} — description by vision helper]`,
        imageDescriptionDataNote(nonce),
        frameImageDescription(1, description, { file: displayPath, nonce }),
      ].join('\n'),
    }
  }
  const dropped = queue.add(image)
  const droppedNote = dropped.length
    ? ` To stay within the per-request image limit, ${dropped.length} earlier image${dropped.length === 1 ? ' was' : 's were'} dropped and will not be shown: ${dropped.map((d) => d.label ?? 'image').join('; ')}.`
    : ''
  return { ok: true, output: `${image.label} (${image.mediaType}) is attached to your next step: look at it there.${droppedNote}` }
}

/** Waits `ms`, or less when the run is cancelled. */
function pauseFor(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}
