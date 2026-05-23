import assert from 'node:assert/strict';
import { computeDialogueDuckZones } from '../src/tools/visual/sagaRenderer/index.js';
import type { SagaSegmentInput } from '../src/tools/visual/sagaRenderer/types.js';

function makeSegment(index: number, duration: number, storyBeat: string): SagaSegmentInput {
  return {
    index,
    title: `t${index}`,
    duration,
    storyBeat,
    visualPrompt: '',
    prompt: '',
    textOnlyPrompt: '',
    camera: '',
    continuity: '',
    transition: '',
    outputPath: `/tmp/segments/${index}.mp4`,
    mediaPath: `/tmp/media/${index}.mp4`,
  };
}

async function main(): Promise<void> {
  // Mixed segments: 1 = 旁白, 2 = pure ambient, 3 = 对白, 4 = pure visual,
  // 5 = English dialogue marker.
  const segments: SagaSegmentInput[] = [
    makeSegment(1, 10, '**旁白（约 4 秒，低沉）**: "盛夏的风。"'),
    makeSegment(2, 10, '空旷海岸线，狂风与海浪。'),
    makeSegment(3, 10, '**对白（约 5 秒，温柔）**: "你来了。"'),
    makeSegment(4, 10, '日落下的礁石与浪花，纯环境音。'),
    makeSegment(5, 10, 'voiceover: "Just one more step."'),
  ];

  const zones = computeDialogueDuckZones(segments);
  assert.deepEqual(
    zones,
    [
      { start: 0, end: 10 },
      { start: 20, end: 30 },
      { start: 40, end: 50 },
    ],
    'duck zones should cover only the segments with dialogue markers',
  );

  // Contiguous dialogue segments must merge into a single zone.
  const contiguous: SagaSegmentInput[] = [
    makeSegment(1, 5, '**对白**: "A."'),
    makeSegment(2, 5, '**旁白**: "B."'),
    makeSegment(3, 5, 'no dialogue here, only waves'),
    makeSegment(4, 5, '**对白**: "C."'),
  ];
  const mergedZones = computeDialogueDuckZones(contiguous);
  assert.deepEqual(
    mergedZones,
    [
      { start: 0, end: 10 },
      { start: 15, end: 20 },
    ],
    'adjacent dialogue segments must collapse into one zone',
  );

  // Brief without any dialogue markers — no zones, BGM stays flat.
  const noDialogue: SagaSegmentInput[] = [
    makeSegment(1, 10, '海浪、海鸥与风。'),
    makeSegment(2, 10, '黄昏礁石。'),
  ];
  assert.deepEqual(computeDialogueDuckZones(noDialogue), [], 'no dialogue → no duck zones');

  // A bare quoted line ("中国街道") is NOT dialogue — must not be ducked.
  const bareQuotes: SagaSegmentInput[] = [
    makeSegment(1, 10, '设计参考："中国街道" 的霓虹质感与积水反射。'),
  ];
  assert.deepEqual(computeDialogueDuckZones(bareQuotes), [], 'bare design-concept quotes must not trigger ducking');

  console.log('saga bgm variants duck-zone smoke ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
