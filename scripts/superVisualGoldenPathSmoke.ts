import assert from 'node:assert/strict';
import { buildSegmentKeyframePrompt } from '../src/tools/visual/superVisualMode.js';

const baseShot = {
  index: 1,
  title: 'Golden path opening frame',
  duration: 5,
  storyBeat: 'A photoreal Asian woman walks along a warm sunset beach, hair and dress moving in the sea breeze.',
  visualPrompt: 'live-action cinematic realism, natural skin texture, shallow depth of field, golden-hour backlight',
  camera: '35mm handheld tracking shot, waist-up to full-body movement',
  continuity: '保持实拍、写实、电影感、黄昏金色逆光、35mm浅景深',
  prompt: '',
  textOnlyPrompt: '',
};

const withVision = buildSegmentKeyframePrompt({
  shotIndex: 1,
  shotCount: 3,
  shot: baseShot,
  ratio: '16:9',
  withPreviousLastFrame: true,
  realPersonInput: true,
  visionDescription: 'Photorealistic female-presenting character with long dark hair, natural skin texture, and a white summer dress; same person as the provided reference.',
});

assert.match(withVision, /VISUAL TRUTH/i, 'golden path prompt must carry VISUAL TRUTH identity text');
assert.match(withVision, /Photorealistic female-presenting character/i, 'vision description must be included verbatim');
assert.match(withVision, /Same art style as the turnaround/i, 'segment keyframes should use the original mild style inheritance rule');
assert.doesNotMatch(withVision, /NO photoreal/i, 'segment keyframes must never ban photoreal output');
assert.doesNotMatch(withVision, /MUST be rendered in a STYLIZED ILLUSTRATED \/ ANIME/i, 'segment keyframes must not force anime/illustrated output');
assert.doesNotMatch(withVision, /privacy filters/i, 'prompt must not expose provider-bypass implementation details');

const missingVision = buildSegmentKeyframePrompt({
  shotIndex: 2,
  shotCount: 3,
  shot: { ...baseShot, index: 2, title: 'Continuation frame' },
  ratio: '9:16',
  withPreviousLastFrame: true,
  realPersonInput: true,
});

assert.doesNotMatch(missingVision, /NO photoreal/i, 'fallback prompt must not regress to photoreal ban when VISUAL TRUTH is missing');
assert.doesNotMatch(missingVision, /MUST be rendered in a STYLIZED ILLUSTRATED \/ ANIME/i, 'fallback prompt must not force anime when VISUAL TRUTH is missing');
assert.match(missingVision, /Same art style as the turnaround/i, 'fallback prompt should still preserve the golden mild style rule');

console.log('super visual golden path smoke ok');
