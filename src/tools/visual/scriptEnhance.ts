/**
 * The script step the App's Saga panel had and the engine never did.
 *
 * In the panel the owner pasted a script into one box and the box had two
 * buttons. "AI 增强剧本" wrote a whole script from an idea. "我有剧本" took a
 * finished script and added only the Saga shell — timecodes, segment titles,
 * camera, the quality spec, the sound layers — under a rule that every word
 * of the owner's text is sacred. The result came back into the same box, so
 * the owner read it, edited it, and only then started the render.
 *
 * The engine had neither half of that. `aiScreenwriterMode` is a flag read
 * *during* generation, so the script it writes is never shown; nothing at all
 * did the second, word-preserving pass. Both prompts lived in the panel's
 * renderer (src/legacy/sagaRitual.js on the MacBook), which is why they went
 * nowhere when the work moved to the cloud agent.
 *
 * Both prompts below are the owner's own text, carried over as written. They
 * are not rewritten here, and should not be: the 铁律 block and the
 * downgrade clause are the reason the pass is trustworthy.
 */

/** Which of the two passes runs. */
export type ScriptEnhanceMode = 'have_script' | 'from_idea';

/** The specs the panel injected into the prompt (its "会写入 AI 增强剧本" note). */
export type ScriptEnhanceSpecs = {
  ratio: string;
  totalSeconds: number;
  segmentCapSeconds?: number;
  subtitleMode?: 'off' | 'auto' | 'always';
};

export type DirectorPackSlot = {
  name?: string;
  referenceCount?: number;
  /** Same-person outfit changes, never a second character. */
  looks?: string;
};

export type DirectorPackInput = {
  subject: 'lead' | 'product' | 'visual';
  identityMode?: 'auto' | 'direct_image' | 'character_image' | 'turnaround' | 'text_only';
  slots?: DirectorPackSlot[];
  firstFrame?: string;
  lastFrame?: string;
} & ScriptEnhanceSpecs;

const IDENTITY_LABELS: Record<string, string> = {
  direct_image: '直传图片',
  character_image: '角色图生成三视图',
  turnaround: '三视图直传',
  text_only: '纯文字',
  auto: '自动',
};

/**
 * The panel's Director Pack: what the owner settled in the UI, in the words
 * the prompt expects. It exists because a slot's name and the difference
 * between "another character" and "the same person in another outfit" cannot
 * be recovered from the script text.
 */
export function buildDirectorPack(input: DirectorPackInput): string {
  const lines: string[] = ['【Director Pack · 导演备注】'];
  lines.push(`身份来源模式: ${IDENTITY_LABELS[input.identityMode ?? 'auto'] ?? '自动'}`);
  const slots = input.subject === 'lead' ? (input.slots ?? []) : [];
  if (slots.length > 0) {
    lines.push('角色卡槽:');
    slots.forEach((slot, index) => {
      const name = String(slot.name ?? '').trim() || `角色${index + 1}`;
      const count = slot.referenceCount ?? 0;
      let line = `  ${index + 1}. ${name}: ${count > 0 ? `${count} 张参考图` : '未上传参考图'}`;
      const looks = String(slot.looks ?? '').trim();
      if (looks) line += ` · 同人换装: ${looks}`;
      lines.push(line);
    });
    lines.push('(人名必须保留;同人换装≠新角色;不要合并卡槽)');
  }
  if (input.firstFrame) lines.push(`首帧锚定: ${input.firstFrame} (第一段必须从此构图开始)`);
  if (input.lastFrame) lines.push(`末帧锚定: ${input.lastFrame} (最后一段必须收束到此构图)`);
  lines.push(`画幅: ${input.ratio} · 总时长: ${input.totalSeconds}s`);
  if ((input.segmentCapSeconds ?? 0) > 0) {
    lines.push(`单段时长上限: ${input.segmentCapSeconds}s (用户手动指定,覆盖模型自动检测)`);
  }
  const subtitles = input.subtitleMode === 'always' ? '全程开启' : input.subtitleMode === 'auto' ? '自动' : '关闭';
  lines.push(`字幕: ${subtitles}`);
  lines.push('优先级: 角色身份 > 多角色绑定 > 同人换装 > 首末帧 > AI 补全');
  return lines.join('\n');
}

/** The slot rule the panel appended after the pack, for a lead-character run. */
const SLOT_RULE = '请动态使用以上人物名字;不同卡槽=不同人物,不要合并;Looks/造型=同人换装不是新角色;视觉识别外貌应回填到对应人物;参考图为准不臆造。';

export function buildSlotBrief(input: DirectorPackInput): string {
  const pack = buildDirectorPack(input);
  return input.subject === 'lead' ? `\n\n${pack}\n${SLOT_RULE}` : `\n\n${pack}\n`;
}

/**
 * Markers of a script the owner already wrote, as opposed to an idea to write
 * one from. The point of the split is which prompt runs, and the two costs
 * are not symmetric: treating an idea as a script wastes one pass, while
 * treating a script as an idea rewrites words the owner chose. So anything
 * that looks structured, or long enough to be a draft, counts as a script.
 */
const SCRIPT_MARKERS: RegExp[] = [
  /\[\s*\d{1,3}\s*[-–~]\s*\d{1,3}\s*秒?\s*\]/,          // [0-6秒] / [0-6]
  /\b\d{1,2}:\d{2}\s*[-–~]\s*\d{1,2}:\d{2}\b/,           // 00:06 - 00:12
  /(?:^|\n)\s*(?:段|场|镜头|镜)\s*\d+/,                   // 段 1 / 镜头3
  /(?:^|\n)\s*(?:scene|shot)\s*\d+/i,
  /\*\*(?:对白|旁白)\*\*/,                                 // the guide's dialogue markers
  /(?:^|\n)\s*(?:对白|旁白|台词)\s*[:：]/,
  /【(?:整片叙事|画质规格|全局基调|逐段剧本|声音)】/,          // already in the five-part shape
];

/** Below this a text is a brief, not a draft. */
const SCRIPT_MIN_CHARS = 220;

export function detectScriptEnhanceMode(story: string): ScriptEnhanceMode {
  const text = String(story ?? '');
  if (SCRIPT_MARKERS.some((marker) => marker.test(text))) return 'have_script';
  // Several paragraphs of prose is a draft, not a one-line request.
  const compact = text.replace(/\s+/g, '');
  if (compact.length >= SCRIPT_MIN_CHARS && /\n\s*\n/.test(text.trim())) return 'have_script';
  return 'from_idea';
}

/** One line under the box, so the chosen pass is never a surprise. */
export function describeScriptEnhanceMode(mode: ScriptEnhanceMode): string {
  return mode === 'have_script'
    ? '检测到完整剧本：只补时间码、分段和机位，不改你的字。'
    : '按你写的想法写出完整剧本，写完你可以再改。';
}

/**
 * The owner's own prompts, carried over from the panel as written.
 */
export function buildScriptEnhancePrompt(input: {
  mode: ScriptEnhanceMode;
  story: string;
  director: DirectorPackInput;
}): string {
  const storyText = input.story.trim();
  const slotBrief = buildSlotBrief(input.director);
  const { ratio, totalSeconds } = input.director;

  if (input.mode === 'have_script') {
    return `你正在为 Artemis Saga 工作流结构化用户已写好的剧本。

【铁律 - 违反即任务失败】
1. 用户原文每个字都神圣 - 台词/旁白/动作描述/场景细节 100% 原文保留,不得改写、软化、删减、转译
2. 你只负责加 saga 结构外壳:时间码分段、镜头机位、画质规格、声音层级、场景标题
3. 用户原文里的所有具体内容按原文细化分镜,不要替换为隐喻或抽象化

【若你判断剧本无法以原样处理】
不要静默改写。先输出一行说明:"AI 检测到 [具体原因],无法以原样输出。以下为降级版本供你判断是否使用 ↓",然后输出降级版本。用户自己决定用不用。

【输出格式】
第一部分【整片叙事】 基于用户原文提炼 200-300 字概述。
第二部分【画质规格】 画幅、画质、摄影机感、镜头风格、色彩、光照、技术限制(仅技术,不加内容/道德限制条款)。
第三部分【全局基调】 · VIBE · 镜头机位 · CHARACTER LOCK · 服装锁定 · 声音层级
第四部分【逐段剧本】 按时间码 [X-Y秒] 分段,每段:时间码 + 段标题 + 画面/物理动词动作(用户原文必须出现在这里) + 【声音】 + 对白/旁白用 marker 包裹
第五部分(可选)【附录:对白回顾】 抽出所有对白(原文)。

【saga 结构约束】
· 单段 6-10 秒
· 段开头写人物横向位置/朝向/运动方向/取景/机位
· 动作时间线格式: 0-Xs: [角色][物理动词][对象]; [环境]. Xs-Ys: [下一动作].
· 每 3 秒至少一个有意动作
· 后段承接前段动作/机位/姿态
· 不写画质堆叠词、品牌音乐、字幕假设
· 不设计复杂手部/递接小物件/近身格斗

【用户已选规格】
画幅: ${ratio}
总时长: ${totalSeconds}s

【用户原始剧本(神圣 - 不得改字)】
${storyText}
${slotBrief}

【输出前自检】
□ 用户每一句对白/旁白原文都出现在你的输出?
□ 用户每个动作描述原文都出现在你的输出?
□ 每段时长 ≤ 10s?

输出完整 saga 剧本。`;
  }

  return `你正在为我撰写一份 Artemis Saga 长视频工作流的完整剧本。

请严格遵守标准结构骨架,输出以下五个部分:

第一部分【整片叙事】 用 200-500 字写清楚:整片讲什么、主角是谁、最终高潮是什么、情绪走向。

第二部分【画质规格】 写明:画幅比例 / ratio、参考画质等级、摄影机感、镜头风格、色彩基调、光照风格、技术约束(仅限模型已知的高翻车项:堆叠画质词、品牌音乐、字幕渲染、复杂手部、递接小物件等)。

第三部分【全局基调】
· VIBE: (用一个词或短语描述整体氛围)
· 镜头机位: (如需锁机位写「锁死三脚架机位,NO pan, NO tilt, NO zoom, NO dolly」)
· CHARACTER LOCK: (主角永久不变的外貌特征,无参考图时写成完整角色卡)
· 声音层级: (写明 AI 生成阶段输出什么声音,哪些是后期叠加)

第四部分【逐段剧本(核心)】 每段必须包含:
1. 时间码:[X-Y秒]
2. 段标题:段 N · 标题
3. 段内内容:镜头角度、人物动作(必须物理动词)、背景细节、节奏、转场
4. 【声音】: 本段声音层描述
5. **对白**: 「实际台词」或 **旁白**: 「实际旁白」(必须 marker 包裹)

第五部分(可选)【附录:对白回顾】

【关键约束】
· 单段 6-10 秒
· 每段 120-250 字镜头信息
· 段开头写人物位置/朝向/运动方向/取景/机位
· 动作时间线格式: 0-Xs: [角色][动词][对象]; [环境]. Xs-Ys: [下一动作].
· 每 3 秒至少一个有意动作
· 后段承接前段机位、姿态、动作方向
· 不写画质堆叠词、品牌音乐、字幕假设
· 不设计复杂手部/递接小物件/近身格斗

【用户已选规格】
画幅比例: ${ratio}
总时长: ${totalSeconds} 秒

根据以下题材写完整剧本:

${storyText}${slotBrief}

要求:输出纯剧本正文,严格按上述骨架结构输出。`;
}

/**
 * How much script a film of this length can hold.
 *
 * Two constraints, and both are read from the model actually configured
 * rather than from the guide's old numbers. The guide was written when a clip
 * was 6-10 seconds; Seedance 2.0 films 15 seconds in one clip and 2.5 films
 * 30, so segment counts taken from the guide are wrong by a factor of three
 * on the current models.
 *
 *   how much action a second of film can carry — the guide's "120-250 字
 *     镜头信息 per 6-10 秒 段" is a density, about 20-42 characters per second
 *     of finished video, and that part does not change with the clip length;
 *   how much of a segment's prompt is left for the owner's words — the
 *     model's prompt limit less what generate_video adds back (the Director's
 *     lines and the rendering rules).
 *
 * It matters because of what the owner actually wants to paste in: a novel.
 * "Every word is sacred" is a rule about not rewriting, and it only holds
 * when the text is roughly the length of the film. Checking first also keeps
 * us from paying for a call that cannot succeed.
 */
export type ScriptLimits = {
  /** L, the longest single clip, from videoCapabilities.ts. */
  maxClipSeconds?: number;
  /** The model's prompt limit. */
  maxPromptChars?: number;
  /** What generate_video adds to each segment prompt (sagaSegmentPromptReserve()). */
  segmentPromptReserve?: number;
};

export type ScriptBudget = {
  clipSeconds: number;
  segments: number;
  minChars: number;
  maxChars: number;
  /** Room left for the owner's own words in one segment prompt. */
  authoredCharsPerSegment: number;
};

/** The guide's 120-250 字 per 6-10 秒 segment, as characters per second of film. */
const CHARS_PER_SECOND_MIN = 20;
const CHARS_PER_SECOND_MAX = 42;
/** Used only when nothing is configured: the shortest clip any supported model films. */
const FALLBACK_CLIP_SECONDS = 10;
const FALLBACK_PROMPT_CHARS = 2600;
const FALLBACK_SEGMENT_RESERVE = 1545;
/** However tight the prompt limit is, a segment still carries a sentence or two. */
const MIN_AUTHORED_CHARS = 400;

export function scriptLengthBudget(totalSeconds: number, limits: ScriptLimits = {}): ScriptBudget {
  const seconds = Math.max(1, Math.round(totalSeconds));
  const clipSeconds = Math.max(1, Math.round(limits.maxClipSeconds ?? FALLBACK_CLIP_SECONDS));
  const segments = Math.max(1, Math.ceil(seconds / clipSeconds));
  const promptChars = limits.maxPromptChars ?? FALLBACK_PROMPT_CHARS;
  const reserve = limits.segmentPromptReserve ?? FALLBACK_SEGMENT_RESERVE;
  const authoredCharsPerSegment = Math.max(MIN_AUTHORED_CHARS, promptChars - reserve);
  const byDensity = { min: seconds * CHARS_PER_SECOND_MIN, max: seconds * CHARS_PER_SECOND_MAX };
  // Whichever runs out first.
  const maxChars = Math.min(byDensity.max, segments * authoredCharsPerSegment);
  return {
    clipSeconds,
    segments,
    minChars: Math.min(byDensity.min, maxChars),
    maxChars,
    authoredCharsPerSegment,
  };
}

/** Over this multiple of the budget, structuring the text as written is arithmetic, not judgement. */
const OVER_BUDGET_FACTOR = 2.5;

export type SourceLengthVerdict =
  | { fits: true; chars: number; budget: ScriptBudget }
  | { fits: false; chars: number; budget: ScriptBudget; timesOver: number; secondsNeeded: number };

/** Whether the pasted text can be filmed as written at this duration. */
export function checkSourceLength(story: string, totalSeconds: number, limits: ScriptLimits = {}): SourceLengthVerdict {
  const chars = String(story ?? '').replace(/\s+/g, '').length;
  const budget = scriptLengthBudget(totalSeconds, limits);
  if (chars <= Math.round(budget.maxChars * OVER_BUDGET_FACTOR)) return { fits: true, chars, budget };
  return {
    fits: false,
    chars,
    budget,
    timesOver: Math.round((chars / budget.maxChars) * 10) / 10,
    // The film this text would actually need, at the densest the guide allows.
    secondsNeeded: Math.ceil(chars / CHARS_PER_SECOND_MAX),
  };
}

export type EnhancedScript = {
  script: string;
  /**
   * Set when the model judged the script could not be structured as written.
   * Its own first line says why, and what follows is a downgraded version the
   * owner decides about — so this is reported, never substituted silently.
   */
  degraded?: { reason: string };
};

/** The sentence the have_script prompt asks for when it cannot keep every word. */
const DEGRADED_RE = /^\s*(?:["“'『「]\s*)?AI\s*检测到\s*(.+?)\s*[,，]\s*无法以原样输出[。.]?\s*以下为降级版本供你判断是否使用\s*[↓⬇]?\s*(?:["”'』」]\s*)?$/m;

/**
 * Splits the model's answer into the script and, when it refused to keep
 * every word, the reason it gave. The notice line never stays in the script:
 * it belongs above the box, not inside the text that goes on to the renderer.
 */
export function parseEnhancedScript(output: string): EnhancedScript {
  const text = String(output ?? '').replace(/^\s*```[a-z]*\s*\n|\n?\s*```\s*$/g, '').trim();
  const match = DEGRADED_RE.exec(text);
  if (!match) return { script: text };
  const reason = match[1]!.trim().replace(/^\[|\]$/g, '');
  const script = text.slice(match.index + match[0].length).trim();
  // A notice with nothing after it is not a downgrade, it is a refusal.
  if (!script) return { script: '', degraded: { reason } };
  return { script, degraded: { reason } };
}
