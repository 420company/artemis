/**
 * Spotify trigger detection + system prompt hint.
 *
 * Two-layer design:
 *
 * 1. **System prompt hint** (always injected when Spotify is authenticated):
 *    Tells the brain it has spotify_* tools, when to use them, and what
 *    keywords (Chinese + English) signal music intent. Brain reads this
 *    every turn and decides on its own.
 *
 * 2. **Optional regex pre-detection** (runs on incoming bridge messages):
 *    Quickly flags whether a message is "music-related" so we can decorate
 *    the brain's context with extra urgency on those turns. Not a hard
 *    gate — just a hint amplifier.
 *
 * The keyword matrix is conservative by design: only triggers on explicit
 * music intent. Soft "I'm tired" suggestions are left to brain-side
 * interpretation, not regex.
 */

import { isAuthenticated } from './store.js';

// ── Hard triggers: explicit music intent ─────────────────────────────────
// Brain should call a spotify_* tool when these appear in user message.
const HARD_TRIGGERS = [
  // Chinese — direct play commands
  /放(点|首|一?首)?(音乐|歌)/u,
  /来(点|首)?(音乐|歌)/u,
  /听(点|首)?(音乐|歌)/u,
  /放歌/u,
  /换(一?首|首)歌/u,
  // Spotify mention
  /spotify/iu,
  /打开\s*spotify/iu,
  /启动\s*spotify/iu,
  // Pause / stop
  /暂停|停一下|停止音乐|关音乐|关掉音乐|别放了|静音/u,
  // Skip
  /下一首|切歌|跳过|不想听这首|换一首/u,
  /上一首|回去|倒回去|重听/u,
  // Volume
  /音量|大声(点|一?点)|小声(点|一?点)|调高|调低/u,
  // Liked / favorites / playlists
  /(播放|放)(我?(的)?)?(点赞|收藏|喜欢)(的歌|的音乐|歌单)?/u,
  /(我的|播放)歌单/u,
  // Genre / mood (only when paired with music context)
  /(放|来|听)点?(chill|lo-?fi|jazz|爵士|摇滚|民谣|电子|古典|乡村|摇滚|嘻哈|说唱|蓝调|放松|学习|工作|睡前)(音乐|歌|的)?/iu,

  // English — direct
  /\bplay\s+(some\s+)?(music|songs?|track)\b/iu,
  /\bput\s+on\s+(some\s+)?music\b/iu,
  /\bspotify\b/iu,
  /\b(pause|stop)\s+(music|spotify|playback)\b/iu,
  /\b(skip|next|previous|prev)\b\s+(track|song)?/iu,
  /\bplay\s+my\s+(liked|favorites?|saved)\b/iu,
  /\bvolume\s+(up|down|to)\b/iu,
  /\b(louder|quieter|mute)\b/iu,
  /\bplay\s+(some\s+)?(chill|lo-?fi|jazz|rock|pop|classical|electronic|focus|sleep|study)\s+(music)?/iu,
];

/**
 * Quick test for whether a message has explicit music intent.
 * Returns true if any hard trigger matches.
 */
export function detectMusicIntent(message: string): boolean {
  if (!message || message.length === 0) return false;
  return HARD_TRIGGERS.some((pat) => pat.test(message));
}

/**
 * Build the Spotify-awareness section of the brain's system prompt.
 * Returns empty string if the user hasn't authenticated yet (don't
 * advertise tools that won't work).
 */
export async function buildSpotifyHint(): Promise<string> {
  const authed = await isAuthenticated();
  if (!authed) {
    return [
      '',
      '',
      '## Spotify 集成',
      '当前 Spotify **未登录**。如果用户要求播放音乐 / Spotify 相关操作：',
      '1. 主动告诉用户："请先在 Artemis CLI 里跑 `/spotify login` 完成授权（一次性，~30 秒）。"',
      '2. 不要尝试用 osascript 控制 Spotify 桌面 app（AppleScript 不暴露 Liked Songs 等关键能力）。',
      '3. 不要硬怼 curl / 反向工程 ChatGPT 接口。',
    ].join('\n');
  }

  return [
    '',
    '',
    '## Spotify 集成（已登录，可调用）',
    '你有以下 Spotify 工具：',
    '  • spotify_play_liked       — 播放用户的 Liked Songs（默认随机）',
    '  • spotify_search_and_play  — 搜索并播放（kind: track | playlist | auto）',
    '  • spotify_play_playlist    — 按名字播放用户/公开歌单',
    '  • spotify_resume / spotify_pause / spotify_skip_next / spotify_skip_previous',
    '  • spotify_set_volume       — 设音量 0-100',
    '  • spotify_now_playing      — 查询当前播放状态',
    '  • spotify_set_device       — 切换播放设备（Spotify Connect）',
    '',
    '### 触发规则（保守模式 — 必须明确）',
    '只有用户消息**明确包含音乐意图**时才调 spotify_* 工具。命中以下任一类即触发：',
    '  • 直接命令：放音乐 / 来点音乐 / play music / put on music / 放歌 / 听歌',
    '  • Spotify 显式：包含 "spotify" 字样 / 打开 spotify',
    '  • 操作类：暂停 / 下一首 / 上一首 / 调音量 / pause / skip / next / volume',
    '  • 内容类：播放点赞 / 我喜欢的 / 我的歌单 / play my liked / play my playlist',
    '  • 风格类（带音乐 context）：放点 chill / lo-fi / jazz / 摇滚 / focus music',
    '',
    '### 模糊场景的处理',
    '若用户消息**情绪含蓄但音乐意图不明**（如"今天好累"、"想放松一下"），先反问一句确认：',
    '  "要不要给你放点 chill 音乐？"',
    '不要擅自启动播放。',
    '',
    '### 设备选择',
    '默认让 spotify_* 工具自动选设备（活跃设备 → 上次用过的 → 第一个可用）。除非用户明确指定（如"播放在客厅 HomePod"），不要传 deviceHint 参数。',
    '',
    '### 来自桥接的消息（Telegram / Discord / WeChat）',
    '当用户在外通过 IM 发指令（典型场景：下班路上发"放点音乐"），这是 ambient agent 的核心使用场景，**直接执行**，不要追问"在哪个设备播放"——智能默认会选家里那台 Mac。',
    '执行后简短回复（IM 消息不要太啰嗦）：',
    '  ✓ 正在播放：xxx (设备：MacBook Pro)',
  ].join('\n');
}
