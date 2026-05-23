import assert from 'node:assert/strict';
import { buildContinuityBible, compileShotPromptWithContinuity } from '../src/tools/visual/sagaRenderer/continuity.js';
import { extractSagaDialogueLines } from '../src/tools/visual/sagaLanguageDirector.js';

// Representative excerpt from the user's JVKE golden-hour travel brief.
// Includes timecodes [0-8秒], section headers with English song lyrics in
// quotes, design-concept refs in quotes, and 5 explicit **对白(...)**:
// markers. This is the structure that used to incorrectly auto-trigger
// cleanDirect=true and lose all directorial scaffolding.
const USER_BRIEF_EXCERPT = `【整片叙事】
她戴着黑色墨镜，从画面左边缘走进来。

【画质规格】
- 参考: National Geographic 旅行纪录片 / Anthony Bourdain "Parts Unknown"
- 绝对禁止: NO 简化版"中国街道"，NO 简化版"霓虹城市"

【全局基调】
- 镜头机位: **完全锁死的三脚架机位 (locked-off tripod, no camera movement whatsoever)**
- NO pan, NO tilt, NO zoom, NO dolly, NO handheld shake

[0-8秒] 段 1 · 东亚四连穿越 · "It was just two lovers / sittin' in the car"

[8-16秒] 段 2 · 中东北非四连穿越 · "Listenin' to Blonde / fallin' for each other"

**对白（约 14 秒，马拉喀什段，极轻低语）**: "我一直在找一个人。"

**对白（约 27 秒，冰岛段，极低声）**: "走了好远好远..."

**对白（约 33 秒）**: "穿过了所有地方..."

**对白（约 35.5 秒）**: "原来你一直在这里。"

**对白（约 38.5 秒）**: "终于，我们停在了各自的地方。"
`;

async function main(): Promise<void> {
  // --- 1) Dialogue extraction on the real brief shape ---
  const dialogue = extractSagaDialogueLines(USER_BRIEF_EXCERPT);

  // The 5 marked dialogue lines must all be captured.
  const expected = [
    '我一直在找一个人。',
    '走了好远好远...',
    '穿过了所有地方...',
    '原来你一直在这里。',
    '终于，我们停在了各自的地方。',
  ];
  for (const text of expected) {
    const hit = dialogue.find((line) => line.text === text);
    assert.ok(hit, `expected dialogue "${text}" to be extracted, got: ${JSON.stringify(dialogue.map((l) => l.text))}`);
    assert.equal(hit.marker, '对白', `dialogue "${text}" should retain marker "对白"`);
    assert.equal(hit.language, 'Mandarin Chinese');
    assert.equal(hit.use, 'spoken_dialogue');
  }

  // Must NOT classify any of these as dialogue:
  //  - English song lyrics in section headers
  //  - Brand/concept refs in quotes without sentence-final punctuation
  const forbidden = [
    'Parts Unknown',
    '中国街道',
    '霓虹城市',
    "It was just two lovers / sittin' in the car",
    "Listenin' to Blonde / fallin' for each other",
  ];
  for (const text of forbidden) {
    const hit = dialogue.find((line) => line.text === text);
    assert.equal(hit, undefined, `"${text}" should NOT be extracted as dialogue`);
  }

  assert.equal(dialogue.length, expected.length, `dialogue count: expected ${expected.length}, got ${dialogue.length} (${JSON.stringify(dialogue.map((l) => l.text))})`);

  // --- 2) Continuity bible reflects user's locked-off camera intent ---
  const bibleLocked = buildContinuityBible({
    story: USER_BRIEF_EXCERPT,
    ratio: '16:9',
  });
  assert.match(
    bibleLocked.identityCard,
    /\[CAMERA: absolutely locked-off tripod, no camera movement whatsoever/,
    'CAMERA block should reflect the user\'s locked-off intent when brief says so',
  );

  // --- 3) When brief does NOT request lock-off, default cinematic camera wins ---
  const bibleFree = buildContinuityBible({
    story: '【整片叙事】她漫步在城市里，镜头跟随她推进。',
    ratio: '16:9',
  });
  assert.match(
    bibleFree.identityCard,
    /\[CAMERA: controlled cinematic camera with stable handheld push-ins/,
    'CAMERA block should fall back to the default when brief does not lock motion',
  );

  // --- 4) NEGATIVE block reinforces under subtitleMode='off' ---
  const bibleNoSubs = buildContinuityBible({
    story: USER_BRIEF_EXCERPT,
    ratio: '16:9',
    subtitleMode: 'off',
  });
  assert.match(bibleNoSubs.identityCard, /no readable text/);
  assert.match(bibleNoSubs.identityCard, /no rendered song lyrics/);
  assert.match(bibleNoSubs.identityCard, /no on-screen English text labels/);
  assert.match(bibleNoSubs.identityCard, /no captions of any quoted phrase/);

  // --- 5) NEGATIVE block default ('auto') keeps standard subtitle restraint ---
  const bibleAuto = buildContinuityBible({
    story: USER_BRIEF_EXCERPT,
    ratio: '16:9',
    subtitleMode: 'auto',
  });
  assert.match(bibleAuto.identityCard, /no readable text/);
  assert.match(bibleAuto.identityCard, /no subtitles/);
  // The 'off'-only reinforcements must NOT appear under 'auto'.
  assert.doesNotMatch(bibleAuto.identityCard, /no rendered song lyrics/);
  assert.doesNotMatch(bibleAuto.identityCard, /no on-screen English text labels/);

  // --- 6) NEGATIVE block loosens under subtitleMode='always' ---
  const bibleAlwaysSubs = buildContinuityBible({
    story: USER_BRIEF_EXCERPT,
    ratio: '16:9',
    subtitleMode: 'always',
  });
  assert.doesNotMatch(bibleAlwaysSubs.identityCard, /no readable text/);
  assert.doesNotMatch(bibleAlwaysSubs.identityCard, /no subtitles/);

  // --- 7) cleanDirect keeps hard continuity locks, only strips style/aesthetic scaffolding ---
  const cleanStory = `【整片叙事】男主角穿过东京新宿狭窄霓虹小巷，雨夜潮湿。
· 特效启用: 原始质感 / 少滤镜 / clean-direct，保留皮肤真实纹理
· 主角: 戴着白色棒球帽，蓝白配色运动鞋
[0-10秒] 段 1 · 东京迷失。镜头从男主角正后方低机位慢速跟拍。两侧霓虹招牌。
**对白（约 6 秒，低沉克制）**: "我走过无数条街道。"`;
  const cleanBible = buildContinuityBible({ story: cleanStory, ratio: '16:9' });
  const cleanPrompt = compileShotPromptWithContinuity({
    bible: cleanBible,
    mode: 'strong-vision',
    shotIndex: 1,
    shotCount: 6,
    duration: 10,
    title: '0-10s',
    storyBeat: '段 1 · 东京迷失。镜头从男主角正后方低机位慢速跟拍。两侧霓虹招牌。',
    visualPrompt: 'Follow this exact timestamped script section: 段 1 · 东京迷失。',
    camera: '',
    continuity: '',
    transition: '',
    cleanDirect: true,
  });
  // Hard correctness locks MUST survive cleanDirect:
  assert.match(cleanPrompt, /\[SAGA-CONTINUITY-POLICY/, 'cleanDirect must keep SAGA-CONTINUITY-POLICY');
  assert.match(cleanPrompt, /\[CHARACTERS|\[LOCKED-CHARACTERS/, 'cleanDirect must keep character lock');
  assert.match(cleanPrompt, /\[WARDROBE|\[LOCKED-WARDROBE/, 'cleanDirect must keep wardrobe lock');
  assert.match(cleanPrompt, /Saga long-form video continuity bible/, 'cleanDirect must keep the continuity bible body');
  assert.match(cleanPrompt, /\[SCENE-PRIORITY\]/, 'cleanDirect must keep the scene-priority block');
  assert.match(cleanPrompt, /\[EXPLICIT USER BRIEF LOCK/, 'cleanDirect must keep the explicit-user-brief lock');
  // Aesthetic / style scaffolding MUST be stripped in cleanDirect:
  assert.doesNotMatch(cleanPrompt, /\[STYLE-LOCK\]/, 'cleanDirect must drop STYLE-LOCK');
  assert.doesNotMatch(cleanPrompt, /\[AESTHETIC-LOCK/, 'cleanDirect must drop AESTHETIC-LOCK');
  assert.doesNotMatch(cleanPrompt, /\[REFERENCE-ROLE-SEPARATION\]/, 'cleanDirect must drop REFERENCE-ROLE-SEPARATION');
  assert.doesNotMatch(cleanPrompt, /\[FRAME-OUT/, 'cleanDirect must drop FRAME-OUT');

  // --- 8) Non-cleanDirect prompt keeps the full scaffolding for parity ---
  const fullPrompt = compileShotPromptWithContinuity({
    bible: cleanBible,
    mode: 'strong-vision',
    shotIndex: 1,
    shotCount: 6,
    duration: 10,
    title: '0-10s',
    storyBeat: '段 1 · 东京迷失。镜头从男主角正后方低机位慢速跟拍。两侧霓虹招牌。',
    visualPrompt: 'Follow this exact timestamped script section: 段 1 · 东京迷失。',
    camera: 'slow controlled dolly movement with stable subject tracking and visible parallax',
    continuity: 'Carry forward the same character identity, wardrobe, props.',
    transition: 'open from black into a mid-action first frame, not a static pose',
    cleanDirect: false,
  });
  assert.match(fullPrompt, /\[STYLE-LOCK\]/, 'non-cleanDirect should keep STYLE-LOCK');
  assert.match(fullPrompt, /\[AESTHETIC-LOCK/, 'non-cleanDirect should keep AESTHETIC-LOCK');
  assert.match(fullPrompt, /\[REFERENCE-ROLE-SEPARATION\]/, 'non-cleanDirect should keep REFERENCE-ROLE-SEPARATION');
  assert.match(fullPrompt, /\[FRAME-OUT/, 'non-cleanDirect should keep FRAME-OUT');

  console.log('saga cleanDirect/CAMERA/NEGATIVE decoupling smoke ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
