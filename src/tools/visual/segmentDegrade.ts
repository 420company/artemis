/**
 * What happens to the rest of a film when one segment will not render.
 *
 * Saga gave a segment three attempts and then failed the whole run. On an
 * eight-segment film that is reasonable -- `resume` means a re-run does not
 * pay for the segments already made. On a two-hour film cut from a novel it
 * is not: a prompt the provider's filter will always reject makes every
 * re-run stop in the same place, and nothing after it is ever rendered.
 *
 * So there are two steps before giving up on a segment, and one rule about
 * when giving up on the film is still the right answer.
 */

/** Resolutions a provider lists, cheapest first. */
const RESOLUTION_ORDER = ['480p', '720p', '1080p'] as const;

/**
 * The next cheaper resolution to try, or nothing when already at the floor.
 *
 * A fourth attempt at the same resolution would do what the first three did.
 * A smaller one is a different request: it is cheaper, it is what some
 * provider-side limits are actually about, and a segment the owner can watch
 * beats a hole in the film.
 */
export function lowerResolution(
  current: string | undefined,
  available: readonly string[] = RESOLUTION_ORDER,
): string | undefined {
  const order = RESOLUTION_ORDER.filter((value) => available.includes(value));
  if (order.length === 0) return undefined;
  // Without a stated resolution the provider chose, and we do not know which.
  // Its default is never the cheapest, so the floor is a real step down.
  if (!current) return order[0] === '480p' ? '480p' : order[0];
  const index = order.indexOf(current as (typeof RESOLUTION_ORDER)[number]);
  if (index <= 0) return undefined;
  return order[index - 1];
}

export type SegmentFailureMode = 'stop' | 'skip';

export type SegmentFailureDecision =
  | { action: 'stop'; reason: string }
  | { action: 'skip' };

/**
 * Whether to carry on without this segment.
 *
 * Skipping is never the default: a film quietly delivered with holes in it is
 * worse than one that says it could not be made. It is for a caller that
 * asked for it -- the long-form pipeline, where one unfilmable paragraph out
 * of six hundred should not stop the other five hundred and ninety-nine.
 *
 * Even then it stops when the failures stop looking like bad luck: a quarter
 * of the film missing, or three segments in a row, means the run is broken
 * rather than degraded, and spending the rest of the budget on it is waste.
 */
export function decideAfterSegmentFailure(input: {
  mode: SegmentFailureMode;
  totalSegments: number;
  /** Including this one. */
  failedSoFar: number;
  consecutiveFailures: number;
}): SegmentFailureDecision {
  if (input.mode !== 'skip') {
    return { action: 'stop', reason: 'this segment could not be rendered' };
  }
  if (input.consecutiveFailures >= 3) {
    return { action: 'stop', reason: `${input.consecutiveFailures} segments in a row failed` };
  }
  const ceiling = Math.max(1, Math.floor(input.totalSegments / 4));
  if (input.failedSoFar > ceiling) {
    return {
      action: 'stop',
      reason: `${input.failedSoFar} of ${input.totalSegments} segments failed, past the quarter this run allows`,
    };
  }
  return { action: 'skip' };
}

/** What the owner is told at the end about the segments that are not there. */
export function describeSkippedSegments(skipped: readonly number[], total: number): string {
  if (skipped.length === 0) return '';
  const list = skipped.length > 12
    ? `${skipped.slice(0, 12).join('、')} 等 ${skipped.length} 段`
    : skipped.join('、');
  return `有 ${skipped.length}/${total} 段没有生成出来（第 ${list} 段），成片在这些位置是跳过的。重跑会只补这几段，已经做好的段不会重新花钱。`;
}
