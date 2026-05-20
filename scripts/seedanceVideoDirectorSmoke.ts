import assert from 'node:assert/strict';
import { buildDirectedVideoPrompt } from '../src/tools/visual/videoDirector.js';

function assertIncludes(haystack: string, needle: string): void {
  assert.ok(
    haystack.includes(needle),
    `Expected directed prompt to include ${JSON.stringify(needle)}\nActual: ${haystack}`,
  );
}

const dialogue = buildDirectedVideoPrompt({
  prompt: '一个年轻女人看向镜头，用中文说："今天的阳光很好。" 背景是安静咖啡馆。',
  provider: 'custom',
  model: 'dreamina-seedance-2-0-260128',
  duration: 6,
  ratio: '16:9',
});

assertIncludes(dialogue.directedPrompt, '"今天的阳光很好。"');
assertIncludes(dialogue.directedPrompt, 'treat quoted text as verbatim dialogue or voice-over');
assertIncludes(dialogue.directedPrompt, 'lip-sync mouth movement to the spoken language phonemes');

const multimodal = buildDirectedVideoPrompt({
  prompt: '品牌广告，产品在冷色调灯光中旋转，参考素材完成运镜和配乐卡点。',
  provider: 'byteplus',
  model: 'dreamina-seedance-2-0-260128',
  duration: 10,
  ratio: '9:16',
  referenceImageCount: 2,
  referenceVideoCount: 1,
  referenceAudioCount: 1,
  firstFrameImageCount: 1,
  lastFrameImageCount: 1,
});

assertIncludes(multimodal.directedPrompt, 'Image 1-2 are reference images');
assertIncludes(multimodal.directedPrompt, 'First Frame Image 1-1 pins the literal opening frame');
assertIncludes(multimodal.directedPrompt, 'Last Frame Image 1-1 pins the target closing frame');
assertIncludes(multimodal.directedPrompt, 'Video Clip 1-1 control camera motion');
assertIncludes(multimodal.directedPrompt, 'Audio Clip 1-1 controls music tempo');
assertIncludes(multimodal.directedPrompt, '竖屏9:16');


const autoCreated = buildDirectedVideoPrompt({
  prompt: 'AI自己创造一个角色和剧情，做一个8秒电影感短片。',
  provider: 'byteplus',
  model: 'dreamina-seedance-2-0-260128',
  duration: 8,
  ratio: '16:9',
});

assertIncludes(autoCreated.directedPrompt, 'full Seedance 2.0 production spec');
assertIncludes(autoCreated.directedPrompt, 'Invent exactly one primary protagonist');
assertIncludes(autoCreated.directedPrompt, 'stable age range, face shape, hair, wardrobe');
assertIncludes(autoCreated.directedPrompt, 'AI-created story rule: build a compact three-beat micro-story');
assertIncludes(autoCreated.directedPrompt, 'Do not introduce extra protagonists');
assertIncludes(autoCreated.directedPrompt, 'Every invented detail must serve subject + action + scene + style + emotion');

console.log('seedanceVideoDirectorSmoke passed');
