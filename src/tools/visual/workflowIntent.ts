type WorkflowIntentClassifierOptions = {
  workflowTerms: RegExp;
  creationSyntax: (text: string) => boolean;
  systemSurfaceTerms?: RegExp;
};

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const QUESTION_OR_REVIEW_RE = /(?:为什么|怎么回事|怎么|如何|没搞懂|有没有|是否|能不能|能否|可以吗|吗|？|\?|检查|审查|review|修复|实现|逻辑|代码|文档|支持|不支持|bug|问题|报错|失败|触发|没有)/i;
const DIRECT_CREATION_MARKER_RE = /(?:请|帮我|给我|我要|我想|需要|现在|直接|开始|please|can you|could you|for me)/i;
const DEFAULT_SYSTEM_SURFACE_RE = /(?:工作流|流程|引导|触发|提示|确认|系统|功能|逻辑|代码|发送|发给手机|发送到手机|手机|Discord|Telegram|WeChat|bridge|投递|完成后|生成完成|主动发送|主动把视频发|generate_video|generate_long_video)/i;

export function hasDirectCreationRequestMarker(text: string): boolean {
  return DIRECT_CREATION_MARKER_RE.test(text);
}

export function isWorkflowSupportDiscussion(
  text: string,
  options: WorkflowIntentClassifierOptions,
): boolean {
  const normalized = compact(text);
  if (!normalized) return false;

  if (!options.workflowTerms.test(normalized)) return false;
  if (!QUESTION_OR_REVIEW_RE.test(normalized)) return false;

  const systemSurfaceTerms = options.systemSurfaceTerms ?? DEFAULT_SYSTEM_SURFACE_RE;
  const mentionsSystemSurface = systemSurfaceTerms.test(normalized);
  const explicitCreationRequest =
    options.creationSyntax(normalized) &&
    hasDirectCreationRequestMarker(normalized) &&
    !mentionsSystemSurface;

  return !explicitCreationRequest;
}
