import type { AgentAction } from '../core/types.js'
import type { ToolExecutionContext, ToolExecutionResult } from './types.js'
import { formatBridgeImageBroadcastResult, sendBragiImageBroadcast } from '../bragi/imageBroadcast.js'
import { executeBridgeSendVideo } from './bridgeSendVideo.js'

export async function executeBridgeSendImage(
  action: AgentAction & {
    imagePath: string
    caption?: string
    platform?: 'telegram' | 'discord' | 'wechat' | 'all'
    targetId?: string
  },
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const imagePath = action.imagePath.trim()
  const normalizedImagePath = imagePath.toLowerCase()
  if (
    normalizedImagePath === 'latest_dream_video'
    || normalizedImagePath === 'latestdreamvideo'
    || normalizedImagePath === 'latest dream video'
    || normalizedImagePath === 'latest-dream-video'
    || /\.mp4(?:$|[?#])/i.test(imagePath)
  ) {
    return executeBridgeSendVideo(
      {
        ...action,
        type: 'bridge_send_video',
        videoPath: imagePath,
      } as AgentAction & {
        videoPath: string
        caption?: string
        platform?: 'telegram' | 'discord' | 'wechat' | 'all'
        targetId?: string
      },
      context,
    )
  }

  const result = await sendBragiImageBroadcast({
    cwd: context.cwd,
    imagePath: action.imagePath,
    caption: action.caption,
    platform: action.platform,
    targetId: action.targetId,
    source: 'bridge_send_image',
  })

  return {
    action,
    ok: result.live.sent > 0 || result.configured.some(item => item.sent > 0),
    output: formatBridgeImageBroadcastResult(result),
    data: result,
  }
}
