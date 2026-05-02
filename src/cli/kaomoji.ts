/**
 * Shared kaomoji pool used by completion footers across the CLI and the IM
 * bridges. Single source of truth so adding a face shows up everywhere.
 *
 * Kaomoji are language-neutral, so the same pool serves zh and en. They
 * stand alone — no trailing "ready for your next message" text — so the
 * footer stays compact and feels less like a corporate auto-reply.
 *
 * Loosely cat-themed to match the Artemis cat motif (polish-waiting cat,
 * dream "桥上的猫" imagery, etc.). A few non-cat ambient kaomoji are sprinkled
 * in for variety so the session doesn't feel like one persistent character.
 */

const KAOMOJI_POOL = [
  // cat faces
  '(=^･ω･^=)',
  'ฅ^•ﻌ•^ฅ',
  '(˶ᵔ ᵕ ᵔ˶)',
  '(=ↀωↀ=)✧',
  '(=⌒‿‿⌒=)',
  '(ฅ•ω•ฅ)',
  '/ᐠ｡ꞈ｡ᐟ\\',
  '(=^-ω-^=)',
  '(=^･ｪ･^=)',
  'ฅ(•ㅅ•❀)ฅ',
  '(^◔ᴥ◔^)',
  '=^..^=',
  '(≈^‥^≈)',
  '(=ↀωↀ=)',
  'ฅ(=ↀωↀ=)',
  '(˃ᆺ˂)',
  '(=ㅇㅅㅇ=)',
  // ambient / chill (non-cat)
  '( ◜◡◝ )',
  '( ´ ▽ ` )',
  '(˶˃ ᵕ ˂˶)',
  '( ｡•̀ᴗ-)✧',
  '(っ˘ω˘ς)',
  '(っ´ω`c)',
  'ヽ(•‿•)ノ',
] as const

export function pickKaomoji(): string {
  return KAOMOJI_POOL[Math.floor(Math.random() * KAOMOJI_POOL.length)]!
}
