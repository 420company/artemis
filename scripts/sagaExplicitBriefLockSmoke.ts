import assert from 'node:assert/strict';
import { compileShotPromptWithContinuity } from '../src/tools/visual/sagaRenderer/continuity.js';
import type { SagaContinuityBible } from '../src/tools/visual/sagaRenderer/continuity.js';

const bible: SagaContinuityBible = {
  identityCard: 'identity: NeonCat launch host, short silver hair, black jacket.',
  bible: 'world: rooftop product launch stage, holographic screen, city skyline, glowing product pedestal.',
  characters: ['NeonCat launch host'],
  wardrobe: ['black jacket'],
  props: ['holographic screen', 'glowing product pedestal', 'NeonCat logo'],
  locations: ['rooftop product launch stage'],
  palette: ['electric blue', 'black', 'silver'],
  lighting: 'neon rim light',
  cameraLanguage: 'slow crane push-in',
  mood: 'premium tech launch atmosphere',
};

const prompt = compileShotPromptWithContinuity({
  bible,
  mode: 'text-only',
  shotIndex: 1,
  shotCount: 4,
  duration: 6,
  title: 'Shot 1',
  storyBeat: '夜晚城市天台发布会舞台，主持人站在全息屏幕旁，屏幕展示 NeonCat logo 和中文标语“现在开始”。对白：“欢迎来到未来。”',
  visualPrompt: 'Slow push-in toward the host on the rooftop launch stage; preserve the holographic screen, NeonCat logo, Chinese slogan, and skyline.',
  camera: 'slow crane push-in from rooftop skyline to medium close-up beside the holographic screen',
  continuity: 'same launch host, same black jacket, same rooftop product launch stage, same NeonCat logo',
  transition: 'hold on the glowing product pedestal for final half second',
});

function includes(value: string): void {
  assert.ok(prompt.includes(value), `missing ${JSON.stringify(value)}\n${prompt}`);
}

includes('EXPLICIT USER BRIEF LOCK');
includes('Explicit location anchors extracted from this brief: rooftop product launch stage.');
includes('Explicit prop anchors extracted from this brief: holographic screen | glowing product pedestal | NeonCat logo.');
includes('Explicit character / brand-name anchors extracted from this brief: NeonCat launch host.');
includes('Quoted dialogue extracted from this brief, preserve verbatim: “欢迎来到未来。”.');
includes('中文标语“现在开始”');
includes('do not replace them with a generic room, bedroom, cafe, office, or unrelated interior unless the user explicitly asked for that environment');
includes('Dialogue rule: quoted text / 对白 is verbatim spoken audio');
includes('preserve any quoted dialogue, brand names, and requested on-screen Chinese text');
assert.ok(!prompt.includes('polished English'), 'old English-only tail should be removed');

console.log('sagaExplicitBriefLockSmoke passed');
