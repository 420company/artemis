import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SagaInspectReport, SagaCompositionSpec, SagaSegmentInput } from './types.js';

// Saga inspect — emits the JSON metadata digest a downstream tool needs to
// understand the composition without re-reading the HTML. Saga's writer
// already produces saga.json, but we re-derive a uniform schema here so
// external tools can rely on a stable contract regardless of who wrote
// the project on disk.

export type SagaInspectInput = {
  htmlPath: string;
  composition: SagaCompositionSpec;
  segments: SagaSegmentInput[];
};

export function inspectSagaComposition(input: SagaInspectInput): SagaInspectReport {
  const segments = input.segments.map((segment, idx) => ({
    index: segment.index,
    title: segment.title,
    start: input.segments
      .slice(0, idx)
      .reduce((acc, prev) => acc + prev.duration, 0),
    duration: segment.duration,
    media: path.relative(path.dirname(input.htmlPath), segment.mediaPath),
    continuity: segment.continuity,
    transitionInto: idx === 0 ? null : input.composition.transitions[idx - 1]?.kind ?? null,
  }));

  return {
    schema: 'artemis-saga.inspect.v1',
    projectId: input.composition.projectId,
    width: input.composition.width,
    height: input.composition.height,
    fps: input.composition.fps,
    totalSeconds: input.composition.totalSeconds,
    segmentCount: input.segments.length,
    tracks: { video: 0, audio: 1, transition: 2, finishing: 3 },
    segments,
  };
}

export async function inspectFromManifestFile(manifestPath: string): Promise<SagaInspectReport | null> {
  try {
    const text = await readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(text);
    if (!manifest || typeof manifest !== 'object') return null;
    return {
      schema: 'artemis-saga.inspect.v1',
      projectId: String(manifest.projectId ?? ''),
      width: Number(manifest.width ?? 1920),
      height: Number(manifest.height ?? 1080),
      fps: Number(manifest.fps ?? 30) as SagaInspectReport['fps'],
      totalSeconds: Number(manifest.duration ?? 0),
      segmentCount: Array.isArray(manifest.segments) ? manifest.segments.length : 0,
      tracks: manifest.tracks ?? { video: 0, audio: 1, transition: 2, finishing: 3 },
      segments: Array.isArray(manifest.segments) ? manifest.segments : [],
    };
  } catch {
    return null;
  }
}
