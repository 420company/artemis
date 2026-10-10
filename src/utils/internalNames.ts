/**
 * utils/internalNames.ts — internal system names that users never see.
 *
 * Artemis is the product. The engines, passes, providers and models behind it
 * (the long-video pipeline, the image-consistency pass, the planning and
 * review passes, the video/image vendors, the bridges, the workflow
 * playbooks, the tool code names) are implementation details: user-facing
 * text describes what happens in plain words ("制作长视频", "生成图片",
 * "画面一致性") instead.
 *
 * Code, logs written to disk, saved state and session markers keep their
 * internal identifiers (renaming them would break saved sessions and
 * projects). This module is the shared denylist the guard tests use, plus a
 * last-line scrubber for progress lines that reach users.
 */

/**
 * Internal names, case-insensitive. Word-bounded where the name is also an
 * English word ("critic" must not match "critical", "gateway" in a user's own
 * text is not checked — only text Artemis writes is).
 */
export const INTERNAL_NAME_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'Saga', re: /saga/i },
  { name: 'Super Visual', re: /super[\s_-]?visual|超级视觉/i },
  { name: 'Seedance', re: /seedance/i },
  { name: 'Seedream', re: /seedream/i },
  { name: 'Dreamina', re: /dreamina/i },
  { name: 'BytePlus', re: /byte[\s-]?plus|bytepluses/i },
  { name: 'ModelArk', re: /model[\s-]?ark/i },
  { name: 'Nidhogg', re: /nidhogg/i },
  { name: 'Mnemosyne', re: /mnemosyne/i },
  { name: 'Bragi', re: /bragi/i },
  { name: 'Freya', re: /\bfreya\b/i },
  { name: 'Heimdall', re: /heimdall/i },
  { name: 'Bifrost', re: /bifrost/i },
  { name: 'Hyperframes', re: /hyperframes/i },
  { name: 'Vidar', re: /\bvidar\b/i },
  { name: 'Director', re: /\bdirector\b/i },
  { name: 'Critic', re: /\bcritic\b/i },
  { name: 'Constitution', re: /\bconstitution\b/i },
  { name: 'gateway', re: /\bgateway\b/i },
  { name: 'workflow playbook name', re: /\b(?:niko|athena|contest)\b/i },
  { name: 'workflow marker', re: /\[Workflow:|\[Artemis chose this workflow|\[Workflow budget/i },
  {
    name: 'tool code name',
    re: /\b(?:generate_(?:long_video|video|image|music|speech)|bridge_send_(?:video|image|file|message)|use_workflow|delegate_task|spawn_background_workflow)\b/i,
  },
  { name: 'model id', re: /\b(?:gpt-image-\d|image-2\b|doubao-|kling-|veo-\d|sora-\d)/i },
];

export type InternalNameHit = { name: string; match: string; index: number };

/** Every internal name found in a piece of user-facing text. */
export function findInternalNames(text: string): InternalNameHit[] {
  const hits: InternalNameHit[] = [];
  for (const { name, re } of INTERNAL_NAME_PATTERNS) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const match of text.matchAll(global)) {
      hits.push({ name, match: match[0], index: match.index ?? 0 });
    }
  }
  return hits;
}

/**
 * Last-line scrubber for progress text Artemis itself writes (tool progress
 * lines, routing notes): internal names become plain words. Never applied to
 * the user's own words or the model's reply.
 */
export function scrubInternalNames(text: string): string {
  if (!text) return text;
  return text
    // "Saga's pipeline", "Saga Visual Director:", "Saga Critic:", "Saga 状态："
    .replace(/\bSaga(?:'s)?\s+Visual\s+Director\s*[:：]?\s*/g, '')
    .replace(/\bSaga(?:'s)?\s+(?:Narrative\s+)?Critic\s*[:：]?\s*/g, '')
    .replace(/\b(?:Visual\s+)?Director\s+(?=pass|rewrite|optimi[sz]ation)/gi, '')
    .replace(/\bSaga(?:'s)?\b\s*[:：]?\s*/g, '')
    .replace(/super[\s_-]?visual/gi, 'consistency')
    .replace(/超级视觉/g, '画面一致性')
    .replace(/\b[\w.-]*seedance[\w.-]*/gi, 'video model')
    .replace(/\b[\w.-]*seedream[\w.-]*/gi, 'image model')
    .replace(/\b(?:BytePlus|bytepluses|ModelArk)\b/gi, 'provider')
    .replace(/\b(?:Nidhogg|Mnemosyne|Bragi|Heimdall|Bifrost|Hyperframes|Vidar)\b\s*/gi, '')
    .replace(/\bCritic\b/g, 'review')
    .replace(/\bConstitution\b/g, 'story rules')
    .replace(/\bgenerate_long_video\b/g, 'long video')
    .replace(/\bgenerate_video\b/g, 'video')
    .replace(/\bgenerate_image\b/g, 'image')
    .replace(/[ \t]{2,}/g, ' ');
}

const TOOL_LABELS: Readonly<Record<string, { zh: string; en: string; outputZh?: string; outputEn?: string }>> = {
  generate_long_video: { zh: '制作长视频', en: 'Making a long video', outputZh: '长视频已生成', outputEn: 'Your long video is ready' },
  generate_video: { zh: '生成视频', en: 'Generating a video', outputZh: '视频已生成', outputEn: 'Your video is ready' },
  generate_image: { zh: '生成图片', en: 'Generating an image', outputZh: '图片已生成', outputEn: 'Your image is ready' },
  browser_screenshot: { zh: '网页截图', en: 'Taking a screenshot', outputZh: '网页截图', outputEn: 'Screenshot' },
  bridge_send_video: { zh: '发送视频', en: 'Sending the video' },
  bridge_send_image: { zh: '发送图片', en: 'Sending the image' },
  bridge_send_file: { zh: '发送文件', en: 'Sending the file' },
  run_command: { zh: '运行命令', en: 'Running a command' },
  read_file: { zh: '读取文件', en: 'Reading a file' },
  write_file: { zh: '写入文件', en: 'Writing a file' },
  replace_in_file: { zh: '修改文件', en: 'Editing a file' },
  list_files: { zh: '查看目录', en: 'Listing files' },
  search_files: { zh: '搜索文件', en: 'Searching files' },
  search_web: { zh: '联网搜索', en: 'Searching the web' },
  fetch_url: { zh: '读取网页', en: 'Reading a web page' },
  deep_research: { zh: '深入调研', en: 'Researching' },
  delegate_task: { zh: '分派子任务', en: 'Delegating a sub-task' },
  use_workflow: { zh: '调整工作方式', en: 'Adjusting the approach' },
};

/** What a tool call does, in plain words, for progress lines users see. */
export function describeToolForUser(toolName: string, locale: 'zh-CN' | 'en' | string): string {
  const label = TOOL_LABELS[toolName];
  const zh = locale === 'zh-CN' || locale === 'zh';
  if (label) return zh ? label.zh : label.en;
  return zh ? '正在处理' : 'Working';
}

/** Caption for a file a tool produced (an image or a video pushed to chat). */
export function describeToolOutputForUser(toolName: string, locale: 'zh-CN' | 'en' | string): string {
  const label = TOOL_LABELS[toolName];
  const zh = locale === 'zh-CN' || locale === 'zh';
  if (label?.outputZh && label.outputEn) return zh ? label.outputZh : label.outputEn;
  return zh ? '生成结果' : 'Result';
}

// Wizard prompts stored as the user's turn: the user's own story comes first,
// then internal blocks for the model. Old sessions carry the older headers.
const STORED_PROMPT_MARKERS = [
  '[Artemis Saga long video workflow]',
  '[Artemis multimodal video workflow]',
  '[Seedance 2.0 Pro multimodal video workflow]',
];
const STORED_PROMPT_BLOCK_HEADERS = [
  '[USER CREATIVE SEED',
  '[USER-SUPPLIED SCRIPT',
  '[User storyboard image references]',
  '═══',
  '[Narrative Rules',
  '[Saga Narrative',
  '[Narrative Entity Map',
  '[Dream journal protagonist',
  '[Dream Video Narrative Entity Map]',
  '[Artemis latest dream journal',
  ...STORED_PROMPT_MARKERS,
];

/** True when a stored user turn is a wizard-built generation prompt. */
export function isStoredWizardPrompt(content: string): boolean {
  return STORED_PROMPT_MARKERS.some((marker) => content.includes(marker));
}

/**
 * What a chat UI shows for a stored user turn. A wizard-built generation
 * prompt shows only the user's own story (the internal blocks and markers
 * after it are for the model); anything else is returned unchanged.
 */
export function userVisibleMessageText(content: string): string {
  if (!content || !isStoredWizardPrompt(content)) return content;
  let cut = content.length;
  for (const header of STORED_PROMPT_BLOCK_HEADERS) {
    const at = content.startsWith(header) ? 0 : content.indexOf(`\n${header}`);
    if (at >= 0 && at < cut) cut = at;
  }
  const story = content.slice(0, cut).trim();
  if (story) return story;
  return /[㐀-鿿]/.test(content) ? '制作视频' : 'Make a video';
}
