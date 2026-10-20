import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  extractSegmentSoundtrack,
  generateAudioWithSoundtrack,
  soundtrackReferenceEligible,
} from '../src/tools/visual/segmentSoundtrack.js';

const execFileAsync = promisify(execFile);

/**
 * Whether the run hands each segment its slice of the music. Only when the
 * provider says it takes audio: an unsupported reference is either ignored
 * (paid for, no effect) or rejected (the segment fails).
 */
function eligibilityChecks(): void {
  const audio = ['image', 'video', 'audio'];
  const noAudio = ['image'];
  assert.equal(soundtrackReferenceEligible({ referenceInputs: audio, soundtrackPath: '/tmp/a.mp3', verbatimSegments: false }), true);
  assert.equal(soundtrackReferenceEligible({ referenceInputs: noAudio, soundtrackPath: '/tmp/a.mp3', verbatimSegments: false }), false, 'Seedance 1.x takes no audio');
  assert.equal(soundtrackReferenceEligible({ referenceInputs: audio, soundtrackPath: undefined, verbatimSegments: false }), false);
  assert.equal(soundtrackReferenceEligible({ referenceInputs: audio, soundtrackPath: '   ', verbatimSegments: false }), false);
  // Raw passthrough adds nothing to the request, music included.
  assert.equal(soundtrackReferenceEligible({ referenceInputs: audio, soundtrackPath: '/tmp/a.mp3', verbatimSegments: true }), false);
}

/** Two soundtracks in one clip is never what was wanted. */
function audioExclusivityChecks(): void {
  assert.equal(generateAudioWithSoundtrack({ usingSoundtrackReference: true, requested: true }), false);
  assert.equal(generateAudioWithSoundtrack({ usingSoundtrackReference: true, requested: false }), false);
  // Without music the segment behaves exactly as it did before.
  assert.equal(generateAudioWithSoundtrack({ usingSoundtrackReference: false, requested: true }), true);
  assert.equal(generateAudioWithSoundtrack({ usingSoundtrackReference: false, requested: false }), false);
}

/** How long ffprobe says a file is. */
async function durationOf(ffprobe: string, file: string): Promise<number> {
  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
  ]);
  return Number(stdout.trim());
}

/**
 * The slice itself, cut from real audio: the offset and the length have to be
 * right, because a slice that drifts is exactly what puts a movement off the
 * beat. A 440 Hz tone stands in for the track.
 */
async function sliceChecks(): Promise<void> {
  const { resolveFfmpegBinaryPath } = await import('../src/tools/visual/sagaRenderer/concat.js');
  const ffmpeg = await resolveFfmpegBinaryPath();
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace('ffmpeg', 'ffprobe'));
  const dir = await mkdtemp(path.join(tmpdir(), 'saga-soundtrack-'));
  try {
    const track = path.join(dir, 'track.m4a');
    await execFileAsync(ffmpeg, [
      '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40',
      '-c:a', 'aac', '-b:a', '128k', track,
    ], { timeout: 120_000 });

    // Segment 3 starts 18s into a film that starts 6s into the track, and
    // runs 7 seconds: the slice is track 24s-31s.
    const slice = await extractSegmentSoundtrack({
      soundtrackPath: track,
      startOffsetSec: 6,
      segmentStartSec: 18,
      segmentDurationSec: 7,
      outputDir: path.join(dir, 'segments'),
      segmentIndex: 3,
    });
    assert.equal(slice.ok, true, slice.ok ? '' : `slice failed: ${slice.reason}`);
    if (!slice.ok) return;
    assert.match(slice.path, /003\.soundtrack\.m4a$/, 'the slice is named after its segment');
    const seconds = await durationOf(ffprobe, slice.path);
    assert.ok(Math.abs(seconds - 7) < 0.2, `the slice is 7s, got ${seconds}`);

    // A slice that runs past the end of the track comes back short, not empty.
    const tail = await extractSegmentSoundtrack({
      soundtrackPath: track,
      startOffsetSec: 0,
      segmentStartSec: 37,
      segmentDurationSec: 10,
      outputDir: path.join(dir, 'segments'),
      segmentIndex: 9,
    });
    assert.equal(tail.ok, true);
    if (tail.ok) {
      const tailSeconds = await durationOf(ffprobe, tail.path);
      assert.ok(tailSeconds > 2 && tailSeconds < 4, `the tail is what is left of the track, got ${tailSeconds}`);
    }

    // A track that is not there is reported, never thrown: the run goes on
    // without music and the renderer still mixes the real one in.
    const missing = await extractSegmentSoundtrack({
      soundtrackPath: path.join(dir, 'nope.mp3'),
      startOffsetSec: 0,
      segmentStartSec: 0,
      segmentDurationSec: 5,
      outputDir: path.join(dir, 'segments'),
      segmentIndex: 1,
    });
    assert.equal(missing.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  eligibilityChecks();
  audioExclusivityChecks();
  await sliceChecks();
  console.log('saga segment soundtrack smoke: ok');
}

await main();
