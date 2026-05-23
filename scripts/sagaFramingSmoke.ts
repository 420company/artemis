import assert from 'node:assert/strict';
import {
  extractOpeningFramingRegex,
  formatOpeningFramingBlock,
} from '../src/tools/visual/sagaFraming.js';

async function main(): Promise<void> {
  // ── Case 1 — the actual brief that just shipped a left-facing keyframe ──
  // Source story contains explicit position / orientation / direction /
  // framing / camera cues. The regex must recover all five so Image-2 gets a
  // crisp opening directive instead of guessing.
  const goldenHourBrief = [
    '【整片叙事】 她戴着黑色墨镜，从画面左边缘走进来。整整 32 秒她从画面左边缓缓走到中央。第 33 秒，巴厘岛悬崖海滩出现，她终于停下，转过身，缓慢地朝镜头走来。',
    '· 镜头机位: 完全锁死的三脚架机位 (locked-off tripod, no camera movement whatsoever)',
    '· 中景全身构图：女主全身可见，占画面高度约 70%',
    '· 女主侧面剪影从画面左边缘 5% 处刚踏入画面，开始缓慢向画面右侧（中心方向）走。',
  ].join('\n');
  const goldenDirectives = extractOpeningFramingRegex({
    storyBeat: 'Generic boilerplate storyBeat with no positional cues.',
    sourceStory: goldenHourBrief,
    shotIndex: 1,
    shotCount: 7,
  });
  const goldenKinds = goldenDirectives.map((directive) => directive.kind).sort();
  assert.deepEqual(
    goldenKinds,
    ['body-orientation', 'camera-framing', 'camera-motion', 'horizontal-position', 'motion-direction'],
    'golden-hour brief should yield all five kinds of framing cues',
  );
  const horizontal = goldenDirectives.find((directive) => directive.kind === 'horizontal-position');
  assert.match(horizontal!.text, /LEFT\s*~?5%/, 'horizontal position must capture the literal "left edge 5%" anchor');
  const orientation = goldenDirectives.find((directive) => directive.kind === 'body-orientation');
  assert.match(orientation!.text, /PROFILE/i, 'body orientation must lock to PROFILE when the brief says "侧面"');
  const motion = goldenDirectives.find((directive) => directive.kind === 'motion-direction');
  assert.match(motion!.text, /RIGHTWARD/, 'motion vector must capture "向画面右侧走" as RIGHTWARD');
  const framing = goldenDirectives.find((directive) => directive.kind === 'camera-framing');
  assert.match(framing!.text, /medium wide|full-body/i, 'shot size must capture "中景全身"');
  const cameraMotion = goldenDirectives.find((directive) => directive.kind === 'camera-motion');
  assert.match(cameraMotion!.text, /locked-off tripod/i, 'camera motion must capture the "锁死三脚架" lock');

  const goldenBlock = formatOpeningFramingBlock(goldenDirectives);
  assert.ok(goldenBlock, 'block must render when directives exist');
  assert.match(goldenBlock!, /OPENING FRAMING/, 'block must carry the OPENING FRAMING header');
  assert.match(goldenBlock!, /LEFT\s*~?5%/, 'block must inline the literal left-edge percentage');
  assert.match(goldenBlock!, /override any conflicting hint/i, 'block must explicitly outrank the broader continuity rules below');

  // ── Case 2 — front-facing walk-toward-camera brief (segment 5 style) ──
  const finaleBrief = [
    '第 32 秒女主停下并转过身，正面朝镜头，缓慢朝镜头走来。镜头仍是锁死三脚架机位。',
    '画面从中景全身逐步变成极近半身/特写。',
  ].join('\n');
  const finaleDirectives = extractOpeningFramingRegex({
    storyBeat: 'Boilerplate.',
    sourceStory: finaleBrief,
    shotIndex: 5,
    shotCount: 7,
  });
  const finaleOrientation = finaleDirectives.find((directive) => directive.kind === 'body-orientation');
  assert.ok(finaleOrientation, 'finale segment should resolve body orientation');
  assert.match(finaleOrientation!.text, /FRONT/i, 'finale segment must lock body to FRONT when the brief says 正面朝镜头');
  const finaleMotion = finaleDirectives.find((directive) => directive.kind === 'motion-direction');
  assert.ok(finaleMotion, 'finale segment should resolve motion vector');
  assert.match(finaleMotion!.text, /TOWARD the camera/i, 'finale segment must lock motion to walk TOWARD the camera');

  // ── Case 3 — back-to-camera traveller brief (different protagonist mode) ──
  const backBrief = '男主角始终以正背影出现，永远不正面朝镜头；镜头大远景固定三脚架机位。';
  const backDirectives = extractOpeningFramingRegex({
    storyBeat: '',
    sourceStory: backBrief,
    shotIndex: 1,
    shotCount: 6,
  });
  const backOrientation = backDirectives.find((directive) => directive.kind === 'body-orientation');
  assert.ok(backOrientation, 'back-to-camera brief must resolve orientation');
  assert.match(backOrientation!.text, /BACK to camera/i, 'back-to-camera brief must lock orientation to BACK');
  const backFraming = backDirectives.find((directive) => directive.kind === 'camera-framing');
  assert.ok(backFraming, 'wide-shot brief must resolve shot size');
  assert.match(backFraming!.text, /wide|long shot/i, 'wide-shot brief must lock to wide/long shot');

  // ── Case 4 — segment scoping: brief mixes "前 4 段侧面 / 第 5 段正面" ──
  // Without scoping the regex picks segment 5's "正面朝镜头 / 极近特写" and
  // forces every keyframe (including segment 1) to use them, which is what
  // produced the broken segment-2 keyframe (front-facing close-up instead of
  // profile + full body). Each shotIndex must now see only its own slice.
  const multiSegmentBrief = [
    '【整片叙事】 她戴着黑色墨镜，从画面左边缘走进来。第 33 秒，巴厘岛悬崖海滩出现，她终于停下，转过身，缓慢地朝镜头走来。',
    '· 镜头机位: 完全锁死的三脚架机位 (locked-off tripod)',
    '',
    '[0-8秒] 段 1 · 东亚四连穿越',
    '锁死三脚架侧面机位。中景全身。女主侧面剪影位于画面左边缘 5%，向画面右侧缓慢迈步。',
    '',
    '[8-16秒] 段 2 · 中东北非四连穿越',
    '锁死三脚架侧面机位保持。女主在画面 22% 位置侧面继续走。',
    '',
    '[32-40秒] 段 5 · 巴厘岛',
    '女主在中央转身，正面朝镜头，缓慢向镜头走来；构图从中景全身收成极近半身/特写。',
  ].join('\n');
  const segment1 = extractOpeningFramingRegex({
    storyBeat: 'Generic boilerplate.',
    sourceStory: multiSegmentBrief,
    shotIndex: 1,
    shotCount: 5,
  });
  const seg1Orient = segment1.find((directive) => directive.kind === 'body-orientation');
  assert.ok(seg1Orient, 'segment 1 must still resolve body orientation');
  assert.match(seg1Orient!.text, /PROFILE/i, 'segment 1 must pick PROFILE from its OWN slice, not FRONT from segment 5');
  const seg1Framing = segment1.find((directive) => directive.kind === 'camera-framing');
  assert.ok(seg1Framing, 'segment 1 must still resolve shot size');
  assert.match(seg1Framing!.text, /medium wide|full-body/i, 'segment 1 must pick medium wide / full body, not segment 5\'s extreme close-up');

  const segment5 = extractOpeningFramingRegex({
    storyBeat: 'Generic boilerplate.',
    sourceStory: multiSegmentBrief,
    shotIndex: 5,
    shotCount: 5,
  });
  const seg5Orient = segment5.find((directive) => directive.kind === 'body-orientation');
  assert.ok(seg5Orient, 'segment 5 must resolve body orientation');
  assert.match(seg5Orient!.text, /FRONT/i, 'segment 5 must lock FRONT now that its slice owns the cue');

  // ── Case 5 — no usable cues → block must collapse to nothing ──
  const sparse = extractOpeningFramingRegex({
    storyBeat: 'The protagonist steps through the scene with a deliberate weight shift.',
    sourceStory: 'The video is about emotion and atmosphere.',
    shotIndex: 1,
    shotCount: 5,
  });
  assert.equal(sparse.length, 0, 'sparse brief should yield no framing directives');
  assert.equal(formatOpeningFramingBlock(sparse), undefined, 'empty directives → no block injected');

  console.log('saga framing extractor smoke ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
