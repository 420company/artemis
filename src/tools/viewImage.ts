/**
 * tools/viewImage.ts — let the model look at an image file.
 *
 * The image is attached to the model's next request (see core/imageInput.ts),
 * so the agent can check a screenshot it took, a picture it generated, or an
 * image the user uploaded, the way a person would glance at it.
 */
import type { ToolExecutionContext, ToolExecutionResult } from './types.js'
import { ImageInputError, loadImageForModel, queueImage } from '../core/imageInput.js'

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
  if (!context.sessionId) return fail('view_image needs a session to attach the image to')
  try {
    const image = await loadImageForModel(action.path, context.cwd)
    queueImage(context.sessionId, image)
    return {
      action: action as any,
      ok: true,
      output: `${image.label} (${image.mediaType}) is attached to your next step: look at it there.`,
    }
  } catch (error) {
    return fail(error instanceof ImageInputError ? error.message : `view_image failed: ${String(error)}`)
  }
}
