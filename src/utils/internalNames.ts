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
 * One internal name: `re` finds it in user-facing text (the guard tests);
 * `scrub`, when set, is how the last-line scrubber rewrites it. Only names
 * that can never be ordinary words get a `scrub` (vendor and model ids,
 * snake_case tool names); the others ("Saga", "Critic", "Bragi" — also a
 * title, a word or a character's name) are removed at their source instead,
 * and the guard tests fail when one reaches a user.
 */
export type InternalNamePattern = {
  name: string;
  re: RegExp;
  scrub?: { re: RegExp; to: string };
};

/** Internal names, case-insensitive; word-bounded where the name is also an English word. */
export const INTERNAL_NAME_PATTERNS: ReadonlyArray<InternalNamePattern> = [
  { name: 'Saga', re: /saga/i },
  {
    name: 'Super Visual',
    re: /super[\s_-]?visual|超级视觉/i,
    scrub: { re: /super[\s_-]?visual|超级视觉/gi, to: 'consistency' },
  },
  { name: 'Seedance', re: /seedance/i, scrub: { re: /[\w.-]*seedance[\w.-]*/gi, to: 'video model' } },
  { name: 'Seedream', re: /seedream/i, scrub: { re: /[\w.-]*seedream[\w.-]*/gi, to: 'image model' } },
  { name: 'Dreamina', re: /dreamina/i, scrub: { re: /[\w.-]*dreamina[\w.-]*/gi, to: 'video model' } },
  { name: 'BytePlus', re: /byte[\s-]?plus|bytepluses/i, scrub: { re: /\bbyte[\s-]?plus(?:es)?\b/gi, to: 'provider' } },
  { name: 'ModelArk', re: /model[\s-]?ark/i, scrub: { re: /\bmodel[\s-]?ark\b/gi, to: 'provider' } },
  { name: 'Nidhogg', re: /nidhogg/i },
  { name: 'Mnemosyne', re: /mnemosyne/i },
  { name: 'Bragi', re: /bragi/i },
  { name: 'Freya', re: /\bfreya\b/i },
  { name: 'Heimdall', re: /heimdall/i },
  { name: 'Bifrost', re: /bifrost/i },
  { name: 'Hyperframes', re: /hyperframes/i, scrub: { re: /\bhyperframes\b/gi, to: 'renderer' } },
  { name: 'Vidar', re: /\bvidar\b/i, scrub: { re: /\bvidar\b/gi, to: 'media' } },
  { name: 'Director', re: /\bdirector\b/i },
  { name: 'Critic', re: /\bcritic\b/i },
  { name: 'Constitution', re: /\bconstitution\b/i },
  { name: 'gateway', re: /\bgateway\b/i },
  { name: 'workflow playbook name', re: /\b(?:niko|athena|contest)\b/i },
  { name: 'workflow marker', re: /\[Workflow:|\[Artemis chose this workflow|\[Workflow budget/i },
  {
    name: 'tool code name',
    re: /\b(?:generate_(?:long_video|video|image|music|speech)|bridge_send_(?:video|image|file|message)|use_workflow|delegate_task|spawn_background_workflow)\b/i,
    scrub: {
      re: /\b(?:generate_(?:long_video|video|image|music|speech)|bridge_send_(?:video|image|file|message)|use_workflow|delegate_task|spawn_background_workflow)\b/gi,
      to: '',
    },
  },
  {
    name: 'model id',
    re: /\b(?:gpt-image-\d|image-2\b|doubao-|kling-|veo-\d|sora-\d)/i,
    scrub: { re: /\b(?:gpt-image-\d[\w.-]*|image-2\b|doubao-[\w.-]*|kling-[\w.-]*|veo-\d[\w.-]*|sora-\d[\w.-]*)/gi, to: 'model' },
  },
];

const TOOL_WORDS: Readonly<Record<string, string>> = {
  generate_long_video: 'long video',
  generate_video: 'video',
  generate_image: 'image',
  generate_music: 'music',
  generate_speech: 'speech',
  bridge_send_video: 'send video',
  bridge_send_image: 'send image',
  bridge_send_file: 'send file',
  bridge_send_message: 'send message',
  use_workflow: 'workflow switch',
  delegate_task: 'sub-task',
  spawn_background_workflow: 'background task',
};

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
 * A file path or URL: it names a real file and is never rewritten (a
 * rewritten path points nowhere).
 */
const PATH_TOKEN_RE = /\S*[/\\]\S*|\S+\.[A-Za-z][A-Za-z0-9]{0,4}(?=$|[\s"'`)\]）】,，。;；:：])/g;

/**
 * Last-line scrubber for progress and error text Artemis itself writes
 * (tool progress, raw service errors): vendor, model and tool code names
 * become plain words. Paths and URLs are never touched, nor are names that
 * are also ordinary words (those are removed where they are written), and
 * whitespace changes only around a replacement. Never applied to the user's
 * own words or to the model's reply.
 */
export function scrubInternalNames(text: string): string {
  if (!text) return text;
  const kept: string[] = [];
  let out = text.replace(PATH_TOKEN_RE, (token) => `${kept.push(token) - 1}`);
  for (const { scrub } of INTERNAL_NAME_PATTERNS) {
    if (!scrub) continue;
    out = out.replace(scrub.re, (match) => {
      const to = scrub.to || TOOL_WORDS[match.toLowerCase()] || '';
      return to;
    });
  }
  // "provider  provider" style doubles and the gap a removed word leaves.
  out = out.replace(/\b(video model|image model|provider|model)(?:[\s/]+\1\b)+/g, '$1');
  return out.replace(/(\d+)/g, (_, index: string) => kept[Number(index)] ?? '');
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
