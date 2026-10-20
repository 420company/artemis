import assert from 'node:assert/strict';
import {
  decideAfterSegmentFailure,
  describeSkippedSegments,
  lowerResolution,
} from '../src/tools/visual/segmentDegrade.js';

/**
 * A fourth attempt at the same size repeats the first three. A smaller one is
 * a different request: cheaper, and what some provider-side limits are about.
 */
function resolutionChecks(): void {
  assert.equal(lowerResolution('1080p'), '720p');
  assert.equal(lowerResolution('720p'), '480p');
  assert.equal(lowerResolution('480p'), undefined, 'already at the floor');
  // Nothing stated means the provider picked, and its default is never the
  // cheapest, so the floor is still a step down.
  assert.equal(lowerResolution(undefined), '480p');
  // A provider that lists fewer sizes steps within its own list.
  assert.equal(lowerResolution('1080p', ['480p', '1080p']), '480p');
  assert.equal(lowerResolution('1080p', ['1080p']), undefined);
  assert.equal(lowerResolution('1080p', []), undefined);
  // An unknown name is not silently downgraded.
  assert.equal(lowerResolution('4k'), undefined);
}

/**
 * Skipping is never the default: a film quietly delivered with holes is worse
 * than one that says it could not be made. And even when asked for, it stops
 * once the failures stop looking like bad luck.
 */
function policyChecks(): void {
  const stop = decideAfterSegmentFailure({ mode: 'stop', totalSegments: 8, failedSoFar: 1, consecutiveFailures: 1 });
  assert.equal(stop.action, 'stop');

  // One bad paragraph out of six hundred does not stop the other 599.
  const skip = decideAfterSegmentFailure({ mode: 'skip', totalSegments: 600, failedSoFar: 1, consecutiveFailures: 1 });
  assert.equal(skip.action, 'skip');

  // Three in a row is a broken run, not bad luck.
  const streak = decideAfterSegmentFailure({ mode: 'skip', totalSegments: 600, failedSoFar: 3, consecutiveFailures: 3 });
  assert.equal(streak.action, 'stop');
  if (streak.action === 'stop') assert.match(streak.reason, /in a row/);

  // A quarter of the film missing is the ceiling.
  assert.equal(decideAfterSegmentFailure({ mode: 'skip', totalSegments: 8, failedSoFar: 2, consecutiveFailures: 1 }).action, 'skip');
  const past = decideAfterSegmentFailure({ mode: 'skip', totalSegments: 8, failedSoFar: 3, consecutiveFailures: 1 });
  assert.equal(past.action, 'stop');
  if (past.action === 'stop') assert.match(past.reason, /3 of 8/);

  // A short film still allows one: a quarter of three rounds to zero, and a
  // single skipped shot out of three is already the whole point of asking.
  assert.equal(decideAfterSegmentFailure({ mode: 'skip', totalSegments: 3, failedSoFar: 1, consecutiveFailures: 1 }).action, 'skip');
  assert.equal(decideAfterSegmentFailure({ mode: 'skip', totalSegments: 3, failedSoFar: 2, consecutiveFailures: 1 }).action, 'stop');
}

/** A film with gaps must never look finished. */
function reportChecks(): void {
  assert.equal(describeSkippedSegments([], 10), '');
  const few = describeSkippedSegments([3, 7], 10);
  assert.match(few, /2\/10/);
  assert.match(few, /第 3、7 段/);
  assert.match(few, /重跑会只补这几段/);
  // A long list is summarised rather than printed in full.
  const many = describeSkippedSegments(Array.from({ length: 30 }, (_, i) => i + 1), 600);
  assert.match(many, /30\/600/);
  assert.match(many, /等 30 段/);
}

function main(): void {
  resolutionChecks();
  policyChecks();
  reportChecks();
  console.log('saga segment degrade smoke: ok');
}

main();
