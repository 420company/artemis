// Motion design principles distilled from Hyperframes (Apache 2.0) — applied
// as defaults when Saga authors per-clip animation. See CREDITS.md for
// attribution. The rules below come from production experience: compositions
// can lint-clean and still ship broken without these.

export const SAGA_EASES = {
  enter: ['power3.out', 'expo.out', 'back.out(1.4)', 'sine.out'] as const,
  exit: ['power2.in', 'sine.in', 'expo.in'] as const,
  move: ['power2.inOut', 'sine.inOut'] as const,
  ambient: ['sine.inOut', 'none'] as const,
};

export const SAGA_SPEED = {
  fast: { min: 0.15, max: 0.3 },
  medium: { min: 0.3, max: 0.5 },
  slow: { min: 0.5, max: 0.8 },
  cinematic: { min: 0.8, max: 2.0 },
};

export const SAGA_SCENE_PHASES = {
  build: [0, 0.3] as const,
  breathe: [0.3, 0.7] as const,
  resolve: [0.7, 1.0] as const,
};

// Hard rules the linter / authoring helpers enforce.
export const SAGA_RULES = {
  // No iframes — capture engine cannot scrub inside them.
  noIframes: true,
  // Prefer fromTo over from inside .clip scenes (immediateRender hazard).
  preferFromTo: true,
  // Never stack two transform tweens on the same element.
  singleTransformPerElement: true,
  // Hard-kill exits with tl.set(opacity:0, visibility:hidden).
  hardKillExits: true,
  // Ambient pulses must attach to seekable timeline, not bare gsap.to.
  ambientOnTimeline: true,
  // No Date.now / Math.random / network fetches in compositions.
  determinismRequired: true,
  // Image elements should ship with motion treatment (Ken Burns / tilt / etc).
  imagesNeedMotion: true,
};

export type SagaSpeedClass = keyof typeof SAGA_SPEED;

export function pickEntranceEase(seed: number): string {
  return SAGA_EASES.enter[seed % SAGA_EASES.enter.length] ?? 'power3.out';
}

export function pickExitEase(seed: number): string {
  return SAGA_EASES.exit[seed % SAGA_EASES.exit.length] ?? 'power2.in';
}

export function speedRange(speed: SagaSpeedClass): { min: number; max: number } {
  return SAGA_SPEED[speed];
}

// Authoring helpers for downstream Saga skills that build per-shot
// finishing animations. They are intentionally simple — the value is the
// principle they enforce, not the cleverness of the helper.

export function entranceTween(
  selector: string,
  startSeconds: number,
  options?: { from?: 'left' | 'right' | 'top' | 'bottom' | 'scale' | 'opacity'; speed?: SagaSpeedClass; ease?: string },
): string {
  const speed = options?.speed ?? 'medium';
  const { min, max } = speedRange(speed);
  const duration = (min + max) / 2;
  const ease = options?.ease ?? 'power3.out';
  const fromState = (() => {
    switch (options?.from) {
      case 'left':
        return '{ opacity: 0, x: -80 }';
      case 'right':
        return '{ opacity: 0, x: 80 }';
      case 'top':
        return '{ opacity: 0, y: -60 }';
      case 'bottom':
        return '{ opacity: 0, y: 60 }';
      case 'scale':
        return '{ opacity: 0, scale: 0.92 }';
      default:
        return '{ opacity: 0 }';
    }
  })();
  const toState = `{ opacity: 1, x: 0, y: 0, scale: 1, duration: ${duration.toFixed(2)}, ease: ${JSON.stringify(ease)} }`;
  return `tl.fromTo(${JSON.stringify(selector)}, ${fromState}, ${toState}, ${startSeconds.toFixed(2)});`;
}

export function exitTween(
  selector: string,
  startSeconds: number,
  options?: { speed?: SagaSpeedClass; ease?: string },
): string[] {
  const speed = options?.speed ?? 'fast';
  const { min, max } = speedRange(speed);
  const duration = (min + max) / 2;
  const ease = options?.ease ?? 'power2.in';
  return [
    `tl.to(${JSON.stringify(selector)}, { opacity: 0, duration: ${duration.toFixed(2)}, ease: ${JSON.stringify(ease)} }, ${startSeconds.toFixed(2)});`,
    `tl.set(${JSON.stringify(selector)}, { opacity: 0, visibility: "hidden" }, ${(startSeconds + duration).toFixed(2)});`,
  ];
}

export function ambientFloat(selector: string, startSeconds: number, durationSeconds: number): string {
  const cycles = Math.max(2, Math.floor(durationSeconds / 1.6));
  return `tl.to(${JSON.stringify(selector)}, { y: -8, yoyo: true, repeat: ${cycles}, duration: ${(durationSeconds / (cycles * 2)).toFixed(2)}, ease: "sine.inOut" }, ${startSeconds.toFixed(2)});`;
}
