// Saga GLSL fragment shaders for video-segment transitions.
//
// Each shader receives:
//   uniform sampler2D uA;       // last frame of segment A (still image)
//   uniform sampler2D uB;       // first frame of segment B (still image)
//   uniform float uProgress;    // 0..1 across the transition window
//   uniform vec2 uResolution;   // canvas pixel dimensions
//   uniform vec3 uAccent;       // optional accent color, RGB 0..1
// And produces gl_FragColor using the standard 0..1 RGB color space —
// no YUV-multiplication artifacts the FFmpeg xfade expression suffers from.
//
// Shaders are kept short and self-contained so they can be embedded in an
// HTML <script type="x-shader/fragment"> tag with no preprocessor.
//
// All shaders are original Saga implementations. See CREDITS.md for the
// inspiration acknowledgement to Hyperframes (Apache 2.0).

const HEADER_GLSL = String.raw`
precision highp float;
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uProgress;
uniform vec2 uResolution;
uniform vec3 uAccent;
varying vec2 vUv;

float saga_smooth(float x) {
  return x * x * (3.0 - 2.0 * x);
}

float saga_bell(float t) {
  return 4.0 * t * (1.0 - t);
}

// Cheap deterministic 2D hash used for noise-based effects.
float saga_hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Bilinear-interpolated value noise built from saga_hash. Returns 0..1.
float saga_value_noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = saga_hash(i);
  float b = saga_hash(i + vec2(1.0, 0.0));
  float c = saga_hash(i + vec2(0.0, 1.0));
  float d = saga_hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// 4-octave fractional Brownian motion. Used for organic warp / smoke /
// burn / morph patterns. Each octave doubles frequency and halves
// amplitude — standard fbm formulation.
float saga_fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * saga_value_noise(p);
    p *= 2.07;
    a *= 0.5;
  }
  return v;
}

// 2D rotation of uv around a pivot by an angle in radians.
vec2 saga_rotate_around(vec2 uv, vec2 pivot, float angle) {
  vec2 d = uv - pivot;
  float c = cos(angle);
  float s = sin(angle);
  return pivot + vec2(c * d.x - s * d.y, s * d.x + c * d.y);
}
`;

// Light-leak — warm cinematic bloom with a horizontal sweep of golden light
// across the midpoint of the transition. Operates in linear RGB so brightness
// is uniform (this is the bug fix vs the FFmpeg xfade-expr light-leak that
// shifted hue toward magenta in YUV).
export const SHADER_LIGHT_LEAK = HEADER_GLSL + String.raw`
void main() {
  float p = uProgress;
  float bell = saga_bell(p);

  vec4 a = texture2D(uA, vUv);
  vec4 b = texture2D(uB, vUv);

  // Soft sine-eased crossfade between the two stills.
  float ease = 0.5 - 0.5 * cos(p * 3.14159265);
  vec3 base = mix(a.rgb, b.rgb, ease);

  // Warm leak streak: a horizontal band that sweeps across the frame.
  float bandY = abs(vUv.y - 0.5);
  float bandX = abs(vUv.x - p);
  float band = exp(-bandX * 6.0) * exp(-bandY * 1.6) * bell;

  // Lens-flare-ish soft circular kiss, brightest at midpoint.
  vec2 toCenter = vUv - vec2(0.5);
  float radial = exp(-dot(toCenter, toCenter) * 6.0) * bell * 0.6;

  vec3 leak = uAccent * (band * 1.4 + radial);

  // Additive bloom in linear-ish RGB. Clamped so we don't blow highlights.
  vec3 outColor = base + leak;
  outColor = min(outColor, vec3(1.0));

  gl_FragColor = vec4(outColor, 1.0);
}
`;

// Whip-pan — horizontal motion blur sweeping in the direction of progress.
// Combines a slide between A and B with a long horizontal streak filter.
export const SHADER_WHIP_PAN = HEADER_GLSL + String.raw`
vec3 hsample(sampler2D tex, vec2 uv, float strength) {
  vec3 sum = vec3(0.0);
  float weights = 0.0;
  const float SAMPLES = 9.0;
  for (float i = 0.0; i < SAMPLES; i += 1.0) {
    float k = (i / (SAMPLES - 1.0)) - 0.5;
    vec2 offset = vec2(k * strength, 0.0);
    vec2 sUv = clamp(uv + offset, vec2(0.001), vec2(0.999));
    float w = 1.0 - abs(k) * 1.4;
    w = max(w, 0.0);
    sum += texture2D(tex, sUv).rgb * w;
    weights += w;
  }
  return sum / max(weights, 0.0001);
}

void main() {
  float p = uProgress;
  float bell = saga_bell(p);

  // The slide: A scrolls off to the left, B comes in from the right.
  vec2 uvA = vec2(vUv.x + p, vUv.y);
  vec2 uvB = vec2(vUv.x - (1.0 - p), vUv.y);

  // Apply horizontal motion blur whose strength peaks at mid-transition.
  float blur = bell * 0.18;

  vec3 colA = hsample(uA, uvA, blur);
  vec3 colB = hsample(uB, uvB, blur);

  // Hard switch at p=0.5 so the eye doesn't see two superimposed layers.
  float t = step(0.5, p);
  vec3 outColor = mix(colA, colB, t);

  // Add a faint warm streak at the seam to read as light scatter.
  float seam = exp(-pow((vUv.x - p) * 8.0, 2.0)) * bell;
  outColor += uAccent * seam * 0.35;

  gl_FragColor = vec4(min(outColor, vec3(1.0)), 1.0);
}
`;

// Glitch — digital block displacement plus RGB channel shift plus scanlines.
// Disruption peaks at midpoint and decays at both ends.
export const SHADER_GLITCH = HEADER_GLSL + String.raw`
void main() {
  float p = uProgress;
  float bell = saga_bell(p);

  // Block size based on vertical position — creates horizontal "tearing"
  // bands rather than a flat noise pattern.
  float bandY = floor(vUv.y * 14.0) / 14.0;
  float jitter = (saga_hash(vec2(bandY, p * 17.0)) - 0.5) * bell * 0.18;

  vec2 uv = vec2(vUv.x + jitter, vUv.y);

  // RGB channel split — peaks at mid-transition.
  float chroma = bell * 0.012;
  vec4 a, b;
  a.r = texture2D(uA, uv + vec2(chroma, 0.0)).r;
  a.g = texture2D(uA, uv).g;
  a.b = texture2D(uA, uv - vec2(chroma, 0.0)).b;
  a.a = 1.0;
  b.r = texture2D(uB, uv + vec2(chroma, 0.0)).r;
  b.g = texture2D(uB, uv).g;
  b.b = texture2D(uB, uv - vec2(chroma, 0.0)).b;
  b.a = 1.0;

  // Sine-eased crossfade between the chroma-split A and B.
  float ease = 0.5 - 0.5 * cos(p * 3.14159265);
  vec3 base = mix(a.rgb, b.rgb, ease);

  // Faint scanline overlay tied to vertical pixel position and progress.
  float scan = sin((vUv.y + p * 0.5) * uResolution.y * 0.6) * 0.5 + 0.5;
  base *= mix(1.0, mix(0.85, 1.0, scan), bell * 0.45);

  // Occasional bright "byte error" specks.
  float speck = step(0.992, saga_hash(vec2(floor(vUv.x * 80.0), floor(vUv.y * 140.0) + p * 50.0)));
  base += vec3(speck) * bell * 0.6;

  gl_FragColor = vec4(min(base, vec3(1.0)), 1.0);
}
`;

// Cinematic zoom — radial zoom blur into A's center then out of B's center,
// with mild chromatic aberration at the edges.
export const SHADER_CINEMATIC_ZOOM = HEADER_GLSL + String.raw`
vec3 zoomBlur(sampler2D tex, vec2 uv, float strength) {
  vec3 sum = vec3(0.0);
  vec2 toCenter = uv - vec2(0.5);
  const float SAMPLES = 10.0;
  for (float i = 0.0; i < SAMPLES; i += 1.0) {
    float k = i / (SAMPLES - 1.0);
    float scale = 1.0 - strength * k;
    vec2 sUv = vec2(0.5) + toCenter * scale;
    sUv = clamp(sUv, vec2(0.001), vec2(0.999));
    sum += texture2D(tex, sUv).rgb;
  }
  return sum / SAMPLES;
}

void main() {
  float p = uProgress;
  float bell = saga_bell(p);

  // Phase: first half zoom INTO A; second half zoom OUT of B.
  float strength = bell * 0.55;
  vec3 colA = zoomBlur(uA, vUv, strength);
  vec3 colB = zoomBlur(uB, vUv, strength);

  // Crossfade with a slightly accelerated curve so B reads sooner.
  float ease = pow(p, 0.7);
  vec3 base = mix(colA, colB, ease);

  // Chromatic aberration at the edges (no shift in the center).
  vec2 toCenter = vUv - vec2(0.5);
  float edge = clamp(length(toCenter) * 1.6, 0.0, 1.0);
  float chroma = bell * edge * 0.012;
  vec3 split;
  split.r = mix(zoomBlur(uA, vUv + vec2(chroma, 0.0), strength).r, zoomBlur(uB, vUv + vec2(chroma, 0.0), strength).r, ease);
  split.g = base.g;
  split.b = mix(zoomBlur(uA, vUv - vec2(chroma, 0.0), strength).b, zoomBlur(uB, vUv - vec2(chroma, 0.0), strength).b, ease);

  vec3 outColor = mix(base, split, edge);

  gl_FragColor = vec4(min(outColor, vec3(1.0)), 1.0);
}
`;

// === 10 more original shaders ===

// Domain warp — fbm-driven organic noise distortion that grows then fades.
// The warp domain is 2D, displacing the sampling UV before crossfading
// between A and B. Edges where displacement is highest get a soft accent
// glow tint. Inspired by the broad "domain warp" effect family.
export const SHADER_DOMAIN_WARP = HEADER_GLSL + String.raw`
void main() {
  float p = uProgress;
  float bell = saga_bell(p);

  // Two-pass domain warp: first noise field q feeds second noise lookup.
  vec2 q = vec2(
    saga_fbm(vUv * 3.0 + vec2(p * 1.7, 0.0)),
    saga_fbm(vUv * 3.0 + vec2(0.0, p * 1.7))
  );
  vec2 r = vec2(
    saga_fbm(vUv * 3.0 + 4.0 * q + vec2(1.7, 9.2)),
    saga_fbm(vUv * 3.0 + 4.0 * q + vec2(8.3, 2.8))
  );
  vec2 displacement = (r - 0.5) * bell * 0.18;

  vec3 a = texture2D(uA, clamp(vUv + displacement, vec2(0.001), vec2(0.999))).rgb;
  vec3 b = texture2D(uB, clamp(vUv + displacement, vec2(0.001), vec2(0.999))).rgb;

  float ease = 0.5 - 0.5 * cos(p * 3.14159265);
  vec3 base = mix(a, b, ease);

  // Edge glow on the displacement field — accent color where warp peaks.
  float edge = pow(length(r - 0.5) * 2.0, 1.6) * bell;
  vec3 glow = uAccent * edge * 0.45;

  gl_FragColor = vec4(min(base + glow, vec3(1.0)), 1.0);
}
`;

// Ridged-burn — high-contrast noise threshold used as a burn mask between
// A and B, with hot accent-colored fringe at the burn edge. Burn radius
// expands with progress.
export const SHADER_RIDGED_BURN = HEADER_GLSL + String.raw`
void main() {
  float p = uProgress;

  // Ridged value noise: 2|n - 0.5| inverts the noise into sharp ridges.
  float n = saga_fbm(vUv * 4.5);
  float ridge = 1.0 - abs(n - 0.5) * 2.0;
  ridge = pow(ridge, 1.4);

  // Threshold sweeps 0 → 1 with p, controlling how much of the frame has
  // burned through to B.
  float burnLine = p;
  float burnDelta = ridge - burnLine + 0.5;
  // soft transition zone around the threshold
  float mask = saga_smooth(clamp(burnDelta * 6.0 + 0.5, 0.0, 1.0));

  vec3 a = texture2D(uA, vUv).rgb;
  vec3 b = texture2D(uB, vUv).rgb;
  vec3 base = mix(b, a, mask);

  // Hot edge: bright accent glow where burn front is propagating right now.
  float edge = exp(-pow(burnDelta * 14.0, 2.0));
  vec3 fire = uAccent * edge * 1.4;

  // Spark specks ahead of the burn line.
  float sp = saga_hash(vec2(floor(vUv.x * 90.0), floor(vUv.y * 160.0) + p * 67.0));
  float sparks = step(0.992, sp) * exp(-pow(burnDelta * 9.0, 2.0));

  gl_FragColor = vec4(min(base + fire + vec3(sparks), vec3(1.0)), 1.0);
}
`;

// SDF iris — circular signed-distance-field iris wipe with a glowing
// accent ring at the boundary, like a camera shutter opening from B to
// fully reveal B (replacing A). Ring brightness peaks during transition.
export const SHADER_SDF_IRIS = HEADER_GLSL + String.raw`
void main() {
  float p = uProgress;

  // Aspect-corrected distance from center.
  vec2 c = (vUv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);
  float dist = length(c);
  float maxDist = length(vec2(uResolution.x / uResolution.y, 1.0)) * 0.5;

  // Iris radius grows from 0 to maxDist*1.05 across the transition.
  float radius = mix(-0.05, maxDist * 1.1, p);

  // Smooth boundary so the iris edge isn't aliased.
  float edge = 0.012;
  float mask = saga_smooth(clamp((radius - dist) / edge + 0.5, 0.0, 1.0));

  vec3 a = texture2D(uA, vUv).rgb;
  vec3 b = texture2D(uB, vUv).rgb;
  vec3 base = mix(a, b, mask);

  // Glowing accent ring at the iris boundary.
  float ringDist = abs(dist - radius);
  float ring = exp(-ringDist * 220.0);
  vec3 ringColor = uAccent * ring * 1.6;

  gl_FragColor = vec4(min(base + ringColor, vec3(1.0)), 1.0);
}
`;

// Ripple-waves — concentric ripple distortion radiating from the center,
// applied to UV before crossfading. Amplitude rises then falls (bell).
export const SHADER_RIPPLE_WAVES = HEADER_GLSL + String.raw`
void main() {
  float p = uProgress;
  float bell = saga_bell(p);

  vec2 c = vUv - 0.5;
  float dist = length(c);
  vec2 dir = dist > 0.0001 ? c / dist : vec2(0.0);

  // Wave displacement — multiple frequency components, phase advancing
  // with p so ripples appear to move outward.
  float wave1 = sin(dist * 38.0 - p * 11.0);
  float wave2 = sin(dist * 22.0 - p * 6.0) * 0.6;
  float amplitude = bell * 0.022;
  vec2 disp = dir * (wave1 + wave2) * amplitude;

  vec2 uvA = clamp(vUv + disp, vec2(0.001), vec2(0.999));
  vec2 uvB = clamp(vUv + disp, vec2(0.001), vec2(0.999));
  vec3 a = texture2D(uA, uvA).rgb;
  vec3 b = texture2D(uB, uvB).rgb;

  float ease = 0.5 - 0.5 * cos(p * 3.14159265);
  vec3 base = mix(a, b, ease);

  // Subtle accent-tinted highlight where wave amplitude is highest.
  float crest = pow(abs(wave1) * bell, 2.0);
  vec3 tint = uAccent * crest * 0.18;

  gl_FragColor = vec4(min(base + tint, vec3(1.0)), 1.0);
}
`;

// Gravitational lens — a pseudo black-hole at center pulls UV inward,
// peaking at midpoint, with chromatic aberration based on distance.
// Standard inverse-distance displacement, common in shader-art warps.
export const SHADER_GRAVITATIONAL_LENS = HEADER_GLSL + String.raw`
void main() {
  float p = uProgress;
  float bell = saga_bell(p);

  vec2 c = vUv - 0.5;
  float dist = length(c) + 0.0001;
  vec2 dir = c / dist;

  // Pull strength: strongest near center, falls off with distance squared.
  float pull = bell * 0.18 / max(dist * dist + 0.05, 0.05);
  vec2 displaced = vUv - dir * pull;

  // Chromatic aberration based on distance from center — simulates a
  // gravitational lens splitting wavelengths.
  float chroma = bell * 0.012 * (0.4 + dist * 1.6);

  // Sample A and B with chromatic offsets per channel.
  vec3 a;
  a.r = texture2D(uA, clamp(displaced + vec2(chroma, 0.0), vec2(0.001), vec2(0.999))).r;
  a.g = texture2D(uA, clamp(displaced, vec2(0.001), vec2(0.999))).g;
  a.b = texture2D(uA, clamp(displaced - vec2(chroma, 0.0), vec2(0.001), vec2(0.999))).b;

  vec3 b;
  b.r = texture2D(uB, clamp(displaced + vec2(chroma, 0.0), vec2(0.001), vec2(0.999))).r;
  b.g = texture2D(uB, clamp(displaced, vec2(0.001), vec2(0.999))).g;
  b.b = texture2D(uB, clamp(displaced - vec2(chroma, 0.0), vec2(0.001), vec2(0.999))).b;

  float ease = 0.5 - 0.5 * cos(p * 3.14159265);
  vec3 base = mix(a, b, ease);

  // Dark halo right at the singularity for "event horizon" feel.
  float horizon = exp(-dist * 28.0) * bell * 0.6;
  base *= 1.0 - horizon;

  gl_FragColor = vec4(min(max(base, vec3(0.0)), vec3(1.0)), 1.0);
}
`;

// Chromatic-split — RGB channels separate radially outward from center
// during the transition, then converge into B. Channel offset is bell-
// curved so the split is most extreme at midpoint.
export const SHADER_CHROMATIC_SPLIT = HEADER_GLSL + String.raw`
void main() {
  float p = uProgress;
  float bell = saga_bell(p);

  vec2 c = vUv - 0.5;
  float dist = length(c);
  vec2 dir = dist > 0.0001 ? c / dist : vec2(0.0);

  float offset = bell * 0.02;

  // Crossfade weight, but each channel reads from a slightly displaced UV.
  float ease = 0.5 - 0.5 * cos(p * 3.14159265);

  vec2 uvR = clamp(vUv + dir * offset, vec2(0.001), vec2(0.999));
  vec2 uvG = vUv;
  vec2 uvB = clamp(vUv - dir * offset, vec2(0.001), vec2(0.999));

  float r = mix(texture2D(uA, uvR).r, texture2D(uB, uvR).r, ease);
  float g = mix(texture2D(uA, uvG).g, texture2D(uB, uvG).g, ease);
  float bChan = mix(texture2D(uA, uvB).b, texture2D(uB, uvB).b, ease);

  vec3 base = vec3(r, g, bChan);

  // Subtle vignette darkening to mask edge sample artifacts.
  float vignette = 1.0 - pow(dist * 1.4, 2.0) * bell * 0.5;
  base *= max(vignette, 0.5);

  gl_FragColor = vec4(min(max(base, vec3(0.0)), vec3(1.0)), 1.0);
}
`;

// Swirl-vortex — UV is rotated around the center by an angle that depends
// on distance, creating a spiraling whirlpool that unwinds into B.
export const SHADER_SWIRL_VORTEX = HEADER_GLSL + String.raw`
void main() {
  float p = uProgress;
  float bell = saga_bell(p);

  vec2 c = vUv - 0.5;
  float dist = length(c);

  // Rotation angle: stronger near center, fades with distance, scales
  // with bell so the swirl winds and unwinds.
  float angle = bell * 5.0 * exp(-dist * 3.5);

  vec2 swirledA = saga_rotate_around(vUv, vec2(0.5), angle);
  vec2 swirledB = saga_rotate_around(vUv, vec2(0.5), angle * -0.6);

  vec3 a = texture2D(uA, clamp(swirledA, vec2(0.001), vec2(0.999))).rgb;
  vec3 b = texture2D(uB, clamp(swirledB, vec2(0.001), vec2(0.999))).rgb;

  float ease = pow(p, 0.85);
  vec3 base = mix(a, b, ease);

  // Faint accent glow at the vortex eye.
  float eye = exp(-dist * 12.0) * bell * 0.5;
  base += uAccent * eye;

  gl_FragColor = vec4(min(base, vec3(1.0)), 1.0);
}
`;

// Thermal-distortion — vertical displacement that drifts upward, tied to
// horizontal position via fbm — reads like heat shimmer. Subtle warm tint.
export const SHADER_THERMAL_DISTORTION = HEADER_GLSL + String.raw`
void main() {
  float p = uProgress;
  float bell = saga_bell(p);

  // Vertical offset noise: drifts upward in time (p advances).
  float n = saga_fbm(vec2(vUv.x * 8.0, vUv.y * 4.0 - p * 2.6));
  float offset = (n - 0.5) * bell * 0.022;

  vec2 uvA = clamp(vec2(vUv.x, vUv.y + offset), vec2(0.001), vec2(0.999));
  vec2 uvB = clamp(vec2(vUv.x, vUv.y + offset), vec2(0.001), vec2(0.999));

  vec3 a = texture2D(uA, uvA).rgb;
  vec3 b = texture2D(uB, uvB).rgb;

  float ease = 0.5 - 0.5 * cos(p * 3.14159265);
  vec3 base = mix(a, b, ease);

  // Subtle warm tint that rises from the bottom of the frame.
  float warm = (1.0 - vUv.y) * bell * 0.18;
  base += uAccent * warm;

  // Slight saturation lift to read as visible heat.
  float gray = dot(base, vec3(0.299, 0.587, 0.114));
  base = mix(vec3(gray), base, 1.0 + bell * 0.15);

  gl_FragColor = vec4(min(max(base, vec3(0.0)), vec3(1.0)), 1.0);
}
`;

// Flash-through-white — sharp triangular peak to white at midpoint, then
// reveal B. Cleaner than the FFmpeg expr-based flash because we operate
// in linear-ish RGB and the white plateau is precisely controlled.
export const SHADER_FLASH_THROUGH_WHITE = HEADER_GLSL + String.raw`
void main() {
  float p = uProgress;

  // Triangular peak: rises to 1.0 at p=0.5, falls back to 0 at p=1.
  // Smoothstep at the rising edge for a soft attack, then steeper fall.
  float rise = saga_smooth(clamp(p / 0.5, 0.0, 1.0));
  float fall = saga_smooth(clamp((1.0 - p) / 0.5, 0.0, 1.0));
  float white = min(rise, fall);
  // Lift the white intensity with a slight pow for snappier peak.
  white = pow(white, 0.7);

  vec3 a = texture2D(uA, vUv).rgb;
  vec3 b = texture2D(uB, vUv).rgb;

  // Switch crossfade fast around midpoint.
  float ease = saga_smooth(clamp((p - 0.4) / 0.2, 0.0, 1.0));
  vec3 base = mix(a, b, ease);

  // Add white toward the peak, with a faint accent rim at peak edges.
  vec3 whiteHit = vec3(white);
  vec3 accentRim = uAccent * white * 0.15;

  gl_FragColor = vec4(min(base + whiteHit + accentRim, vec3(1.0)), 1.0);
}
`;

// Cross-warp-morph — both A and B are sampled at noise-displaced UVs,
// then crossfaded. Reads as if the two scenes are gently morphing into
// each other through a turbulent medium.
export const SHADER_CROSS_WARP_MORPH = HEADER_GLSL + String.raw`
void main() {
  float p = uProgress;
  float bell = saga_bell(p);

  // Two slightly different noise fields displace A and B so the morph
  // looks asymmetric (not just a simple shared warp).
  vec2 disp1 = vec2(
    saga_fbm(vUv * 4.5 + vec2(p * 0.5, 0.0)) - 0.5,
    saga_fbm(vUv * 4.5 + vec2(2.3, p * 0.5)) - 0.5
  ) * bell * 0.06;
  vec2 disp2 = vec2(
    saga_fbm(vUv * 4.5 + vec2(0.0, p * 0.5 + 9.7)) - 0.5,
    saga_fbm(vUv * 4.5 + vec2(p * 0.5 + 7.1, 0.0)) - 0.5
  ) * bell * 0.06;

  vec3 a = texture2D(uA, clamp(vUv + disp1, vec2(0.001), vec2(0.999))).rgb;
  vec3 b = texture2D(uB, clamp(vUv + disp2, vec2(0.001), vec2(0.999))).rgb;

  // Crossfade weighted by a noise field so the morph "eats through" A.
  float n = saga_fbm(vUv * 3.0 + vec2(p * 1.2, 0.0));
  float ease = saga_smooth(clamp((n - 0.5) + (p - 0.5) * 1.6 + 0.5, 0.0, 1.0));

  vec3 base = mix(a, b, ease);

  gl_FragColor = vec4(min(base, vec3(1.0)), 1.0);
}
`;

export type SagaShaderName =
  | 'shader-light-leak'
  | 'shader-whip-pan'
  | 'shader-glitch'
  | 'shader-cinematic-zoom'
  | 'shader-domain-warp'
  | 'shader-ridged-burn'
  | 'shader-sdf-iris'
  | 'shader-ripple-waves'
  | 'shader-gravitational-lens'
  | 'shader-chromatic-split'
  | 'shader-swirl-vortex'
  | 'shader-thermal-distortion'
  | 'shader-flash-through-white'
  | 'shader-cross-warp-morph';

export const SAGA_SHADER_REGISTRY: Record<SagaShaderName, { source: string; defaultDurationMs: number; description: string; intent: 'continuation' | 'energy' | 'disruption' | 'reveal' | 'drift' }> = {
  'shader-light-leak': {
    source: SHADER_LIGHT_LEAK,
    defaultDurationMs: 600,
    description: 'Warm golden light leak with soft horizontal sweep and centre kiss; clean RGB bloom.',
    intent: 'continuation',
  },
  'shader-whip-pan': {
    source: SHADER_WHIP_PAN,
    defaultDurationMs: 350,
    description: 'Horizontal motion-blur slide with a warm seam streak. Modern editing energy.',
    intent: 'energy',
  },
  'shader-glitch': {
    source: SHADER_GLITCH,
    defaultDurationMs: 320,
    description: 'Digital block tear with RGB channel shift, scanlines and byte-error specks.',
    intent: 'disruption',
  },
  'shader-cinematic-zoom': {
    source: SHADER_CINEMATIC_ZOOM,
    defaultDurationMs: 500,
    description: 'Radial zoom blur with edge chromatic aberration; cinematic punch-in feel.',
    intent: 'energy',
  },
  'shader-domain-warp': {
    source: SHADER_DOMAIN_WARP,
    defaultDurationMs: 700,
    description: 'Two-pass fbm domain warp distorts both A and B before crossfading; accent edge glow.',
    intent: 'drift',
  },
  'shader-ridged-burn': {
    source: SHADER_RIDGED_BURN,
    defaultDurationMs: 800,
    description: 'Ridged-noise burn front sweeps across the frame from A to B with hot accent fringe and sparks.',
    intent: 'energy',
  },
  'shader-sdf-iris': {
    source: SHADER_SDF_IRIS,
    defaultDurationMs: 700,
    description: 'Signed-distance-field iris wipe expanding from center, with glowing accent ring at the boundary.',
    intent: 'reveal',
  },
  'shader-ripple-waves': {
    source: SHADER_RIPPLE_WAVES,
    defaultDurationMs: 600,
    description: 'Concentric ripple distortion radiating from center while crossfading.',
    intent: 'drift',
  },
  'shader-gravitational-lens': {
    source: SHADER_GRAVITATIONAL_LENS,
    defaultDurationMs: 800,
    description: 'Pseudo black-hole UV pull at center with chromatic aberration and dark event-horizon halo.',
    intent: 'disruption',
  },
  'shader-chromatic-split': {
    source: SHADER_CHROMATIC_SPLIT,
    defaultDurationMs: 450,
    description: 'RGB channels separate radially during the transition then recombine on B.',
    intent: 'energy',
  },
  'shader-swirl-vortex': {
    source: SHADER_SWIRL_VORTEX,
    defaultDurationMs: 700,
    description: 'Spiral rotation around center, tightest at the eye, unwinding into B.',
    intent: 'drift',
  },
  'shader-thermal-distortion': {
    source: SHADER_THERMAL_DISTORTION,
    defaultDurationMs: 700,
    description: 'Heat-shimmer vertical noise displacement that drifts upward; warm tint rises from the bottom.',
    intent: 'drift',
  },
  'shader-flash-through-white': {
    source: SHADER_FLASH_THROUGH_WHITE,
    defaultDurationMs: 220,
    description: 'Sharp triangular peak to clean white at midpoint then reveals B. RGB-precise flash.',
    intent: 'energy',
  },
  'shader-cross-warp-morph': {
    source: SHADER_CROSS_WARP_MORPH,
    defaultDurationMs: 800,
    description: 'Asymmetric noise warps both A and B and crossfades them through a noise-driven mask.',
    intent: 'drift',
  },
};

export function isSagaShaderName(name: string): name is SagaShaderName {
  return name in SAGA_SHADER_REGISTRY;
}

export function listSagaShaderNames(): SagaShaderName[] {
  return Object.keys(SAGA_SHADER_REGISTRY) as SagaShaderName[];
}
