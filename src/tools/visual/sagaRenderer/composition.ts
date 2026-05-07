import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir } from '../../../utils/fs.js';
import { SAGA_RUNTIME_IIFE } from './runtime.js';
import type {
  SagaCompositionSpec,
  SagaRatio,
  SagaSegmentInput,
  SagaTransitionPlan,
} from './types.js';

// Saga composition format. The data attributes are intentionally compatible
// with Hyperframes (data-composition-id / data-start / data-duration /
// data-track-index / class="clip") so the same HTML works in third-party
// previewers — but the runtime contract uses the Saga-namespaced globals
// installed by SAGA_RUNTIME_IIFE.

export type SagaCompositionPaths = {
  htmlPath: string;
  runtimePath: string;
  designPath: string;
  manifestPath: string;
  readmePath: string;
};

export function ratioToSize(ratio: SagaRatio): { width: number; height: number } {
  if (ratio === '9:16') return { width: 1080, height: 1920 };
  if (ratio === '1:1') return { width: 1080, height: 1080 };
  return { width: 1920, height: 1080 };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function transitionStyleClass(plan: SagaTransitionPlan): string {
  switch (plan.kind) {
    case 'light-leak':
      return 'saga-fx-light-leak';
    case 'fade-black':
      return 'saga-fx-fade-black';
    case 'fade-white':
      return 'saga-fx-fade-white';
    case 'crossfade':
    case 'dissolve':
      return 'saga-fx-fade';
    case 'wipe-left':
    case 'wipe-right':
    case 'slide-up':
    case 'push-left':
    case 'push-right':
      return 'saga-fx-wipe';
    case 'circle-open':
    case 'circle-close':
      return 'saga-fx-circle';
    case 'blur':
      return 'saga-fx-blur';
    case 'zoom-in':
    case 'zoom-out':
      return 'saga-fx-zoom';
    case 'cut':
    default:
      return 'saga-fx-cut';
  }
}

const SAGA_BASE_CSS = `
  html, body { margin: 0; padding: 0; background: #000; overflow: hidden; }
  [data-composition-id] { position: relative; overflow: hidden; background-color: #000; }
  .clip { visibility: hidden; }
  video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; background: #000; }
  audio { display: none; }
  .saga-fx-fade { position: absolute; inset: 0; background: rgba(0,0,0,0.0); pointer-events: none; mix-blend-mode: normal; }
  .saga-fx-fade-black { position: absolute; inset: 0; background: #000; opacity: 0; pointer-events: none; }
  .saga-fx-fade-white { position: absolute; inset: 0; background: #fff; opacity: 0; pointer-events: none; }
  .saga-fx-light-leak { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(255,255,255,0), rgba(248,201,106,0.42), rgba(255,255,255,0)); opacity: 0; transform: translateX(-28%); mix-blend-mode: screen; pointer-events: none; }
  .saga-fx-wipe { position: absolute; inset: 0; background: #000; opacity: 0; pointer-events: none; }
  .saga-fx-circle { position: absolute; inset: 0; background: #000; opacity: 0; clip-path: circle(0% at 50% 50%); pointer-events: none; }
  .saga-fx-blur { position: absolute; inset: 0; backdrop-filter: blur(0px); opacity: 0; pointer-events: none; }
  .saga-fx-zoom { position: absolute; inset: 0; background: rgba(0,0,0,0); pointer-events: none; }
  .saga-fx-cut { display: none; }
  .saga-vignette { position: absolute; inset: 0; box-shadow: inset 0 0 160px rgba(0,0,0,0.45); pointer-events: none; z-index: 5; opacity: 0.55; }
`;

export type WriteSagaCompositionInput = {
  hyperframesProjectDir: string; // kept name for backward compatibility on disk
  composition: SagaCompositionSpec;
  segments: SagaSegmentInput[]; // already populated mediaPath under hyperframesProjectDir/media/segments
  generateAudio: boolean;
};

export async function writeSagaComposition(input: WriteSagaCompositionInput): Promise<SagaCompositionPaths> {
  const dir = input.hyperframesProjectDir;
  await ensureDir(dir);
  await ensureDir(path.join(dir, 'media', 'segments'));

  const htmlPath = path.join(dir, 'index.html');
  const runtimePath = path.join(dir, 'saga-runtime.js');
  const designPath = path.join(dir, 'design.md');
  const manifestPath = path.join(dir, 'saga.json');
  const readmePath = path.join(dir, 'README.md');

  let cursor = 0;
  const videoClips: string[] = [];
  const audioClips: string[] = [];
  const transitionEls: string[] = [];

  for (let i = 0; i < input.segments.length; i += 1) {
    const segment = input.segments[i]!;
    const id = `seg-${String(segment.index).padStart(3, '0')}`;
    const rel = path.relative(dir, segment.mediaPath);
    const startStr = cursor.toFixed(2);
    const durStr = segment.duration.toFixed(2);
    videoClips.push(
      `    <video id="${id}" class="clip" data-start="${startStr}" data-duration="${durStr}" data-track-index="0" src="${rel}" muted playsinline data-title="${escapeHtml(segment.title)}"></video>`,
    );
    if (input.generateAudio) {
      audioClips.push(
        `    <audio id="${id}-audio" class="clip" data-start="${startStr}" data-duration="${durStr}" data-track-index="1" src="${rel}" data-volume="1"></audio>`,
      );
    }
    if (i > 0) {
      const transition = input.composition.transitions[i - 1] ?? { kind: 'crossfade', durationMs: 250 };
      const transitionDuration = Math.max(0.05, transition.durationMs / 1000);
      const transitionStart = Math.max(0, cursor - transitionDuration / 2);
      const cls = transitionStyleClass(transition);
      transitionEls.push(
        `    <div id="transition-${String(segment.index - 1).padStart(3, '0')}" class="clip ${cls}" data-start="${transitionStart.toFixed(2)}" data-duration="${transitionDuration.toFixed(2)}" data-track-index="2" data-transition-kind="${transition.kind}"></div>`,
      );
    }
    cursor += segment.duration;
  }

  const total = input.composition.totalSeconds;
  const html = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    `  <title>${escapeHtml(input.composition.projectId)}</title>`,
    '  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>',
    '  <style>',
    SAGA_BASE_CSS,
    '  </style>',
    '</head>',
    '<body>',
    `  <div id="stage" data-composition-id="${escapeHtml(input.composition.projectId)}" data-start="0" data-duration="${total.toFixed(2)}" data-width="${input.composition.width}" data-height="${input.composition.height}">`,
    ...videoClips,
    ...audioClips,
    ...transitionEls,
    `    <div id="saga-vignette" class="clip saga-vignette" data-start="0" data-duration="${total.toFixed(2)}" data-track-index="3"></div>`,
    '  </div>',
    '  <script src="./saga-runtime.js"></script>',
    '  <script>',
    `    window.__sagaRegisterTimeline(${JSON.stringify(input.composition.projectId)}, function (tl) {`,
    ...input.composition.transitions.map((plan, idx) => {
      const transitionDuration = Math.max(0.05, plan.durationMs / 1000);
      const transitionStart = Math.max(0, totalUpTo(input.segments, idx + 1) - transitionDuration / 2);
      const id = `#transition-${String(idx + 1).padStart(3, '0')}`;
      return `      window.__sagaTransitionTween(tl, ${JSON.stringify(id)}, ${transitionStart.toFixed(2)}, ${transitionDuration.toFixed(2)});`;
    }),
    `      window.__sagaVignetteTween(tl, "#saga-vignette", ${total.toFixed(2)});`,
    '    });',
    '  </script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');

  const design = [
    '# Saga Composition Design',
    '',
    `project: ${input.composition.projectId}`,
    `ratio: ${input.composition.ratio}`,
    `duration: ${total.toFixed(2)}s`,
    `fps: ${input.composition.fps}`,
    'mood: cinematic long-form assembly with continuity-anchored shots',
    'canvas: black',
    'accent: #f8c96a',
    'motion: seek-driven via window.__sagaTimelines, clip visibility managed by saga-runtime.js',
    '',
    'Tracks:',
    '- 0 video',
    '- 1 audio',
    '- 2 transitions',
    '- 3 finishing (vignette)',
    '',
    'Do:',
    '- Keep generated video clips full-bleed.',
    '- Use restrained transition overlays between AI-generated shots.',
    '- Preserve clip timing exactly from saga.json.',
    '- Keep all motion seek-driven — no setTimeout, no Date.now, no Math.random.',
    '',
    "Don't:",
    '- Add readable subtitles unless the user asked for captions.',
    '- Cover the generated subject with heavy graphics.',
    '- Change the story order of the generated segments.',
    '',
  ].join('\n');

  const manifest = {
    schema: 'artemis-saga.composition.v1',
    projectId: input.composition.projectId,
    ratio: input.composition.ratio,
    width: input.composition.width,
    height: input.composition.height,
    fps: input.composition.fps,
    duration: total,
    generatedBy: 'Artemis Saga',
    tracks: { video: 0, audio: 1, transitions: 2, finishing: 3 },
    transitions: input.composition.transitions,
    segments: input.segments.map((segment, idx) => ({
      index: segment.index,
      title: segment.title,
      duration: segment.duration,
      start: totalUpTo(input.segments, idx),
      media: path.relative(dir, segment.mediaPath),
      storyBeat: segment.storyBeat,
      camera: segment.camera,
      continuity: segment.continuity,
      transitionInto: idx === 0 ? null : input.composition.transitions[idx - 1]?.kind ?? null,
    })),
    identityCard: input.composition.identityCard,
    bible: input.composition.bible,
  };

  const readme = [
    '# Saga Composition',
    '',
    'This project is generated by Artemis Saga as an editable finishing timeline.',
    'It uses the Saga renderer pipeline — no external Hyperframes CLI required.',
    '',
    'Useful tooling commands (Artemis CLI):',
    '',
    '```bash',
    'artemis run --action saga_lint --project .',
    'artemis run --action saga_inspect --project .',
    'artemis run --action saga_render --project . --output final.mp4 --quality high',
    '```',
    '',
    'Files:',
    '',
    '- `index.html` — the Saga composition (browser-previewable in any modern browser)',
    '- `design.md` — visual contract',
    '- `saga-runtime.js` — Saga-namespaced runtime (paused gsap timelines + clip visibility)',
    '- `saga.json` — machine-readable production metadata',
    '- `media/segments/*.mp4` — generated video segments',
    '',
    'Composition format is data-attribute compatible with Hyperframes (Apache 2.0; see CREDITS.md).',
    '',
  ].join('\n');

  await writeFile(runtimePath, SAGA_RUNTIME_IIFE, 'utf8');
  await writeFile(htmlPath, html, 'utf8');
  await writeFile(designPath, design, 'utf8');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  await writeFile(readmePath, readme, 'utf8');

  return {
    htmlPath,
    runtimePath,
    designPath,
    manifestPath,
    readmePath,
  };
}

function totalUpTo(segments: SagaSegmentInput[], count: number): number {
  let sum = 0;
  for (let i = 0; i < Math.min(count, segments.length); i += 1) {
    sum += segments[i]!.duration;
  }
  return sum;
}
