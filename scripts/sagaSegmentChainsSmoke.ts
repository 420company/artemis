import assert from 'node:assert/strict';
import {
  buildSegmentChains,
  chainConcurrency,
  describeChains,
  runChains,
  type SegmentChain,
} from '../src/tools/visual/segmentChains.js';

type Seg = { index: number; cutsIn?: boolean; opensScene?: boolean };
const seg = (index: number, extra: Partial<Seg> = {}): Seg => ({ index, ...extra });

/**
 * A segment is filmed with the previous one's last frame, so it waits. The
 * dependency is real -- you cannot grab a frame from a video that does not
 * exist yet -- but it does not hold between every pair.
 */
function chainChecks(): void {
  // Nothing breaks the chain: one chain, filmed in order, as before.
  const straight = buildSegmentChains([seg(1), seg(2), seg(3), seg(4)]);
  assert.equal(straight.length, 1);
  assert.deepEqual(straight[0]!.segments.map((s) => s.index), [1, 2, 3, 4]);

  // A hard cut carries no frame across, which the code has always said.
  const withCut = buildSegmentChains([seg(1), seg(2), seg(3, { cutsIn: true }), seg(4)]);
  assert.equal(withCut.length, 2);
  assert.deepEqual(withCut[0]!.segments.map((s) => s.index), [1, 2]);
  assert.deepEqual(withCut[1]!.segments.map((s) => s.index), [3, 4]);

  // A scene boundary breaks it for a reason about the film: chapter six opens
  // somewhere else, so inheriting chapter five's closing frame is wrong.
  const scenes = buildSegmentChains([
    seg(1, { opensScene: true }), seg(2), seg(3),
    seg(4, { opensScene: true }), seg(5),
    seg(6, { opensScene: true }),
  ]);
  assert.equal(scenes.length, 3);
  assert.deepEqual(scenes.map((chain) => chain.segments.length), [3, 2, 1]);
  assert.deepEqual(scenes.map((chain) => chain.position), [1, 2, 3]);

  // A novel cut into forty scenes is forty chains.
  const novel = buildSegmentChains(
    Array.from({ length: 120 }, (_, i) => seg(i + 1, i % 3 === 0 ? { opensScene: true } : {})),
  );
  assert.equal(novel.length, 40);

  assert.deepEqual(buildSegmentChains([]), []);
}

/** Every clip in flight is a paid request, so the number is bounded. */
function concurrencyChecks(): void {
  assert.equal(chainConcurrency({ chainCount: 40 }), 3, 'the default');
  assert.equal(chainConcurrency({ chainCount: 2 }), 2, 'never more chains than exist');
  assert.equal(chainConcurrency({ chainCount: 1 }), 1);
  assert.equal(chainConcurrency({ chainCount: 0 }), 1, 'always at least one worker');
  assert.equal(chainConcurrency({ chainCount: 40, requested: 6 }), 6);
  assert.equal(chainConcurrency({ chainCount: 40, requested: 99 }), 8, 'capped');
  assert.equal(chainConcurrency({ chainCount: 40, requested: 0 }), 1);
  assert.equal(chainConcurrency({ chainCount: 40, requested: -5 }), 1);
}

/**
 * Results come back in segment order whatever order they finished in, because
 * the renderer assembles the film from that order: a concurrent run must not
 * change what it produces.
 */
async function orderChecks(): Promise<void> {
  const chains = buildSegmentChains([
    seg(1, { opensScene: true }), seg(2),
    seg(3, { opensScene: true }), seg(4),
    seg(5, { opensScene: true }),
  ]);
  // The later chains finish first.
  const run = async (chain: SegmentChain<Seg>): Promise<number[]> => {
    await new Promise((resolve) => { setTimeout(resolve, (4 - chain.position) * 20); });
    return chain.segments.map((s) => s.index);
  };
  const order = await runChains(chains, 3, run, () => false);
  assert.deepEqual(order, [1, 2, 3, 4, 5], 'segment order, not completion order');

  // Serial and concurrent produce the same list.
  assert.deepEqual(await runChains(chains, 1, run, () => false), order);

  // Observed concurrency really is bounded.
  let live = 0;
  let peak = 0;
  await runChains(chains, 2, async (chain) => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    live -= 1;
    return chain.segments.map((s) => s.index);
  }, () => false);
  assert.equal(peak, 2, `at most two chains in flight, saw ${peak}`);
}

/** A run that has failed must not keep paying for clips. */
async function stopChecks(): Promise<void> {
  const chains = buildSegmentChains(
    Array.from({ length: 12 }, (_, i) => seg(i + 1, { opensScene: true })),
  );
  let started = 0;
  let stop = false;
  const done = await runChains(chains, 2, async (chain) => {
    started += 1;
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    if (chain.position === 2) stop = true;
    return [chain.segments[0]!.index];
  }, () => stop);
  assert.ok(started < chains.length, `stopped early, started ${started} of ${chains.length}`);
  assert.ok(done.length < chains.length);
}

/** The shape of the run is visible in one line. */
function describeChecks(): void {
  assert.match(describeChains(buildSegmentChains([seg(1), seg(2)]), 3), /一条连续的镜头链（2 段）/);
  const many = describeChains(buildSegmentChains([seg(1), seg(2), seg(3, { opensScene: true })]), 3);
  assert.match(many, /2 条独立镜头链/);
  assert.match(many, /最长 2 段/);
  assert.match(many, /最多 3 条同时生成/);
  assert.match(many, /链内仍然按顺序等上一段的末帧/);
}

async function main(): Promise<void> {
  chainChecks();
  concurrencyChecks();
  await orderChecks();
  await stopChecks();
  describeChecks();
  console.log('saga segment chains smoke: ok');
}

await main();
