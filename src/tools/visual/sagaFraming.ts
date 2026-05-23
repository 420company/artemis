// Extracts an OPENING FRAMING directive for the per-segment keyframe.
//
// Why this exists:
// The per-segment storyBeat is often generic boilerplate ("the protagonist
// steps through the scene with a deliberate weight shift...") — it carries
// no information about where the subject is positioned in the frame, which
// way the body faces, or which direction the subject is moving. The original
// user brief usually says all of this in the source story bible, but those
// cues get buried among 16+ continuity rules where Image-2 deprioritises
// them. The result is non-deterministic keyframes: the same prompt can give
// a left-facing subject one run and a right-facing subject the next, and
// the downstream video animator inherits whichever the keyframe happened to
// pick (often producing "walking backwards" when the keyframe direction
// contradicts the brief's intent).
//
// Two-stage extractor:
// 1. Regex over the storyBeat + source story for explicit Chinese / English
//    framing cues (frame edge %, profile / front-on / back-to-camera, body
//    facing left/right, walking direction, camera framing). Cheap and
//    deterministic — covers the common cases the user actually writes.
// 2. If regex returned nothing useful, fall back to an LLM call (caller
//    supplies the chat model so this module stays sync-friendly). The LLM
//    is asked to extract the same structured cues from the storyBeat and
//    return them in the same flat format.
//
// Output is a multi-line block ready to splice into the Image-2 keyframe
// prompt directly under the IDENTITY LOCK section, where it gets the
// highest attention weight in the prompt window.

type FramingArgs = {
  storyBeat: string;
  sourceStory?: string;
  // 0-based or 1-based segment index — only used for cumulative cue lookup
  // in the source story (e.g. "前 32 秒她从画面左边走到中央" implies that
  // segment index 0 should be at the left edge and segment index 4 should
  // be at the centre). Caller is expected to pass the same indexing it
  // uses elsewhere; we treat it purely as a number, no math.
  shotIndex: number;
  shotCount: number;
};

export type FramingDirective = {
  // Free-form English directive line, one per cue (so the formatter can
  // bullet-list them cleanly into the keyframe prompt).
  text: string;
  // Internal tag used so the smoke test can assert WHICH cues were picked
  // up by the regex layer without depending on the exact phrasing.
  kind:
    | 'horizontal-position'
    | 'body-orientation'
    | 'motion-direction'
    | 'camera-framing'
    | 'camera-motion';
};

const HEADER_ZH = '🎯 OPENING FRAMING (highest priority — opening keyframe must obey these positional / directional rules):';

// Scope the source story to the slice that actually belongs to the current
// segment, so cues from a later segment (e.g. segment 5's "正面朝镜头 / 极近
// 特写") do not bleed back and override segment 1-4's intended "侧面 / 中景
// 全身". We split on whichever per-segment marker the brief uses ([N-M秒],
// Scene N, 段 N, Shot N, Segment N) and return the slice from the Nth marker
// to the (N+1)th — N = shotIndex. If the brief has fewer markers than
// segments, the slice extraction degrades gracefully to the full story.
function extractSegmentSlice(story: string, shotIndex: number): string | undefined {
  if (!story || shotIndex < 1) return undefined;
  // Try bracket time markers first — they are the strongest segmentation
  // signal in saga briefs ("[0-8秒] / [8-16秒]" etc).
  const bracketRe = /\[\s*\d+(?::\d{2})?\s*[-–—~至到]\s*\d+(?::\d{2})?\s*(?:秒|s|sec|seconds)?\s*\]/g;
  let markers: Array<{ index: number }> = [];
  for (const match of story.matchAll(bracketRe)) {
    if (typeof match.index === 'number') markers.push({ index: match.index });
  }
  // Fall back to structural scene markers ("Scene 1 / 段 1 / 镜头 1 / 第 1 段")
  // ONLY when the brief lacks bracket markers. Mixing both pollutes the
  // segment boundary count and shreds each segment's slice into useless
  // fragments (a "[0-8秒] 段 1 · 东亚四连穿越" line would otherwise yield two
  // markers two characters apart).
  if (markers.length < 2) {
    const sceneRe = /(?:(?:scene|shot|segment)\s*#?\d+)|(?:(?:镜头|段)\s*\d+(?!\s*秒))|(?:第\s*\d+\s*段)/gi;
    markers = [];
    for (const match of story.matchAll(sceneRe)) {
      if (typeof match.index === 'number') markers.push({ index: match.index });
    }
  }
  if (markers.length < 2) return undefined;
  const idx = shotIndex - 1;
  if (idx < 0 || idx >= markers.length) return undefined;
  const start = markers[idx]!.index;
  const end = idx + 1 < markers.length ? markers[idx + 1]!.index : story.length;
  return story.slice(start, end);
}

function pickCombinedText(args: FramingArgs): string {
  const beat = args.storyBeat ?? '';
  const story = args.sourceStory ?? '';
  // storyBeat is always segment-specific (planner-extracted), so it goes
  // first. Source story falls back to a per-segment slice when one can be
  // recovered from the brief's own time markers; otherwise we use the full
  // story (legacy behaviour) so single-marker briefs still get cues.
  const scopedStory = extractSegmentSlice(story, args.shotIndex) ?? story;
  return `${beat}\n${scopedStory}`;
}

function extractHorizontalPosition(text: string): FramingDirective | undefined {
  // Highest priority: explicit "from left edge X%" or "在画面 X%".
  const leftEdge = text.match(/(?:画面)?(?:左|left)\s*(?:边缘|edge)?\s*[~约约]?\s*(\d{1,3})\s*%/);
  if (leftEdge) {
    const pct = Number(leftEdge[1]);
    if (pct >= 0 && pct <= 100) {
      return {
        kind: 'horizontal-position',
        text: `Subject horizontal position in frame: LEFT ~${pct}% (positioned near the left edge, NOT centred).`,
      };
    }
  }
  const rightEdge = text.match(/(?:画面)?(?:右|right)\s*(?:边缘|edge)?\s*[~约约]?\s*(\d{1,3})\s*%/);
  if (rightEdge) {
    const pct = Number(rightEdge[1]);
    if (pct >= 0 && pct <= 100) {
      return {
        kind: 'horizontal-position',
        text: `Subject horizontal position in frame: RIGHT ~${pct}% (positioned near the right edge, NOT centred).`,
      };
    }
  }
  // Generic "在画面 X% 位置 / X% horizontal".
  const generic = text.match(/(?:画面|frame)\s*[~约约]?\s*(\d{1,3})\s*%/);
  if (generic) {
    const pct = Number(generic[1]);
    if (pct >= 0 && pct <= 100) {
      const side = pct < 40 ? 'LEFT' : pct > 60 ? 'RIGHT' : 'CENTRE';
      return {
        kind: 'horizontal-position',
        text: `Subject horizontal position in frame: ~${pct}% from left (${side}).`,
      };
    }
  }
  if (/画面中央|画面中间|center(?:ed)? in (?:the )?frame|frame center/i.test(text)) {
    return {
      kind: 'horizontal-position',
      text: 'Subject horizontal position in frame: CENTRED (≈ 50% horizontal).',
    };
  }
  return undefined;
}

function extractBodyOrientation(text: string): FramingDirective | undefined {
  // Back to camera takes priority over side / front because users often
  // describe both "侧背影" and "侧面" in the same brief; "背影" wins because
  // it's the more constrained pose.
  if (/背\s*对\s*镜头|背\s*向\s*镜头|背影|back\s*to\s*camera|facing\s*away/i.test(text)) {
    return {
      kind: 'body-orientation',
      text: 'Body orientation: BACK to camera (subject\'s back is visible, face hidden from camera).',
    };
  }
  if (/3\s*\/?\s*4\s*侧背|3\s*\/?\s*4\s*back|three[-\s]?quarter\s*back/i.test(text)) {
    return {
      kind: 'body-orientation',
      text: 'Body orientation: 3/4 back view (subject angled slightly away from camera, partial profile visible).',
    };
  }
  if (/正面朝镜头|正面朝向镜头|面朝镜头|facing\s*(?:the\s*)?camera|front[-\s]?facing/i.test(text)) {
    return {
      kind: 'body-orientation',
      text: 'Body orientation: FRONT toward camera (face fully visible).',
    };
  }
  if (/侧面|profile|side\s*(?:angle|view)/i.test(text)) {
    return {
      kind: 'body-orientation',
      text: 'Body orientation: PROFILE (subject in strict side view, body perpendicular to the camera axis).',
    };
  }
  return undefined;
}

function extractMotionDirection(text: string): FramingDirective | undefined {
  // Horizontal vectors take priority over "walk toward camera" because they
  // constrain the body axis more strictly. If a brief mixes both (e.g. the
  // protagonist drifts rightward for the first four segments then turns and
  // walks toward the camera in the fifth), the rightward / leftward cue is
  // almost always the one that applies to the opening keyframe; "toward
  // camera" is a late-segment behaviour that should be a fallback only when
  // no horizontal vector is written anywhere.
  // Allow up to 20 chars of parenthetical asides between the direction noun
  // and the motion verb so phrasings like "向画面右侧（中心方向）走" still match.
  // The brief frequently inserts inline annotations there.
  if (/向\s*(?:画面)?\s*右(?:侧|边)?[^\n。]{0,20}(?:走|移动|前进|迈步)|moving\s*right(?:ward)?|drift(?:ing)?\s*right/i.test(text)) {
    return {
      kind: 'motion-direction',
      text: 'Motion vector: mid-stride moving RIGHTWARD across the frame (right shoulder leads).',
    };
  }
  if (/向\s*(?:画面)?\s*左(?:侧|边)?[^\n。]{0,20}(?:走|移动|前进|迈步)|moving\s*left(?:ward)?|drift(?:ing)?\s*left/i.test(text)) {
    return {
      kind: 'motion-direction',
      text: 'Motion vector: mid-stride moving LEFTWARD across the frame (left shoulder leads).',
    };
  }
  if (/朝\s*镜头\s*(?:走|来|靠近|前进)|向\s*镜头\s*(?:走|来|靠近|前进)|walk(?:ing)?\s*(?:toward|towards|into)\s*(?:the\s*)?camera/i.test(text)) {
    return {
      kind: 'motion-direction',
      text: 'Motion vector: walking TOWARD the camera (closing the distance, frame size growing).',
    };
  }
  return undefined;
}

function extractCameraFraming(text: string): FramingDirective | undefined {
  if (/极近(?:半身|脸部)?(?:特写|镜头)|extreme close[-\s]?up|ECU/i.test(text)) {
    return {
      kind: 'camera-framing',
      text: 'Shot size: EXTREME close-up (head / upper-torso fills the frame).',
    };
  }
  if (/特写|close[-\s]?up\b/i.test(text)) {
    return {
      kind: 'camera-framing',
      text: 'Shot size: close-up (head and shoulders dominate the frame).',
    };
  }
  if (/中景全身|medium\s*wide|medium\s*long\s*shot/i.test(text)) {
    return {
      kind: 'camera-framing',
      text: 'Shot size: medium wide / full-body (subject occupies ~70% of frame height).',
    };
  }
  if (/中景|medium\s*shot/i.test(text)) {
    return {
      kind: 'camera-framing',
      text: 'Shot size: medium shot (subject from roughly the waist up).',
    };
  }
  if (/大远景|wide\s*shot|long\s*shot|far\s*shot/i.test(text)) {
    return {
      kind: 'camera-framing',
      text: 'Shot size: wide / long shot (subject small in frame, environment dominates).',
    };
  }
  return undefined;
}

function extractCameraMotion(text: string): FramingDirective | undefined {
  if (/锁死(?:三脚架)?(?:机位)?|locked[-\s]?off\s*(?:tripod)?|no\s*camera\s*movement|tripod\s*locked/i.test(text)) {
    return {
      kind: 'camera-motion',
      text: 'Camera: locked-off tripod (no pan, tilt, zoom, dolly, or handheld shake — the subject moves, the camera does not).',
    };
  }
  if (/dolly[-\s]?in|推进|推镜/i.test(text)) {
    return {
      kind: 'camera-motion',
      text: 'Camera: slow dolly-in (camera pushes toward subject; pose must read as mid-motion toward the lens).',
    };
  }
  return undefined;
}

export function extractOpeningFramingRegex(args: FramingArgs): FramingDirective[] {
  const text = pickCombinedText(args);
  const directives: FramingDirective[] = [];
  const seen = new Set<FramingDirective['kind']>();
  for (const probe of [extractHorizontalPosition, extractBodyOrientation, extractMotionDirection, extractCameraFraming, extractCameraMotion]) {
    const cue = probe(text);
    if (cue && !seen.has(cue.kind)) {
      seen.add(cue.kind);
      directives.push(cue);
    }
  }
  return directives;
}

export function formatOpeningFramingBlock(directives: FramingDirective[]): string | undefined {
  if (directives.length === 0) return undefined;
  return [
    HEADER_ZH,
    ...directives.map((directive) => `  · ${directive.text}`),
    '  · These positional / directional cues are the SINGLE most important rule for this opening keyframe. They override any conflicting hint in the broader continuity rules below.',
  ].join('\n');
}

// Optional LLM-backed fallback. Called by the caller only when the regex
// layer returned no directives AND the caller chose to spend an extra LLM
// round trip to recover. Kept here so the prompt template and the JSON
// schema stay close to the regex extractor it complements.
const FRAMING_LLM_SYSTEM_PROMPT = `You extract opening-keyframe framing cues from a long-form video brief.
Return JSON only: {"directives": [{"kind":"...", "text":"..."}]}.
Valid kinds: "horizontal-position", "body-orientation", "motion-direction", "camera-framing", "camera-motion".
For each cue you actually find in the brief, emit ONE directive. Do not invent.
"text" must be a SINGLE plain-English sentence Image-2 can act on, e.g.:
  - "Subject horizontal position in frame: LEFT ~5%."
  - "Body orientation: PROFILE facing RIGHT (right shoulder closer to camera-right edge)."
  - "Motion vector: mid-stride moving RIGHTWARD across the frame."
  - "Shot size: medium wide / full body."
  - "Camera: locked-off tripod, no camera movement."
If a kind has no evidence in the brief, omit it. Empty array if nothing applies.`;

export async function extractOpeningFramingWithLlm(
  args: FramingArgs,
  chat: { apiKey: string; baseUrl: string; model: string },
): Promise<FramingDirective[]> {
  const body = {
    model: chat.model,
    messages: [
      { role: 'system', content: FRAMING_LLM_SYSTEM_PROMPT },
      {
        role: 'user',
        content: JSON.stringify(
          {
            shotIndex: args.shotIndex,
            shotCount: args.shotCount,
            storyBeat: args.storyBeat,
            sourceStory: args.sourceStory?.slice(0, 6000),
          },
          null,
          2,
        ),
      },
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' },
    max_tokens: 600,
  };
  try {
    const res = await fetch(chat.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${chat.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) return [];
    const raw = await res.text();
    const parsed = JSON.parse(raw) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return [];
    let payload: any;
    try {
      payload = JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) return [];
      payload = JSON.parse(match[0]);
    }
    const list = Array.isArray(payload?.directives) ? payload.directives : [];
    const valid: FramingDirective[] = [];
    const validKinds = new Set<FramingDirective['kind']>([
      'horizontal-position',
      'body-orientation',
      'motion-direction',
      'camera-framing',
      'camera-motion',
    ]);
    for (const entry of list) {
      const kind = entry?.kind;
      const text = typeof entry?.text === 'string' ? entry.text.trim() : '';
      if (validKinds.has(kind) && text.length > 0 && text.length < 240) {
        valid.push({ kind, text });
      }
    }
    return valid;
  } catch {
    return [];
  }
}

export async function extractOpeningFraming(
  args: FramingArgs,
  llmFallback?: { chat: { apiKey: string; baseUrl: string; model: string } },
): Promise<string | undefined> {
  const regexDirectives = extractOpeningFramingRegex(args);
  if (regexDirectives.length >= 2) return formatOpeningFramingBlock(regexDirectives);
  if (!llmFallback) {
    return formatOpeningFramingBlock(regexDirectives);
  }
  const llmDirectives = await extractOpeningFramingWithLlm(args, llmFallback.chat);
  // Merge: prefer regex for kinds it already covered (regex is deterministic
  // and grounded in literal user phrasing), use LLM for everything else.
  const out: FramingDirective[] = [...regexDirectives];
  const haveKinds = new Set(regexDirectives.map((directive) => directive.kind));
  for (const directive of llmDirectives) {
    if (!haveKinds.has(directive.kind)) {
      haveKinds.add(directive.kind);
      out.push(directive);
    }
  }
  return formatOpeningFramingBlock(out);
}
