import assert from 'node:assert/strict';
import { hasStructuredBriefMarkers } from '../src/tools/generateLongVideo.js';
import {
  detectsLockOffCamera,
  detectsEnvironmentalAudioOnly,
  buildContinuityBible,
} from '../src/tools/visual/sagaRenderer/continuity.js';

// Generic structural-detection smoke. Validates that the Phase 1 generalisation
// works for MANY different brief formats — not just the JVKE travel brief that
// originally surfaced the bugs. Every assertion here is a contract: any future
// user using any of these formats should get correct handling.
async function main(): Promise<void> {
  // ── hasStructuredBriefMarkers: 6 different time/scene marker formats ─

  // Bracket time with 秒/s suffix
  assert.equal(hasStructuredBriefMarkers('[0-8秒] 段 1 内容'), true, 'bracket-second');
  assert.equal(hasStructuredBriefMarkers('[0-8s] segment 1 content'), true, 'bracket-s');
  assert.equal(hasStructuredBriefMarkers('[0-8] plain bracket'), true, 'bracket-bare');

  // MM:SS bracket time
  assert.equal(hasStructuredBriefMarkers('[0:00-0:08] opener'), true, 'mmss-bracket');
  assert.equal(hasStructuredBriefMarkers('[1:30-1:38] mid scene'), true, 'mmss-mid');

  // Loose timecode at line head with colon
  assert.equal(hasStructuredBriefMarkers('\n0-8s: opening shot'), true, 'loose-colon');
  assert.equal(hasStructuredBriefMarkers('\n0:00-0:08: opening'), true, 'loose-mmss-colon');

  // Scene/Shot markers without explicit times
  assert.equal(hasStructuredBriefMarkers('\nScene 1: girl walks in.\nScene 2: she turns.'), true, 'scene-marker');
  assert.equal(hasStructuredBriefMarkers('\nShot 1. cityscape\nShot 2. close-up'), true, 'shot-marker');
  assert.equal(hasStructuredBriefMarkers('\n镜头 1：街景\n镜头 2：特写'), true, 'cn-shot');
  assert.equal(hasStructuredBriefMarkers('\n第 1 段、开场\n第 2 段、推进'), true, 'cn-paragraph');
  // "段 N · ..." is also a common Chinese structural marker — accept it.
  assert.equal(hasStructuredBriefMarkers('\n段 1 · 开场'), true, 'bare-duan-with-number');

  // Free prose without markers → NOT structured (allow LLM rewrite)
  assert.equal(hasStructuredBriefMarkers('A girl walks through a city.'), false, 'free-prose');
  assert.equal(hasStructuredBriefMarkers('帮我生成一段视频，女主走过城市。'), false, 'cn-prose');

  // ── detectsLockOffCamera: 7+ keyword variants ─

  assert.equal(detectsLockOffCamera('locked-off tripod, no movement'), true);
  assert.equal(detectsLockOffCamera('locked off tripod'), true);
  assert.equal(detectsLockOffCamera('NO pan, no tilt'), true);
  assert.equal(detectsLockOffCamera('no zoom, no dolly'), true);
  assert.equal(detectsLockOffCamera('no handheld shake'), true);
  assert.equal(detectsLockOffCamera('完全锁死的三脚架机位'), true);
  assert.equal(detectsLockOffCamera('锁死三脚架'), true);
  assert.equal(detectsLockOffCamera('锁死机位'), true);
  assert.equal(detectsLockOffCamera('镜头钉死在原地'), true);
  assert.equal(detectsLockOffCamera('无任何镜头运动'), true);
  assert.equal(detectsLockOffCamera('no camera movement whatsoever'), true);
  // Negatives
  assert.equal(detectsLockOffCamera('handheld vlog feel'), false);
  assert.equal(detectsLockOffCamera('gentle dolly push-in'), false);
  assert.equal(detectsLockOffCamera('smooth gimbal arc'), false);

  // ── detectsEnvironmentalAudioOnly: many phrasing variants ─

  assert.equal(detectsEnvironmentalAudioOnly('音乐是后期叠加'), true);
  assert.equal(detectsEnvironmentalAudioOnly('BGM 后期叠加'), true);
  assert.equal(detectsEnvironmentalAudioOnly('后期叠加音乐'), true);
  assert.equal(detectsEnvironmentalAudioOnly('只出环境音'), true);
  assert.equal(detectsEnvironmentalAudioOnly('AI 生成阶段只出环境音'), true);
  assert.equal(detectsEnvironmentalAudioOnly('仅环境音'), true);
  assert.equal(detectsEnvironmentalAudioOnly('不要 BGM'), true);
  assert.equal(detectsEnvironmentalAudioOnly('无背景音乐'), true);
  assert.equal(detectsEnvironmentalAudioOnly('no music, environmental audio only'), true);
  assert.equal(detectsEnvironmentalAudioOnly('environmental audio only'), true);
  assert.equal(detectsEnvironmentalAudioOnly('ambient sounds only'), true);
  assert.equal(detectsEnvironmentalAudioOnly('music is added in post'), true);
  assert.equal(detectsEnvironmentalAudioOnly('soundtrack is overlaid in post-production'), true);
  // Negatives
  assert.equal(detectsEnvironmentalAudioOnly('background music plays softly'), false);
  assert.equal(detectsEnvironmentalAudioOnly('请生成配乐和环境音'), false);

  // ── AUDIO-LOCK emission in continuity bible ─

  const audioOnlyBible = buildContinuityBible({
    story: 'A scene. 音乐和对白都是后期叠加；AI 生成阶段只出环境音。',
    ratio: '16:9',
  });
  assert.match(audioOnlyBible.identityCard, /\[AUDIO-LOCK/);
  assert.match(audioOnlyBible.identityCard, /environmental \/ diegetic sounds only/);
  assert.match(audioOnlyBible.identityCard, /Do NOT synthesize music/);

  const musicAllowedBible = buildContinuityBible({
    story: 'A scene with cinematic score and rich BGM.',
    ratio: '16:9',
  });
  assert.doesNotMatch(musicAllowedBible.identityCard, /\[AUDIO-LOCK/);

  console.log('saga brief structure smoke ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
