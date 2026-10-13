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
    re: /\b(?:generate_(?:long_video|video|image|music|speech)|bridge_send_(?:video|image|file|message)|create_(?:presentation|document|spreadsheet)|use_workflow|delegate_task|spawn_background_workflow)\b/i,
    scrub: {
      re: /\b(?:generate_(?:long_video|video|image|music|speech)|bridge_send_(?:video|image|file|message)|create_(?:presentation|document|spreadsheet)|use_workflow|delegate_task|spawn_background_workflow)\b/gi,
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
  create_presentation: 'slides',
  create_document: 'document',
  create_spreadsheet: 'spreadsheet',
  use_workflow: 'workflow switch',
  delegate_task: 'sub-task',
  spawn_background_workflow: 'background task',
};

/**
 * Progress text a host shows (step summaries, plans, helper tasks and
 * summaries, segment labels: core/progressEvents.ts): besides the vendor,
 * model and tool names `scrub` rewrites, the internal system names, but
 * only where they cannot be an ordinary word: "Saga" as a word or an
 * identifier (never "Sagan" or "sagacious"), the Norse system names, a
 * "Director agent", a "[niko:…]" label, a "[Workflow:" marker, model ids
 * and vendor names. Ordinary words ("the director", "payment gateway",
 * "US Constitution", "AWS Athena", "Freya") are left alone.
 */
const PROGRESS_RULES: ReadonlyArray<{ re: RegExp; to: string }> = [
  { re: /\b[Ss][Aa][Gg][Aa](?:[-_][A-Za-z0-9][\w-]*|[A-Z]\w*)?\b/g, to: 'long video' },
  { re: /[\w-]*nidhogg[\w-]*/gi, to: 'review' },
  { re: /[\w-]*mnemosyne[\w-]*/gi, to: 'memory' },
  { re: /\bbragi(?:[-_:]\w[\w:-]*)?\b/gi, to: 'chat bridge' },
  { re: /[\w-]*heimdall[\w-]*/gi, to: 'run log' },
  { re: /[\w-]*bifrost[\w-]*/gi, to: 'worker' },
  { re: /\bdirector[\s_-]+(?:agent|pass|stage|role|round)\b/gi, to: 'planner' },
  { re: /\b(?:critic|judge)[\s_-]+(?:agent|pass|stage|role|round)\b/gi, to: 'reviewer' },
  { re: /\[(?:niko|athena|contest|nidhogg|agent)(?::[^\]\n]{0,80})?\]\s*/gi, to: '' },
  { re: /\b(?:niko|athena|contest)[\s_-]+(?:workflow|playbook|mode)\b/gi, to: 'workflow' },
  { re: /\[Workflow:[^\]\n]{0,120}\]?|\[Artemis chose this workflow[^\]\n]{0,200}\]?|\[Workflow budget[^\]\n]{0,120}\]?/gi, to: '' },
  { re: /\b(?:claude|gpt|qwen|deepseek|gemini|wan2\.\d|doubao|kling|veo-?\d|sora-?\d|seedance|seedream|dreamina)[\w.-]*/gi, to: 'model' },
  { re: /\b(?:anthropic|openai|volcengine|byteplus|bytepluses|modelark)\b/gi, to: 'provider' },
]

/** Chinese words for the replacements, for Chinese text (no English word lands in it). */
const ZH_WORDS: Readonly<Record<string, string>> = {
  'long video': '长视频',
  review: '审查',
  memory: '记忆',
  'chat bridge': '聊天桥接',
  'run log': '运行记录',
  worker: '协作助手',
  planner: '规划',
  reviewer: '审查',
  workflow: '工作方式',
  model: '模型',
  'video model': '视频模型',
  'image model': '图片模型',
  provider: '服务商',
  consistency: '画面一致性',
  renderer: '渲染器',
  media: '媒体',
  video: '视频',
  image: '图片',
  music: '音乐',
  speech: '语音',
  'send video': '发送视频',
  'send image': '发送图片',
  'send file': '发送文件',
  'send message': '发送消息',
  slides: '幻灯片',
  document: '文档',
  spreadsheet: '表格',
  'workflow switch': '切换工作方式',
  'sub-task': '子任务',
  'background task': '后台任务',
}

const HAS_CJK = /[㐀-鿿]/
/** File types a bare name counts as a file with ("report.md", "clip.mp4"); "Saga.ai" or "x.com" is not one. */
const FILE_EXTENSIONS = 'ts|tsx|js|jsx|mjs|cjs|json|jsonl|md|markdown|txt|log|py|ipynb|sh|bash|go|rs|java|kt|swift|rb|php|c|h|cc|cpp|hpp|cs|css|scss|html|htm|vue|svelte|yaml|yml|toml|ini|env|xml|csv|tsv|sql|db|sqlite|xlsx|xls|docx|doc|pptx|ppt|pdf|rtf|odt|png|jpe?g|webp|gif|svg|bmp|tiff?|heic|ico|mp4|mov|webm|m4v|mkv|avi|mp3|wav|m4a|aac|flac|ogg|opus|srt|vtt|zip|tar|gz|tgz|7z|ttf|otf|woff2?';
/**
 * Paths and URLs in progress text, kept as they are: a URL, a token with a
 * slash or backslash, or a bare name with a known file type.
 */
const PROGRESS_PATH_RE = new RegExp(
  String.raw`(?<![^\s"'` + '`' + String.raw`(（[【:：=,，])(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+|(?:~|\.{1,2})?[/\\]\S*|[A-Za-z]:[/\\]\S*|[\w.@-]+(?:[/\\][\w.@-]*)+|[\w.@-]+\.(?:${FILE_EXTENSIONS})(?=$|[\s"'` + '`' + String.raw`)\]）】,，。;；:：]))`,
  'gi',
);

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A replacement word next to the same word ("审查 审查" from "Nidhogg 审查",
 * "run log log" from "Heimdall log") becomes one. Only words a replacement
 * put in are collapsed; the rest of the text is left as it was written.
 */
export function collapseRepeatedWords(text: string, words: Iterable<string>): string {
  let out = text;
  for (const w of new Set(words)) {
    if (!w.trim()) continue;
    const cjk = HAS_CJK.test(w);
    const parts = w.split(/\s+/);
    const tail = cjk ? ([...w].length >= 3 ? [...w].slice(-2).join('') : undefined) : parts.length > 1 ? parts[parts.length - 1] : undefined;
    const alt = tail ? `(?:${escapeRe(w)}|${escapeRe(tail)})` : escapeRe(w);
    const re = cjk ? new RegExp(`${escapeRe(w)}(?:\\s*${alt})+`, 'g') : new RegExp(`\\b${escapeRe(w)}(?:\\s+${alt}\\b)+`, 'gi');
    out = out.replace(re, w);
  }
  return out;
}

/**
 * Rewrites internal names in progress text (PROGRESS_RULES plus the `scrub`
 * rules), in Chinese words for Chinese text. File paths and URLs are never
 * rewritten (a rewritten path points nowhere): one that names an internal
 * system, a model or a vendor is left out of the text, a neutral word in
 * its place ("a file" / "a link"). A step's own detail (its file, its
 * command) is not rewritten at all but left out when it names one
 * (hasInternalProgressName); artifact links are never scrubbed.
 */
export function scrubInternalNamesStrict(text: string): string {
  if (!text) return text;
  const zh = HAS_CJK.test(text);
  const used: string[] = [];
  const word = (to: string) => {
    const w = zh ? ZH_WORDS[to] ?? to : to;
    used.push(w);
    return w;
  };
  const kept: string[] = [];
  let out = text.replace(PROGRESS_PATH_RE, (token) => `${kept.push(token) - 1}`);
  for (const { scrub } of INTERNAL_NAME_PATTERNS) {
    if (!scrub) continue;
    out = out.replace(scrub.re, (match) => word(scrub.to || TOOL_WORDS[match.toLowerCase()] || ''));
  }
  for (const rule of PROGRESS_RULES) out = out.replace(rule.re, () => word(rule.to));
  out = out.replace(/(\d+)/g, (_, index: string) => {
    const token = kept[Number(index)] ?? '';
    if (!hasInternalProgressName(token)) return token;
    const url = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(token);
    const neutral = zh ? (url ? '链接' : '文件') : url ? 'a link' : 'a file';
    used.push(neutral);
    return neutral;
  });
  return collapseRepeatedWords(out, used);
}

/** Whether progress text (a path, a command) names anything scrubInternalNamesStrict would rewrite, paths included. */
export function hasInternalProgressName(text: string): boolean {
  if (!text) return false;
  const test = (re: RegExp) => new RegExp(re.source, re.flags.replace('g', '')).test(text);
  return INTERNAL_NAME_PATTERNS.some(({ scrub }) => !!scrub && test(scrub.re)) || PROGRESS_RULES.some(({ re }) => test(re));
}

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
 * rewritten path points nowhere). Only a token that starts like a path
 * (/, ~, ./, ../, a drive letter, a scheme://) or a bare file name with an
 * extension counts; "byteplus/seedream-5-0" or "Seedance/Seedream" is a
 * provider/model pair, not a path, and is scrubbed.
 */
const PATH_TOKEN_RE = /(?<![^\s"'`(（[【:：=,，])(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+|(?:~|\.{1,2})?[/\\]\S*|[A-Za-z]:[/\\]\S*|[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,4}(?=$|[\s"'`)\]）】,，。;；:：]))/g;

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
  browser_request_handoff: { zh: '请你接管浏览器', en: 'Asking you to take over the browser' },
  bridge_send_video: { zh: '发送视频', en: 'Sending the video' },
  bridge_send_image: { zh: '发送图片', en: 'Sending the image' },
  bridge_send_file: { zh: '发送文件', en: 'Sending the file' },
  run_command: { zh: '运行命令', en: 'Running a command' },
  read_file: { zh: '读取文件', en: 'Reading a file' },
  read_document: { zh: '读取文档', en: 'Reading a document' },
  load_skill: { zh: '查看技能', en: 'Looking up a skill' },
  write_file: { zh: '写入文件', en: 'Writing a file' },
  replace_in_file: { zh: '修改文件', en: 'Editing a file' },
  list_files: { zh: '查看目录', en: 'Listing files' },
  search_files: { zh: '搜索文件', en: 'Searching files' },
  search_web: { zh: '联网搜索', en: 'Searching the web' },
  fetch_url: { zh: '读取网页', en: 'Reading a web page' },
  deep_research: { zh: '深入调研', en: 'Researching' },
  create_presentation: { zh: '制作幻灯片', en: 'Making slides', outputZh: '幻灯片已生成', outputEn: 'Your slides are ready' },
  create_document: { zh: '生成文档', en: 'Writing a document', outputZh: '文档已生成', outputEn: 'Your document is ready' },
  create_spreadsheet: { zh: '生成表格', en: 'Building a spreadsheet', outputZh: '表格已生成', outputEn: 'Your spreadsheet is ready' },
  delegate_task: { zh: '分派子任务', en: 'Delegating a sub-task' },
  use_workflow: { zh: '调整工作方式', en: 'Adjusting the approach' },
  server_setup: { zh: '设置服务器', en: 'Setting up the server' },
  get_verification_code: { zh: '收取验证码', en: 'Getting the verification code' },
  post_update: { zh: '告诉你进展', en: 'Updating you' },
  todo: { zh: '更新任务计划', en: 'Updating the plan' },
  agent_mail_address: { zh: '查看专用邮箱', en: 'Checking the agent mailbox' },
  list_emails: { zh: '查看邮件', en: 'Checking email' },
  read_email: { zh: '查看邮件', en: 'Reading an email' },
  wait_for_email: { zh: '等待验证邮件', en: 'Waiting for the verification email' },
  extract_verification: { zh: '读取验证码', en: 'Reading the verification code' },
  begin_signup: { zh: '注册账号（等待你批准）', en: 'Signing up (waiting for your approval)' },
  finish_signup: { zh: '记录注册结果', en: 'Recording the sign-up' },
  get_sms_number: { zh: '申请临时号码（等待你批准）', en: 'Getting a temporary number (waiting for your approval)' },
  wait_for_sms: { zh: '等待验证短信', en: 'Waiting for the SMS code' },
  ask_owner_for_code: { zh: '等待你输入验证码', en: 'Waiting for your code' },
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
