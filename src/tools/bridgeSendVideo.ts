import type { AgentAction } from '../core/types.js'
import type { ToolExecutionContext, ToolExecutionResult } from './types.js'
import { formatBridgeVideoBroadcastResult, sendBragiVideoBroadcast } from '../bragi/imageBroadcast.js'

export async function executeBridgeSendVideo(
  action: AgentAction & {
    videoPath: string
    caption?: string
    platform?: 'telegram' | 'discord' | 'wechat' | 'all'
    targetId?: string
  },
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const result = await sendBragiVideoBroadcast({
    cwd: context.cwd,
    videoPath: action.videoPath,
    caption: action.caption,
    platform: action.platform,
    targetId: action.targetId,
    source: 'bridge_send_video',
  })

  return {
    action,
    ok: result.live.sent > 0 || result.configured.some(item => item.sent > 0),
    output: formatBridgeVideoBroadcastResult(result),
    data: result,
  }
}
