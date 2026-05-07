import type { SagaImageMotionKind } from './types.js';

// Image motion presets — never embed a raw flat image. Every still becomes
// a moving shot through one of these treatments. Concept lifted from the
// Hyperframes motion-principles doc (Apache 2.0; see CREDITS.md).

export type SagaImageMotion = {
  kind: SagaImageMotionKind;
  // FFmpeg `zoompan` filter expression for a still → motion shot, or null if
  // the treatment is HTML/GSAP-only (used inside a Saga composition runtime).
  ffmpegZoompan: ((options: { durationSeconds: number; fps: number; width: number; height: number }) => string) | null;
  // GSAP tween snippet for HTML compositions (used by the runtime adapter).
  gsap: (selector: string, durationSeconds: number) => string;
  notes: string;
};

const safeWH = (w: number, h: number): { w: number; h: number } => ({
  w: Math.max(2, Math.floor(w)),
  h: Math.max(2, Math.floor(h)),
});

export const SAGA_IMAGE_MOTION_CATALOG: Record<SagaImageMotionKind, SagaImageMotion> = {
  none: {
    kind: 'none',
    ffmpegZoompan: null,
    gsap: () => '',
    notes: 'Bare still. Discouraged for video — flat images read as bugs.',
  },
  'ken-burns-in': {
    kind: 'ken-burns-in',
    ffmpegZoompan: ({ durationSeconds, fps, width, height }) => {
      const frames = Math.max(2, Math.round(durationSeconds * fps));
      const { w, h } = safeWH(width, height);
      // zoom from 1.0 to 1.08, hold center.
      return `zoompan=z='min(zoom+0.0015,1.08)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${w}x${h}:fps=${fps}`;
    },
    gsap: (selector, duration) =>
      `tl.fromTo(${JSON.stringify(selector)}, { scale: 1.0 }, { scale: 1.08, duration: ${duration.toFixed(2)}, ease: "none" }, 0);`,
    notes: 'Slow push-in. Default for emotional / portrait stills.',
  },
  'ken-burns-out': {
    kind: 'ken-burns-out',
    ffmpegZoompan: ({ durationSeconds, fps, width, height }) => {
      const frames = Math.max(2, Math.round(durationSeconds * fps));
      const { w, h } = safeWH(width, height);
      // zoom from 1.08 to 1.0.
      return `zoompan=z='if(lte(zoom,1.0),1.08,max(1.0,zoom-0.0015))':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${w}x${h}:fps=${fps}`;
    },
    gsap: (selector, duration) =>
      `tl.fromTo(${JSON.stringify(selector)}, { scale: 1.08 }, { scale: 1.0, duration: ${duration.toFixed(2)}, ease: "none" }, 0);`,
    notes: 'Slow pull-out. Reveals context.',
  },
  'pan-left': {
    kind: 'pan-left',
    ffmpegZoompan: ({ durationSeconds, fps, width, height }) => {
      const frames = Math.max(2, Math.round(durationSeconds * fps));
      const { w, h } = safeWH(width, height);
      return `zoompan=z='1.06':d=${frames}:x='iw - (iw/zoom) - (iw - iw/zoom)*on/${frames}':y='ih/2-(ih/zoom/2)':s=${w}x${h}:fps=${fps}`;
    },
    gsap: (selector, duration) =>
      `tl.fromTo(${JSON.stringify(selector)}, { x: 0 }, { x: -60, duration: ${duration.toFixed(2)}, ease: "none" }, 0);`,
    notes: 'Horizontal pan. Use for landscape / establishing.',
  },
  'pan-right': {
    kind: 'pan-right',
    ffmpegZoompan: ({ durationSeconds, fps, width, height }) => {
      const frames = Math.max(2, Math.round(durationSeconds * fps));
      const { w, h } = safeWH(width, height);
      return `zoompan=z='1.06':d=${frames}:x='(iw - iw/zoom)*on/${frames}':y='ih/2-(ih/zoom/2)':s=${w}x${h}:fps=${fps}`;
    },
    gsap: (selector, duration) =>
      `tl.fromTo(${JSON.stringify(selector)}, { x: 0 }, { x: 60, duration: ${duration.toFixed(2)}, ease: "none" }, 0);`,
    notes: 'Mirror of pan-left.',
  },
  'perspective-tilt': {
    kind: 'perspective-tilt',
    ffmpegZoompan: null, // HTML/GSAP only (perspective is 3D — out of zoompan scope)
    gsap: (selector, duration) =>
      [
        `gsap.set(${JSON.stringify(selector)}, { transformPerspective: 1200, rotationY: -8 });`,
        `tl.fromTo(${JSON.stringify(selector)}, { rotationY: -8 }, { rotationY: -2, duration: ${duration.toFixed(2)}, ease: "sine.inOut" }, 0);`,
      ].join('\n      '),
    notes: 'Adds depth. CSS `transform: perspective(...)` is forbidden — GSAP overwrites it.',
  },
  'parallax-float': {
    kind: 'parallax-float',
    ffmpegZoompan: null,
    gsap: (selector, duration) =>
      `tl.to(${JSON.stringify(selector)}, { y: -16, yoyo: true, repeat: ${Math.max(2, Math.floor(duration / 1.6))}, duration: ${(duration / Math.max(4, Math.floor(duration))).toFixed(2)}, ease: "sine.inOut" }, 0);`,
    notes: 'Gentle float at differential z-depth. Hyperframes calls this "ambient pulse".',
  },
  'scroll-reveal': {
    kind: 'scroll-reveal',
    ffmpegZoompan: ({ durationSeconds, fps, width, height }) => {
      const frames = Math.max(2, Math.round(durationSeconds * fps));
      const { w, h } = safeWH(width, height);
      return `zoompan=z='1.0':d=${frames}:x='0':y='(ih - ih/zoom)*on/${frames}':s=${w}x${h}:fps=${fps}`;
    },
    gsap: (selector, duration) =>
      `tl.fromTo(${JSON.stringify(selector)}, { y: 0 }, { y: -40, duration: ${duration.toFixed(2)}, ease: "none" }, 0);`,
    notes: 'Scroll a tall image vertically. Good for product screens / long captures.',
  },
};

export function describeImageMotion(kind: SagaImageMotionKind): SagaImageMotion {
  return SAGA_IMAGE_MOTION_CATALOG[kind] ?? SAGA_IMAGE_MOTION_CATALOG['ken-burns-in'];
}
