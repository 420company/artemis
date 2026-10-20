/**
 * Which segments must wait for the one before them, and which may not.
 *
 * A segment is filmed with the previous segment's last frame as a reference,
 * which is why they are made one after another: you cannot grab a frame from
 * a video that does not exist yet. That is a real dependency and no amount of
 * concurrency removes it.
 *
 * But it is not a dependency between every pair of segments. Two cases break
 * it, and in both the break is about the film rather than about speed:
 *
 *   a hard cut into a segment — the edit does not carry the frame across, and
 *     the code has always said so (`!cutsIn` guards every chain decision);
 *   a scene boundary — chapter six opens somewhere else, on another day, with
 *     other people. Inheriting chapter five's closing frame is wrong, not
 *     merely unnecessary, and longformSplit.ts already knows where those
 *     boundaries are (`opensScene`).
 *
 * So the segments form chains: inside a chain, strictly in order; between
 * chains, nothing shared. A novel cut into forty scenes is forty chains, and
 * the wall-clock difference on a film that long is hours.
 *
 * What is deliberately NOT shared between chains: the two counters that make
 * the run adapt as it goes (the privacy-filter streak that abandons chain
 * frames, and the resolution fallback). They exist to stop retrying a
 * strategy that is failing, and a chain is the right scope for that — a
 * scene whose frames the filter rejects says nothing about another scene.
 */

export type ChainableSegment = {
  index: number;
  /** The edit cuts into this segment, so no frame is carried into it. */
  cutsIn?: boolean;
  /** This segment opens a scene (longformSplit's own flag). */
  opensScene?: boolean;
};

export type SegmentChain<T> = {
  /** 1-based, in the order the chains appear in the film. */
  position: number;
  segments: T[];
};

/**
 * Groups segments into chains. A segment starts a new chain when the edit
 * cuts into it or it opens a scene; otherwise it continues the chain it finds
 * itself in, and waits for the segment before it.
 */
export function buildSegmentChains<T extends ChainableSegment>(segments: readonly T[]): SegmentChain<T>[] {
  const chains: SegmentChain<T>[] = [];
  for (const segment of segments) {
    const breaksChain = chains.length === 0 || segment.cutsIn === true || segment.opensScene === true;
    if (breaksChain) {
      chains.push({ position: chains.length + 1, segments: [segment] });
    } else {
      chains[chains.length - 1]!.segments.push(segment);
    }
  }
  return chains;
}

/**
 * How many chains to film at once.
 *
 * Not "as many as there are": every clip in flight is a paid request, and a
 * provider that rate-limits turns ten parallel calls into ten retries. Three
 * is what the long-video pipeline already assumes elsewhere, and a run with
 * only a few chains never benefits from more than it has.
 */
export const DEFAULT_CHAIN_CONCURRENCY = 3;

export function chainConcurrency(options: {
  chainCount: number;
  requested?: number | undefined;
}): number {
  const requested = options.requested ?? DEFAULT_CHAIN_CONCURRENCY;
  const bounded = Math.max(1, Math.min(8, Math.round(requested)));
  return Math.max(1, Math.min(bounded, options.chainCount));
}

/**
 * Runs the chains with a bounded number in flight, in order of position, and
 * stops starting new ones once something has asked it to stop.
 *
 * Results come back in segment order regardless of the order they finished,
 * because the renderer assembles the film from that order and a concurrent
 * run must not change what it produces.
 */
export async function runChains<T extends ChainableSegment, R>(
  chains: readonly SegmentChain<T>[],
  concurrency: number,
  runChain: (chain: SegmentChain<T>) => Promise<R[]>,
  shouldStop: () => boolean,
): Promise<R[]> {
  const results = new Array<R[]>(chains.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      if (shouldStop()) return;
      const mine = next;
      next += 1;
      if (mine >= chains.length) return;
      results[mine] = await runChain(chains[mine]!);
    }
  });
  await Promise.all(workers);
  return results.flatMap((chunk) => chunk ?? []);
}

/** One line for the log, so the shape of the run is visible. */
export function describeChains(chains: readonly SegmentChain<unknown>[], concurrency: number): string {
  const lengths = chains.map((chain) => chain.segments.length);
  const longest = lengths.length > 0 ? Math.max(...lengths) : 0;
  if (chains.length <= 1) {
    return `整片是一条连续的镜头链（${longest} 段），逐段按顺序生成。`;
  }
  return `分成 ${chains.length} 条独立镜头链（最长 ${longest} 段），最多 ${concurrency} 条同时生成；链内仍然按顺序等上一段的末帧。`;
}
