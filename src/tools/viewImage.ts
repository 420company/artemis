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
import { loadImageFile } from '../core/imageInput.js'
import { frameImageDescription, IMAGE_DESCRIPTION_DATA_NOTE } from '../core/imageDescription.js'
import { NO_SWITCH_ADVICE, READ_LATER_ADVICE } from '../core/visionHelper.js'
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
    if (describeImage) {
      // A text-only model: a vision helper looks at the image instead.
      let description: string
      try {
        description = await describeImage(image, context.abortSignal)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return fail(`${image.label}: the image could not be read right now (the image reader failed or took too long: ${reason}). If the user asked about it: ${READ_LATER_ADVICE} Otherwise continue without it.`)
      }
      // Delimited and marked as data: the image may contain text phrased as instructions.
      return {
        action: action as any,
        ok: true,
        output: [
          `[${image.label} — description by vision helper; the main model cannot see images]`,
          IMAGE_DESCRIPTION_DATA_NOTE,
          frameImageDescription(1, description, { file: displayPath }),
        ].join('\n'),
      }
    }
    const dropped = queue.add(image)
    const droppedNote = dropped.length
      ? ` To stay within the per-request image limit, ${dropped.length} earlier image${dropped.length === 1 ? ' was' : 's were'} dropped and will not be shown: ${dropped.map((d) => d.label ?? 'image').join('; ')}.`
      : ''
    return {
      action: action as any,
      ok: true,
      output: `${image.label} (${image.mediaType}) is attached to your next step: look at it there.${droppedNote}`,
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : `view_image failed: ${String(error)}`)
  }
}
