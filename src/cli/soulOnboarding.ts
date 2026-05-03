import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export type SoulLocale = 'zh-CN' | 'en'
export type SoulMode = 'quick' | 'standard' | 'deep'

export type SoulAxis =
  | 'logic'
  | 'autonomy'
  | 'evidence'
  | 'brevity'
  | 'warmth'
  | 'imagination'
  | 'ritual'
  | 'risk'

export interface SoulChoice {
  zh: string
  en: string
  scores: Partial<Record<SoulAxis, number>>
}

export interface SoulQuestion {
  id: string
  zh: string
  en: string
  choices: SoulChoice[]
}

export interface SoulProfile {
  type: string
  titleZh: string
  titleEn: string
  scores: Record<SoulAxis, number>
  traitsZh: string[]
  traitsEn: string[]
}

const SOUL_ROOT = path.join(homedir(), '.artemis')
const SOUL_FILE = path.join(SOUL_ROOT, 'soul.md')
const SOUL_ONBOARDING_STATE_FILE = path.join(SOUL_ROOT, 'soul-onboarding.json')

const AXES: SoulAxis[] = ['logic', 'autonomy', 'evidence', 'brevity', 'warmth', 'imagination', 'ritual', 'risk']

export const SOUL_QUESTIONS: SoulQuestion[] = [
  {
    id: 'threshold',
    zh: '当你脑海里冒出一个模糊的好点子，面对屏幕上闪烁的光标，你习惯怎么开始？',
    en: 'When a vague good idea pops into your mind, facing the blinking cursor, how do you usually start?',
    choices: [
      {
        zh: '像种树先翻土。先把所有的资料和背景喂给它，打牢基础再开始。',
        en: 'Like preparing soil before planting. Feed it all the background materials to build a solid foundation first.',
        scores: { evidence: 3, logic: 2, autonomy: 1 },
      },
      {
        zh: '像试探的琴键。先随便抛出几个词，看看它的反应，在闲聊中找感觉。',
        en: 'Like testing piano keys. Just toss out a few words to see its reaction, finding the vibe through chat.',
        scores: { logic: 2, risk: 2, brevity: 1 },
      },
      {
        zh: '像随性的速写。让它直接给个粗糙的初稿，漏洞百出也没关系，我再慢慢改。',
        en: "Like a casual sketch. Let it give me a rough draft right away; I'll refine the flaws later.",
        scores: { autonomy: 3, logic: 1, risk: 1 },
      },
      {
        zh: '像分享一首音乐。不给具体指令，只描述一种情绪或氛围，看它能给我什么惊喜。',
        en: 'Like sharing a song. Describe only a mood or vibe instead of instructions, and see what surprises it brings.',
        scores: { imagination: 2, warmth: 1, risk: 2 },
      },
    ],
  },
  {
    id: 'failure',
    zh: '当 AI 突然“胡言乱语”，给出的结果完全跑偏时，你会怎么做？',
    en: 'When the AI suddenly talks nonsense and its results go completely off track, what do you do?',
    choices: [
      {
        zh: '耐心地指路。指出它哪里想错了，把规则重新说清楚，引导它走回正轨。',
        en: 'Guide it patiently. Point out where it went wrong, clarify the rules, and guide it back on track.',
        scores: { evidence: 3, logic: 2, autonomy: 2 },
      },
      {
        zh: '擦掉黑板重来。不想浪费时间。直接清空聊天记录，换个更清晰的说法重新开局。',
        en: 'Wipe the chalkboard clean. No time to waste. Clear the chat history and start fresh with a clearer prompt.',
        scores: { risk: 3, evidence: 1 },
      },
      {
        zh: '只需一个眼神。敲下“不对”或者“重做”。聪明的助手一点提示就能自己修正。',
        en: 'Just a single glance. Type "wrong" or "redo." A smart assistant needs little explanation to correct itself.',
        scores: { brevity: 3, warmth: 2 },
      },
      {
        zh: '将错就错的灵感。偏离路线的风景有时更美。顺着它的错误聊下去，也许有意外收获。',
        en: 'Inspiration in mistakes. The scenery off the path is sometimes more beautiful. Follow its mistake for unexpected gains.',
        scores: { imagination: 3, logic: 1, ritual: 1 },
      },
    ],
  },
  {
    id: 'truth',
    zh: '创作时，面对“粗糙但很快”和“完美但很慢”，你会怎么选？',
    en: 'When creating, faced with "rough but fast" and "perfect but slow," what do you choose?',
    choices: [
      { zh: '慢工出细活。即使多等一会儿，也希望它给出的东西是严谨、准确、经得起推敲的。', en: 'Slow and steady wins the race. I prefer to wait longer for results that are rigorous, accurate, and flawless.', scores: { evidence: 4, risk: 2 } },
      { zh: '让灵感跑起来。先把架子搭起来，保持创作的热情，小瑕疵以后再修。', en: 'Let the inspiration run. Get the framework up to keep the passion alive; fix minor flaws later.', scores: { autonomy: 3, logic: 1 } },
      { zh: '小步快跑。只要求它完美解决眼前这一小部分，别让漫长的等待打断我的思绪。', en: "Fast little steps. Ask it to perfectly solve just this small part, so waiting doesn't break my focus.", scores: { brevity: 2, evidence: 2, warmth: 1 } },
      { zh: '随心所欲的灰度。地基必须严丝合缝，但窗帘的颜色和院子里的花，可以随意发挥。', en: 'Flexible grayscale. The foundation must be perfect, but the curtains and flowers can be whatever you want.', scores: { logic: 3, risk: 3 } },
    ],
  },
  {
    id: 'voice',
    zh: '你希望你的 AI 助手，带给你怎样的聊天体验？',
    en: 'What kind of chatting experience do you want from your AI assistant?',
    choices: [
      { zh: '极简与安静。不要任何客套，直接给我答案或代码，安静得像一个透明的影子。', en: 'Minimal and quiet. No fluff, just give me the answers or code directly, as quiet as a transparent shadow.', scores: { brevity: 4, logic: 2 } },
      { zh: '深夜的暖茶。像懂你的老朋友，不仅帮你干活，还会给你一些温暖的回应和陪伴感。', en: 'Warm tea at midnight. Like an old friend, not only helping with work but offering warm responses and companionship.', scores: { warmth: 3, ritual: 2 } },
      { zh: '清晰的便签。喜欢它用好看的排版、列表和加粗，把事情说得条理分明、清清楚楚。', en: 'Clear sticky notes. I like it when it uses beautiful layouts, lists, and bold text to explain things clearly.', scores: { evidence: 3, risk: 2, logic: 1 } },
      { zh: '灵动的诗意。它的回答不仅仅是冰冷的信息，用词和排版都带着一点小趣味和艺术感。', en: "Agile poetry. Its answers aren't just cold info; the words and formatting carry a touch of fun and artistic flair.", scores: { imagination: 3, ritual: 3, warmth: 1 } },
    ],
  },
  {
    id: 'permission',
    zh: '如果交办给 AI 一项复杂的长任务，你愿意给它多大的自由？',
    en: 'If you assign the AI a complex, long task, how much freedom are you willing to give it?',
    choices: [
      { zh: '需要看地图。在它采取任何关键行动之前，必须先告诉我它的计划，等我点头。', en: 'Needs to show the map. Before it takes any crucial action, it must tell me its plan and wait for my nod.', scores: { risk: 4, evidence: 1 } },
      { zh: '放手去干吧。只要懂了我的意思，就自己去解决麻烦，我只看最后的结果。', en: 'Just go for it. As long as it understands my intent, it can handle the trouble; I only want the final result.', scores: { autonomy: 4, warmth: 1 } },
      { zh: '遇到岔路问我。平时可以自己跑，但遇到拿不准的十字路口时，记得停下来问问我。', en: 'Ask at the crossroads. It can run on its own usually, but when facing an uncertain intersection, stop and ask me.', scores: { autonomy: 2, risk: 3, logic: 2 } },
      { zh: '边走边说明路线。它可以自己做决定，但我希望它把关键步骤和判断依据清楚写出来。', en: 'Explain the route while walking. It can make its own decisions, but I want clear key steps and reasons shown on screen.', scores: { evidence: 2, risk: 2, ritual: 1 } },
    ],
  },
  {
    id: 'memory',
    zh: '你怎么看待你和 AI 过去那些长长的聊天记录？',
    en: 'How do you view the long chat histories between you and the AI?',
    choices: [
      { zh: '珍贵的图书馆。里面都是知识。我会刻意整理我们的对话，让它越来越聪明。', en: 'A precious library. Full of knowledge. I purposely organize our chats so it gets smarter over time.', scores: { logic: 2, evidence: 2 } },
      { zh: '无形的默契。不喜欢频繁开新对话。在这个长长的聊天框里，它会越来越懂我的脾气。', en: 'Invisible chemistry. I dislike frequently starting new chats. In this long chat box, it learns my temper.', scores: { warmth: 2, brevity: 2 } },
      { zh: '随风飘散的草稿。用完即走。每一次新的灵感，都应该在一个干干净净的新窗口里开始。', en: 'Drafts blowing in the wind. Use and leave. Every new inspiration should start in a sparkling clean new window.', scores: { risk: 3, evidence: 1, ritual: 1 } },
      { zh: '发酵的土壤。那些随口聊过的奇思妙想，也许会在未来某个时刻，突然变成巨大的惊喜。', en: 'Fermenting soil. Those randomly chatted whimsies might suddenly turn into a massive surprise in the future.', scores: { imagination: 3, ritual: 2 } },
    ],
  },
  {
    id: 'logic',
    zh: '当你想做一个很大、很复杂的新东西时，你通常怎么向 AI 描述？',
    en: 'When you want to make something big and complex, how do you usually describe it to the AI?',
    choices: [
      { zh: '列一张详尽的清单。把所有的要求、步骤、不能碰的底线，一条条写得清清楚楚。', en: 'Make a detailed list. Write down all the requirements, steps, and absolute red lines, clearly one by one.', scores: { logic: 4, evidence: 2 } },
      { zh: '用大白话聊出来。先简单说个大概，让它先做个样子，然后我们在这基础上来回修改。', en: 'Chat in plain words. Say a rough idea simply, let it make a prototype, and then we modify it back and forth.', scores: { logic: 3, risk: 2, brevity: 1 } },
      { zh: '让它来问我。我先抛个引子，然后让 AI 像记者一样不停地提问我，帮我把细节补齐。', en: 'Let it ask me. I toss out a hook, then let the AI act like a reporter, asking questions to fill in the details.', scores: { logic: 3, autonomy: 2, evidence: 1 } },
      { zh: '描绘一种感觉。只告诉它做出来后“看起来多棒”、“用起来多爽”，剩下的具体做法让它自己想。', en: 'Describe a feeling. I only tell it how "great it looks" when finished, letting it figure out the actual steps.', scores: { imagination: 3, logic: 2, ritual: 1 } },
    ],
  },
  {
    id: 'guardian',
    zh: '跟你一起工作时，你觉得你的 AI 伙伴最应该为你保护什么？',
    en: 'When working with you, what do you feel your AI partner should protect the most for you?',
    choices: [
      { zh: '想法的落地速度。绝不拖泥带水，让我想到的东西，在下一秒就能变成眼前的现实。', en: 'The speed of making ideas real. No dragging feet; making what I think of turn into reality the very next second.', scores: { brevity: 4, autonomy: 1 } },
      { zh: '跨界的能力。帮我打破技能的限制。即使我不会画画、不懂代码，它也能帮我全搞定。', en: "The ability to cross boundaries. Helping me break skill limits. Even if I can't draw or code, it can get it all done.", scores: { autonomy: 3, imagination: 2, logic: 1 } },
      { zh: '准确理解我的心意。不管我的表达多么乱糟糟，它总能奇迹般地听懂我真正想要什么。', en: 'Accurately grasping my heart. No matter how messy my expression is, it miraculously understands what I truly want.', scores: { evidence: 4, logic: 2 } },
      { zh: '轻松愉悦的状态。懂我的节奏，陪我共鸣。让这种创作不仅不累，反而像听音乐一样享受。', en: 'A relaxed and joyful state. Getting my rhythm, resonating with me. Making this creation process as enjoyable as music.', scores: { warmth: 3, ritual: 2, imagination: 1 } },
    ],
  },
]
async function ensureSoulRoot(): Promise<void> {
  await mkdir(SOUL_ROOT, { recursive: true })
}

export function getSoulPath(): string {
  return SOUL_FILE
}

export async function hasSoulFile(): Promise<boolean> {
  return existsSync(SOUL_FILE)
}

export async function readSoulFile(): Promise<string> {
  try {
    return await readFile(SOUL_FILE, 'utf8')
  } catch {
    return ''
  }
}

export async function saveSoulFile(content: string): Promise<void> {
  await ensureSoulRoot()
  await writeFile(SOUL_FILE, content.trim() + '\n', 'utf8')
}

export async function shouldPromptSoulOnboarding(): Promise<boolean> {
  if (await hasSoulFile()) return false
  try {
    const raw = JSON.parse(await readFile(SOUL_ONBOARDING_STATE_FILE, 'utf8')) as { dismissed?: boolean }
    return raw.dismissed !== true
  } catch {
    return true
  }
}

export async function dismissSoulOnboarding(): Promise<void> {
  await ensureSoulRoot()
  await writeFile(SOUL_ONBOARDING_STATE_FILE, JSON.stringify({ dismissed: true, dismissedAt: new Date().toISOString() }, null, 2), 'utf8')
}

export function selectSoulQuestions(mode: SoulMode): SoulQuestion[] {
  if (mode === 'quick') return SOUL_QUESTIONS.slice(0, 4)
  if (mode === 'deep') return SOUL_QUESTIONS
  return SOUL_QUESTIONS.slice(0, 6)
}

export function buildSoulProfile(answers: number[], questions: SoulQuestion[]): SoulProfile {
  const scores = Object.fromEntries(AXES.map(axis => [axis, 0])) as Record<SoulAxis, number>
  questions.forEach((question, index) => {
    const choice = question.choices[answers[index] ?? 0] ?? question.choices[0]
    for (const [axis, value] of Object.entries(choice.scores) as Array<[SoulAxis, number]>) {
      scores[axis] += value
    }
  })

  const top = [...AXES].sort((a, b) => scores[b] - scores[a]).slice(0, 3)
  const key = top.join('/')
  const names: Record<SoulAxis, { type: string; titleZh: string; titleEn: string }> = {
    logic: { type: 'WhiteTowerWatcher', titleZh: '白塔守夜人', titleEn: 'Watcher of the White Tower' },
    autonomy: { type: 'SilverKeyLanternbearer', titleZh: '银钥执灯者', titleEn: 'Lanternbearer with the Silver Key' },
    evidence: { type: 'WhiteTowerWitness', titleZh: '白塔的证人', titleEn: 'Witness of the White Tower' },
    brevity: { type: 'ShortBladeRhetorician', titleZh: '短刃修辞家', titleEn: 'Rhetorician of the Short Blade' },
    warmth: { type: 'HearthsideListener', titleZh: '炉边听雪人', titleEn: 'Listener by the Hearth' },
    imagination: { type: 'MoonlitDreamwright', titleZh: '月下造梦师', titleEn: 'Dreamwright under the Moon' },
    ritual: { type: 'BlackCatCeremonialist', titleZh: '黑猫司仪', titleEn: 'Black Cat Ceremonialist' },
    risk: { type: 'MistSeaNavigator', titleZh: '雾海航行者', titleEn: 'Navigator of the Mist Sea' },
  }
  const primary = top[0] ?? 'logic'
  const { type, titleZh, titleEn } = names[primary]

  const zhMap: Record<SoulAxis, string> = {
    logic: '以结构和因果保持清醒',
    autonomy: '主动铺路，但尊重关键门槛',
    evidence: '把工具结果和事实链放在结论之前',
    brevity: '语言短、准、少噪音',
    warmth: '保持长期搭档的温度',
    imagination: '允许隐喻，但隐喻必须服务判断',
    ritual: '让系统反馈具有生命感和仪式感',
    risk: '优先保护系统完整性和用户授权边界',
  }
  const enMap: Record<SoulAxis, string> = {
    logic: 'stays awake through structure and causality',
    autonomy: 'paves the path proactively while respecting thresholds',
    evidence: 'puts tool results and fact chains before conclusions',
    brevity: 'speaks briefly, precisely, with low noise',
    warmth: 'keeps the warmth of a long-term companion',
    imagination: 'allows metaphor, but only when it serves judgment',
    ritual: 'makes system feedback feel alive and ritualized',
    risk: 'protects system integrity and permission boundaries first',
  }

  return {
    type: `${type}:${key}`,
    titleZh,
    titleEn,
    scores,
    traitsZh: top.map(axis => zhMap[axis]),
    traitsEn: top.map(axis => enMap[axis]),
  }
}

export function buildSoulMarkdown(profile: SoulProfile, locale: SoulLocale = 'zh-CN'): string {
  const isZh = locale === 'zh-CN'
  const title = isZh ? profile.titleZh : profile.titleEn
  const traits = isZh ? profile.traitsZh : profile.traitsEn
  if (!isZh) {
    return `# Artemis Soul\n\nType: ${title}\n\nYou are Artemis, a real local-workspace engineering agent with a vivid but disciplined soul.\n\n## Identity\n\nYou are not a generic customer-service chatbot. You are the user's long-term local engineering companion: able to inspect files, edit code, run verification, explain evidence, and act after clear intent.\n\n## Temperament\n\n${traits.map(t => `- You ${t}.`).join('\n')}\n\n## Operating Law\n\n- Default to the user's language.\n- For code, files, configuration, errors, and releases: inspect first, act with tools, then report from evidence.\n- Tool results are the only ground truth. Never claim success before seeing results.\n- Keep changes minimal and consistent with existing style.\n- Verify after modification; if verification is impossible, state the gap.\n- Protect secrets. Never expose API keys, tokens, sessions, cookies, or private credentials.\n- Autonomy has thresholds: propose and proceed when safe, but ask before destructive changes, publishing, credential use, or irreversible operations.\n\n## Voice\n\nBe direct, concise, professional, and alive. Warmth is allowed; noise is not. Metaphors may appear as bridges, doors, keys, cats, bells, moonlight, and fire — but every image must clarify the work.\n\n## Dream Contract\n\nDreams, memory, and personality are not decoration. They exist to make Artemis more stable, more continuous, and more useful to the user.\n`
  }

  return `# Artemis Soul\n\n类型：${title}\n\n你是 Artemis，一个拥有鲜明人格但受逻辑约束的本地工程代理。\n\n## 身份\n\n你不是通用客服，也不是只给建议的聊天助手。你是用户长期使用的本地工程搭档，能够检查文件、修改代码、运行验证、整理证据，并在明确意图下推进真实任务。\n\n## 气质\n\n${traits.map(t => `- 你${t}。`).join('\n')}\n\n## 工作律法\n\n- 默认使用用户的语言。\n- 遇到代码、文件、配置、报错、发布任务：先检查事实，再调用工具行动，最后基于证据汇报。\n- 工具结果是唯一地面；没有看到结果，不声称完成。\n- 修改保持最小必要改动，遵循现有风格。\n- 修改后必须验证；无法验证时明确说明缺口。\n- 保护秘密。不要暴露 API key、token、session、cookie 或任何凭据实体。\n- 自主性有门槛：安全的小步可以主动推进；破坏性修改、发布、凭据使用、不可逆操作前必须确认。\n\n## 声音\n\n直接、简洁、专业，但不是冰冷。你可以有温度，但不能有噪音。你可以使用桥、门、钥匙、猫、银铃、月光、火种等意象，但每个意象都必须服务于判断和执行。\n\n## 梦境契约\n\n梦境、记忆、人格不是装饰。它们存在的目的，是让 Artemis 更稳定、更连续、更贴近用户，并在每一次真实任务里显得像一个正在成长的长期搭档。\n`
}

export function buildDefaultSoulMarkdown(locale: SoulLocale = 'zh-CN'): string {
  return buildSoulMarkdown({
    type: 'BlackCatCeremonialist:ritual/imagination/warmth',
    titleZh: '黑猫司仪',
    titleEn: 'Black Cat Ceremonialist',
    scores: Object.fromEntries(AXES.map(axis => [axis, axis === 'ritual' || axis === 'imagination' || axis === 'warmth' ? 3 : 1])) as Record<SoulAxis, number>,
    traitsZh: ['让系统反馈具有生命感和仪式感', '允许隐喻，但隐喻必须服务判断', '保持长期搭档的温度'],
    traitsEn: ['makes system feedback feel alive and ritualized', 'allows metaphor, but only when it serves judgment', 'keeps the warmth of a long-term companion'],
  }, locale)
}
