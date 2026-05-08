// Saga narrative-reasoning layer.
//
// Three-tier protagonist detection:
//   Layer 1 — multimodal LLM extraction (primary path)
//   Layer 2 — user clarification when LLM confidence < 0.7
//   Layer 3 — keyword + image-presence fallback (only if LLM unavailable)
//
// Outputs a structured NarrativeEntities map that drives:
//   · mode-aware Saga Constitution injected into the planner prompt
//   · local pre-flight critic that scans planned shots for violations
//   · self-dialogue LLM rewriter that reuses ONLY user-supplied entities
//   · Saga library learning hook (negative + positive examples)

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveConfiguredVisualProvider } from '../../utils/visualGenerationConfig.js';
import { toolLog, toolWarn } from '../../utils/log.js';

export type ProtagonistType = 'character' | 'product' | 'environment';
export type ProtagonistMode = ProtagonistType | 'mixed' | 'unclear';

export type NarrativeEntities = {
  protagonist: {
    name: string;
    type: ProtagonistType;
    confidence: number;
    evidence: string;
  };
  supportingCharacters: string[];
  props: string[];
  environments: string[];
  relationships: string[];
  actions: string[];
  mode: ProtagonistMode;
  modeRationale: string;
  source: 'llm' | 'user-clarification' | 'keyword-fallback';
};

export type PlannedShotForCritic = {
  index: number;
  title?: string;
  storyBeat?: string;
  visualPrompt?: string;
};

export type ShotViolation = {
  shotIndex: number;
  shotTitle?: string;
  reasons: string[];
};

const NARRATIVE_LIBRARY_FILE = 'generated-media/long-videos/saga-narrative-library.jsonl';

// ─── Layer 1 — multimodal LLM extraction ──────────────────────────────────

const ANALYSIS_SYSTEM_PROMPT = `You are the Saga narrative analyst. The user has described a short video they want to make and may have attached reference image(s). Your task is to extract the narrative skeleton so a downstream cinematic planner can produce shots that respect human storytelling logic.

Output ONE JSON object (no markdown, no commentary, no code fence) with EXACTLY these keys:

{
  "protagonist": {
    "name": "<string — concise name or descriptor of the central subject>",
    "type": "character" | "product" | "environment",
    "confidence": 0.0-1.0,
    "evidence": "<one or two sentences citing exactly what in the input made you confident>"
  },
  "supportingCharacters": [<strings — secondary humans/beings present, may be empty>],
  "props": [<strings — non-protagonist objects mentioned, may be empty>],
  "environments": [<strings — locations / settings, may be empty>],
  "relationships": [<strings — concrete relationships between protagonist and other entities, e.g. "Artemis summons the violet orb">],
  "actions": [<strings — concrete action verbs the protagonist can perform, drawn from user content + reasonable extrapolation>],
  "mode": "character" | "product" | "environment" | "mixed" | "unclear",
  "modeRationale": "<one or two sentences explaining the mode and why>"
}

Rules:
1. "character" type = a living being (human, animal, mascot, anthropomorphic figure) is the central focus.
2. "product" type = a non-living manufactured object is the central focus (e.g. wine glass commercial, watch ad, furniture showcase). Humans appearing in such a video are supportingCharacters, NOT protagonist.
3. "environment" type = a place/atmosphere is the central focus (travel reel, location showcase, weather mood piece). Humans/objects appearing are supporting.
4. "mixed" mode = the user gave roughly equal weight to two categories (e.g. "a woman with her perfume bottle"). Use this when honestly uncertain.
5. "unclear" mode = not enough information.
6. confidence reflects how sure you are about both the protagonist and the mode. If protagonist is obvious but mode is mixed, confidence can still be high.
7. Extract entities ONLY from what the user actually wrote or what appears in the reference image. Do NOT invent entities the user did not mention.
8. relationships and actions are the most important fields for downstream rewriting — be generous and concrete here.

Output the JSON only.`;

type ChatModelInfo = { apiKey: string; baseUrl: string; model: string };

async function resolveChatModel(cwd: string): Promise<ChatModelInfo | null> {
  const imageConfigured = await resolveConfiguredVisualProvider(cwd, 'image');
  const apiKey = imageConfigured?.config.image.apiKey?.trim();
  const baseUrl = imageConfigured?.config.image.baseUrl?.trim();
  if (!apiKey || !baseUrl) return null;
  let model = 'gpt-5.5';
  try {
    const { ProviderStore } = await import('../../providers/store.js');
    const store = await new ProviderStore(cwd).load();
    const main = store?.profiles?.find((p) => p.id === (store?.defaultMainProfileId ?? 'main'));
    if (main?.model) model = main.model;
  } catch {
    // keep fallback
  }
  return { apiKey, baseUrl, model };
}

async function readImageAsDataUrl(filePath: string): Promise<string | null> {
  try {
    const buffer = await readFile(filePath);
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : ext === 'webp' ? 'image/webp'
      : ext === 'gif' ? 'image/gif'
      : 'image/png';
    return `data:${mime};base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  }
}

function clampConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeMode(raw: unknown, type: ProtagonistType): ProtagonistMode {
  if (raw === 'character' || raw === 'product' || raw === 'environment' || raw === 'mixed' || raw === 'unclear') {
    return raw;
  }
  return type;
}

function normalizeType(raw: unknown): ProtagonistType {
  return raw === 'product' || raw === 'environment' ? raw : 'character';
}

export async function analyzeNarrative(options: {
  cwd: string;
  userText: string;
  imagePaths?: string[];
}): Promise<NarrativeEntities | null> {
  const chat = await resolveChatModel(options.cwd);
  if (!chat) return null;

  const userContent: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
    {
      type: 'text',
      text: `User's video brief follows. Apply the rules in the system message and produce the JSON object.\n\n--- USER BRIEF ---\n${options.userText.trim() || '(no text — only reference images supplied)'}\n--- END USER BRIEF ---`,
    },
  ];
  for (const imagePath of options.imagePaths ?? []) {
    const dataUrl = await readImageAsDataUrl(imagePath);
    if (dataUrl) userContent.push({ type: 'image_url', image_url: { url: dataUrl } });
  }

  const url = chat.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: chat.model,
    messages: [
      { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' },
    max_tokens: 1500,
  } as Record<string, unknown>;

  // Up to 3 attempts; transient relay failures shouldn't kill narrative analysis.
  const transientStatuses = new Set([429, 500, 502, 503, 504]);
  let raw = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${chat.apiKey}` },
        body: JSON.stringify(body),
      });
    } catch {
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
        continue;
      }
      return null;
    }
    raw = await res.text();
    if (res.ok) break;
    if (!transientStatuses.has(res.status) || attempt === 3) {
      toolWarn(`⚠️ Saga 叙事分析: LLM ${res.status} — ${raw.slice(0, 160)}`);
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }

  let parsed: { choices?: Array<{ message?: { content?: unknown } }> };
  try { parsed = JSON.parse(raw); } catch { return null; }
  const content = parsed?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return null;

  let analysis: Record<string, unknown>;
  try {
    analysis = JSON.parse(content);
  } catch {
    // Some relays wrap JSON in stray text — extract the first {...} block.
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { analysis = JSON.parse(match[0]); } catch { return null; }
  }

  const protagonistRaw = (analysis.protagonist ?? {}) as Record<string, unknown>;
  const type = normalizeType(protagonistRaw.type);
  const protagonist = {
    name: typeof protagonistRaw.name === 'string' ? protagonistRaw.name.trim() : '(unnamed)',
    type,
    confidence: clampConfidence(protagonistRaw.confidence),
    evidence: typeof protagonistRaw.evidence === 'string' ? protagonistRaw.evidence.trim() : '',
  };

  return {
    protagonist,
    supportingCharacters: asStringArray(analysis.supportingCharacters),
    props: asStringArray(analysis.props),
    environments: asStringArray(analysis.environments),
    relationships: asStringArray(analysis.relationships),
    actions: asStringArray(analysis.actions),
    mode: normalizeMode(analysis.mode, type),
    modeRationale: typeof analysis.modeRationale === 'string' ? analysis.modeRationale.trim() : '',
    source: 'llm',
  };
}

// ─── Layer 3 — keyword + image-presence fallback ──────────────────────────

const PRODUCT_KEYWORDS = /(?:产品(?:视频|宣传|广告|介绍)?|宣传片|广告片|广告视频|商品|带货|开箱|测评|评测|赏析|展示|商务|商业(?:广告)?|商品视频|红酒|腕表|手表|皮具|箱包|家具|护肤|彩妆|香水|耳机|手机|key(?:board)?|laptop|product|commercial|showcase|brand video|advertise(?:ment)?|unboxing)/i;
const CHARACTER_KEYWORDS = /(?:角色|人物|形象|主角|演员|男主|女主|protagonist|character|hero(?:ine)?|model|portrait|cosplay|VTuber|coser|偶像|名人|演员)/i;
const ENVIRONMENT_KEYWORDS = /(?:风景|景色|城市|地标|旅行|旅游|风光|天气|氛围|atmosphere|vibe|landscape|cityscape|skyline|travel|destination|nature)/i;

export function narrativeKeywordFallback(options: {
  userText: string;
  hasFaceLikelyInImages: boolean;
}): NarrativeEntities {
  const text = options.userText;
  const productHit = PRODUCT_KEYWORDS.test(text);
  const characterHit = CHARACTER_KEYWORDS.test(text) || options.hasFaceLikelyInImages;
  const environmentHit = ENVIRONMENT_KEYWORDS.test(text);
  const hits = [characterHit, productHit, environmentHit].filter(Boolean).length;

  let type: ProtagonistType = 'character';
  let mode: ProtagonistMode = 'unclear';
  let evidence = 'fallback heuristic — LLM analysis unavailable';

  if (characterHit && !productHit && !environmentHit) {
    type = 'character';
    mode = 'character';
    evidence = options.hasFaceLikelyInImages
      ? 'reference image likely contains a face'
      : 'user text contains character keywords';
  } else if (productHit && !characterHit && !environmentHit) {
    type = 'product';
    mode = 'product';
    evidence = 'user text contains product/commercial keywords';
  } else if (environmentHit && !characterHit && !productHit) {
    type = 'environment';
    mode = 'environment';
    evidence = 'user text contains environment/landscape keywords';
  } else if (hits >= 2) {
    type = characterHit ? 'character' : productHit ? 'product' : 'environment';
    mode = 'mixed';
    evidence = 'user content references multiple categories';
  }

  return {
    protagonist: {
      name: '(undetermined — fallback)',
      type,
      confidence: 0.4,
      evidence,
    },
    supportingCharacters: [],
    props: [],
    environments: [],
    relationships: [],
    actions: [],
    mode,
    modeRationale: evidence,
    source: 'keyword-fallback',
  };
}

// ─── Constitution (mode-aware) ────────────────────────────────────────────

export function buildSagaConstitution(entities: NarrativeEntities): string {
  const { mode, protagonist } = entities;
  const isCharacter = mode === 'character';
  const isProduct = mode === 'product';
  const isEnvironment = mode === 'environment';

  const protagonistLabel = protagonist.name && protagonist.name !== '(unnamed)'
    ? protagonist.name
    : isProduct ? 'the focal product'
    : isEnvironment ? 'the focal environment'
    : 'the protagonist';

  const lines: string[] = [
    '═══════════════════════════════════════════════════════════════',
    '[Saga Narrative Constitution — MUST OBEY]',
    '═══════════════════════════════════════════════════════════════',
    `Protagonist mode: ${mode.toUpperCase()}`,
    `Protagonist (the "god" of this video): ${protagonistLabel} (type=${protagonist.type}, confidence=${protagonist.confidence.toFixed(2)})`,
  ];

  if (entities.supportingCharacters.length > 0) {
    lines.push(`Supporting characters: ${entities.supportingCharacters.join(', ')}`);
  }
  if (entities.props.length > 0) {
    lines.push(`Available props: ${entities.props.join(', ')}`);
  }
  if (entities.environments.length > 0) {
    lines.push(`Available environments: ${entities.environments.join(', ')}`);
  }
  if (entities.relationships.length > 0) {
    lines.push('Protagonist↔entity relationships (use these as the basis for shots):');
    for (const rel of entities.relationships) lines.push(`  · ${rel}`);
  }
  if (entities.actions.length > 0) {
    lines.push(`Action vocabulary the protagonist can perform: ${entities.actions.join(', ')}`);
  }

  lines.push('', 'RULES (in priority order — break a higher rule and the shot is rejected):');

  if (isCharacter) {
    lines.push(
      `1. PROTAGONIST-AS-GOD — ${protagonistLabel} is the visual center of EVERY shot. The protagonist must be visible and dominant (≥60% of visual interest) in every shot's storyBeat unless the shot is explicitly tagged as an establishing shot.`,
      `2. NO PROP HIJACKING — A non-protagonist object/prop must NOT be the visual subject of two consecutive shots. If shot N centers on a prop close-up, shot N+1 must return to the protagonist using that prop, or move on. Repeated prop close-ups cause viewer fatigue and break protagonist supremacy.`,
      `3. RELATIONSHIP FIDELITY — Every shot's storyBeat must be a concrete instance of one or more relationships from the list above. Do NOT invent relationships not present in the user's content.`,
      `4. ACTION VOCABULARY — Verbs in storyBeat must come from the action vocabulary above (or be reasonable variants). The protagonist DOES things — they do not just stand or get described.`,
    );
  } else if (isProduct) {
    lines.push(
      `1. PRODUCT-AS-GOD — ${protagonistLabel} is the visual center of EVERY shot. The product must remain on-screen and dominant. Humans, hands, environments are supporting elements that frame the product.`,
      `2. NO HUMAN HIJACKING — Supporting characters (e.g. models, hands) must NOT be the visual subject of two consecutive shots without the product being the focus. They exist to showcase the product.`,
      `3. PRODUCT FACET ROTATION — Across shots, vary the product's presented facet: front detail, side angle, in-use shot, environmental context, scale-with-hand, lifestyle vignette. Avoid repeating the same angle/composition twice.`,
      `4. RELATIONSHIP FIDELITY — Use only product↔entity relationships from the list above (or natural extrapolations like "held by hand", "placed on surface"). Do NOT introduce unrelated narrative elements.`,
    );
  } else if (isEnvironment) {
    lines.push(
      `1. ENVIRONMENT-AS-GOD — ${protagonistLabel} is the visual center of EVERY shot. The location/atmosphere must remain readable. Humans/objects appearing should serve to convey scale, texture, or mood of the place.`,
      `2. NO SUBJECT HIJACKING — A single human/object must NOT take over two consecutive shots. They are passers-through, not protagonists.`,
      `3. SPATIAL VARIETY — Across shots, vary the spatial reading: wide establishing → middle texture → intimate detail → wide return. Do not give two shots the same scale/angle.`,
      `4. RELATIONSHIP FIDELITY — Use only relationships and atmospheric details the user supplied or that are natural to the place.`,
    );
  } else {
    lines.push(
      `1. PROTAGONIST PRIMACY — Treat ${protagonistLabel} as the visual anchor. When in doubt, frame the shot around the protagonist.`,
      `2. AVOID FATIGUE — Do not let any single non-protagonist element dominate two consecutive shots.`,
      `3. RELATIONSHIP FIDELITY — Build shots from the user-supplied relationships and actions; do not invent new entities.`,
    );
  }

  lines.push(
    `5. INTER-SHOT HOOK — Every shot N's closing frame must visually hook into shot N+1's opening frame. Hooks are: protagonist gaze direction, action carry-through, light direction continuity, or a transferable element. The "transition" field describes the hook concretely.`,
    `6. NARRATIVE ARC — For an N-shot video, shot 1 establishes ${protagonistLabel}; the middle shots develop tension/exploration; the final shot resolves with a memorable beat. Do not put the strongest beat in the middle.`,
    `7. STORYBEAT FORMAT — Each storyBeat is a TIMELINE of physical actions: "0–Xs: [subject] [verb in present-tense] [object/target]; [environmental motion]. Xs–Ys: [next verb] ... Ys–end: [resolving verb] ...". The subject of MOST timeline beats must be ${protagonistLabel}.`,
    '═══════════════════════════════════════════════════════════════',
  );

  return lines.join('\n');
}

// ─── Pre-flight critic (local, no LLM) ────────────────────────────────────

// Tokenize for both Latin and CJK so the relationship-fidelity check
// works in any language. Latin tokens split on punctuation/whitespace.
// CJK runs are emitted as a 2-character sliding window — a pragmatic
// compromise between single-character bigrams and full word segmentation
// (which would require shipping a tokenizer dictionary). The window lets
// a relationship and a storyBeat match when they share enough character
// pairs, regardless of phrasing.
function tokenize(text: string): string[] {
  if (!text) return [];
  const lowered = text.toLowerCase();
  const out: string[] = [];
  // Latin/digit tokens by punctuation/whitespace split
  for (const part of lowered.split(/[^\p{L}\p{N}]+/gu)) {
    if (!part) continue;
    if (/[一-鿿]/.test(part)) {
      // Emit each 2-char CJK window
      for (let i = 0; i < part.length - 1; i += 1) out.push(part.slice(i, i + 2));
      // Also emit single CJK chars when the run is exactly 1 char
      if (part.length === 1) out.push(part);
    } else if (/[a-z0-9]/.test(part)) {
      out.push(part);
    }
  }
  return out;
}

function entityAppearsIn(entity: string, text: string): boolean {
  if (!entity || !text) return false;
  const lower = text.toLowerCase();
  if (lower.includes(entity.toLowerCase())) return true;
  // CJK fallback: at least 2 of the entity's characters appear in the text
  const cjkChars = entity.match(/[一-鿿]/g) ?? [];
  if (cjkChars.length >= 2) {
    const hits = cjkChars.filter((ch) => lower.includes(ch)).length;
    return hits >= Math.min(cjkChars.length, 2);
  }
  return false;
}

// Pronouns that refer back to the protagonist after the first naming.
// Accepting these in storyBeats lets us write natural prose ("she walks",
// "她穿过") instead of repeating the full name on every line.
const PROTAGONIST_PRONOUNS = ['她', '他', '她们', '他们', 'she', 'her', 'hers', 'he', 'him', 'his'];

function containsProtagonistPronoun(text: string): boolean {
  const lower = text.toLowerCase();
  for (const pronoun of PROTAGONIST_PRONOUNS) {
    // For Latin pronouns ensure word boundary; CJK pronouns can be substring.
    if (/^[a-z]+$/.test(pronoun)) {
      if (new RegExp(`\\b${pronoun}\\b`).test(lower)) return true;
    } else {
      if (lower.includes(pronoun)) return true;
    }
  }
  return false;
}

function dominantSubject(shot: PlannedShotForCritic, entities: NarrativeEntities): {
  protagonistMentions: number;
  propMentions: Map<string, number>;
  supportingMentions: Map<string, number>;
} {
  const beat = `${shot.storyBeat ?? ''}\n${shot.visualPrompt ?? ''}`;
  const lower = beat.toLowerCase();
  const protagonistName = entities.protagonist.name.toLowerCase();
  let protagonistMentions = protagonistName && protagonistName !== '(unnamed)'
    ? (lower.match(new RegExp(protagonistName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length
    : 0;
  // Pronouns count as protagonist mentions (natural prose doesn't repeat the
  // full name on every timeline beat). Also allow the protagonist's name's
  // significant CJK chars (≥2-char run) as a partial match — "饼干姐姐" mentioned
  // anywhere in the beat counts even if name string match fails due to commas.
  if (protagonistMentions === 0 && containsProtagonistPronoun(beat)) {
    protagonistMentions = 1;
  }
  if (protagonistMentions === 0 && protagonistName && entityAppearsIn(entities.protagonist.name, beat)) {
    protagonistMentions = 1;
  }

  const propMentions = new Map<string, number>();
  for (const prop of entities.props) {
    if (entityAppearsIn(prop, beat)) {
      const count = (lower.match(new RegExp(prop.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
      propMentions.set(prop, Math.max(1, count));
    }
  }
  const supportingMentions = new Map<string, number>();
  for (const supporting of entities.supportingCharacters) {
    if (entityAppearsIn(supporting, beat)) {
      supportingMentions.set(supporting, 1);
    }
  }
  return { protagonistMentions, propMentions, supportingMentions };
}

export function runNarrativeCritic(args: {
  shots: PlannedShotForCritic[];
  entities: NarrativeEntities;
}): ShotViolation[] {
  const { shots, entities } = args;
  if (shots.length === 0) return [];
  const mode = entities.mode;
  const violations: ShotViolation[] = [];

  const subjectByShot = shots.map((shot) => dominantSubject(shot, entities));

  for (let i = 0; i < shots.length; i += 1) {
    const shot = shots[i]!;
    const reasons: string[] = [];
    const subj = subjectByShot[i]!;

    // Rule 1: protagonist primacy
    if ((mode === 'character' || mode === 'product' || mode === 'environment') && subj.protagonistMentions === 0) {
      // Allow shot 1 to be a pure establishing shot only for environment mode.
      if (!(mode === 'environment' && i === 0)) {
        reasons.push(`Rule 1 violated: protagonist "${entities.protagonist.name}" not present in storyBeat — ${entities.protagonist.type === 'product' ? 'product must dominate every shot' : 'protagonist must be the visual center'}.`);
      }
    }

    // Rule 2: no consecutive prop hijacking (character / environment) — disabled in product mode for the protagonist itself
    if (i > 0) {
      const prev = subjectByShot[i - 1]!;
      // Find props that dominated both shots (mentioned with no protagonist mention in either)
      for (const [prop, count] of subj.propMentions) {
        const prevCount = prev.propMentions.get(prop) ?? 0;
        if (prevCount > 0 && count > 0) {
          // In character/environment mode, two consecutive prop-heavy shots without protagonist in either is a violation.
          if (mode === 'character' || mode === 'environment') {
            const protagonistInBoth = subj.protagonistMentions > 0 && prev.protagonistMentions > 0;
            if (!protagonistInBoth) {
              reasons.push(`Rule 2 violated: prop "${prop}" appears in shot ${i} and shot ${i + 1} without protagonist mediating — risks prop hijacking.`);
            }
          }
        }
      }
      // In product mode, supporting characters cannot dominate two consecutive shots.
      if (mode === 'product') {
        for (const [name] of subj.supportingMentions) {
          if (prev.supportingMentions.has(name)) {
            reasons.push(`Rule 2 violated: supporting character "${name}" dominates shot ${i} and shot ${i + 1} consecutively without product as visual center.`);
          }
        }
      }
    }

    // Rule 3: relationship fidelity — at least loose match against relationship phrases (skip if no relationships)
    if (entities.relationships.length > 0 && (shot.storyBeat || shot.visualPrompt)) {
      const beat = `${shot.storyBeat ?? ''}\n${shot.visualPrompt ?? ''}`.toLowerCase();
      const matched = entities.relationships.some((rel) => {
        const tokens = tokenize(rel);
        const significant = tokens.filter((token) => token.length >= 2).slice(0, 6);
        if (significant.length === 0) return false;
        const hits = significant.filter((token) => beat.includes(token)).length;
        return hits >= Math.max(1, Math.ceil(significant.length / 3));
      });
      if (!matched) {
        reasons.push(`Rule 3 weak: storyBeat does not match any user-supplied relationship — verify it's drawn from the entity map.`);
      }
    }

    if (reasons.length > 0) {
      violations.push({ shotIndex: shot.index, shotTitle: shot.title, reasons });
    }
  }

  return violations;
}

// ─── Self-dialogue rewriter ───────────────────────────────────────────────

const REWRITE_SYSTEM_PROMPT = `You are the Saga shot rewriter. A shot in a planned video has violated narrative rules. Your job is to propose 3 alternative storyBeats and pick the best, using ONLY the entities/relationships supplied in the context. You must NOT introduce entities the user did not provide.

Output ONE JSON object (no markdown, no commentary):

{
  "alternatives": [
    {
      "storyBeat": "<rewritten timeline storyBeat for this shot>",
      "visualPrompt": "<rewritten visualPrompt aligned with the new storyBeat>",
      "transition": "<concrete closing-frame description that hooks into the next shot>",
      "reasoning": "<one sentence on why this alternative respects the violated rules>"
    },
    ... 3 alternatives total
  ],
  "pick": 0|1|2,
  "pickReason": "<one sentence justifying the pick>"
}

Constraints:
- The protagonist MUST be the subject of most timeline beats in storyBeat.
- Use the protagonist's full name AT MOST ONCE per shot (typically in the first sub-segment). After that, refer with a pronoun ("她", "他", "she", "he", "her", "him") or a short descriptor — never repeat the full name on every timeline beat. Repeated full-name mentions read as awkward boilerplate.
- All nouns (entities) in storyBeat must come from: protagonist, supportingCharacters, props, environments.
- All verbs should come from the action vocabulary or be natural variants.
- Each storyBeat must be a TIMELINE: "0–Xs: ... Xs–Ys: ... Ys–end: ..." with at least 2 sub-segments and concrete physical motion in each.
- The "transition" closing-frame must visually hook into the user's next shot (which is described in the context).`;

export async function rewriteShotWithDialogue(options: {
  cwd: string;
  shotIndex: number;
  shotCount: number;
  shot: PlannedShotForCritic;
  nextShotHint?: PlannedShotForCritic;
  violations: string[];
  entities: NarrativeEntities;
  duration: number;
}): Promise<{ storyBeat: string; visualPrompt: string; transition: string } | null> {
  const chat = await resolveChatModel(options.cwd);
  if (!chat) return null;

  const ctx = {
    shotIndex: options.shotIndex,
    shotCount: options.shotCount,
    duration: options.duration,
    title: options.shot.title,
    currentStoryBeat: options.shot.storyBeat,
    currentVisualPrompt: options.shot.visualPrompt,
    nextShot: options.nextShotHint
      ? { index: options.nextShotHint.index, title: options.nextShotHint.title, storyBeat: options.nextShotHint.storyBeat }
      : null,
    violations: options.violations,
    entities: {
      protagonist: options.entities.protagonist,
      supportingCharacters: options.entities.supportingCharacters,
      props: options.entities.props,
      environments: options.entities.environments,
      relationships: options.entities.relationships,
      actions: options.entities.actions,
      mode: options.entities.mode,
    },
  };

  const url = chat.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: chat.model,
    messages: [
      { role: 'system', content: REWRITE_SYSTEM_PROMPT },
      { role: 'user', content: `Rewrite shot ${options.shotIndex} of ${options.shotCount} (duration ${options.duration}s). Context:\n\n${JSON.stringify(ctx, null, 2)}` },
    ],
    temperature: 0.7,
    response_format: { type: 'json_object' },
    max_tokens: 1200,
  } as Record<string, unknown>;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${chat.apiKey}` },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const raw = await res.text();
  let parsed: { choices?: Array<{ message?: { content?: unknown } }> };
  try { parsed = JSON.parse(raw); } catch { return null; }
  const content = parsed?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return null;

  let result: Record<string, unknown>;
  try { result = JSON.parse(content); } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { result = JSON.parse(match[0]); } catch { return null; }
  }

  const alternatives = Array.isArray(result.alternatives) ? result.alternatives : [];
  const pickIndex = typeof result.pick === 'number' ? result.pick : 0;
  const chosen = alternatives[pickIndex] ?? alternatives[0];
  if (!chosen || typeof chosen !== 'object') return null;
  const c = chosen as Record<string, unknown>;
  const storyBeat = typeof c.storyBeat === 'string' ? c.storyBeat.trim() : '';
  const visualPrompt = typeof c.visualPrompt === 'string' ? c.visualPrompt.trim() : '';
  const transition = typeof c.transition === 'string' ? c.transition.trim() : '';
  if (!storyBeat) return null;
  return { storyBeat, visualPrompt: visualPrompt || storyBeat, transition: transition || `closing frame: ${storyBeat.slice(0, 80)}...` };
}

// ─── Library learning ────────────────────────────────────────────────────

export type NarrativeLibraryEntry = {
  schema: 'artemis-saga.narrative-library.v1';
  recordedAt: string;
  projectId: string;
  protagonistMode: ProtagonistMode;
  protagonistName: string;
  protagonistType: ProtagonistType;
  protagonistConfidence: number;
  totalDuration: number;
  shotCount: number;
  preCriticViolations: ShotViolation[];
  postCriticViolations: ShotViolation[];
  rewroteShotIndices: number[];
  outputVideoPath?: string;
  userFeedback?: { sentiment: 'positive' | 'negative' | 'neutral'; text: string };
};

export async function appendNarrativeLibraryEntry(options: {
  cwd: string;
  entry: NarrativeLibraryEntry;
}): Promise<void> {
  const target = path.join(options.cwd, NARRATIVE_LIBRARY_FILE);
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await appendFile(target, JSON.stringify(options.entry) + '\n', 'utf8');
  } catch (error) {
    toolWarn(`⚠️ Saga 叙事库写入失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function loadRecentLibraryExamples(options: {
  cwd: string;
  protagonistType: ProtagonistType;
  limit?: number;
}): Promise<NarrativeLibraryEntry[]> {
  const target = path.join(options.cwd, NARRATIVE_LIBRARY_FILE);
  try {
    const raw = await readFile(target, 'utf8');
    const entries: NarrativeLibraryEntry[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as NarrativeLibraryEntry;
        if (parsed.protagonistType === options.protagonistType) entries.push(parsed);
      } catch {
        // skip malformed line
      }
    }
    const limit = options.limit ?? 5;
    return entries.slice(-limit);
  } catch {
    return [];
  }
}

// ─── Convenience: status emit ────────────────────────────────────────────

export function emitNarrativeStatus(entities: NarrativeEntities): void {
  const c = (entities.protagonist.confidence * 100).toFixed(0);
  toolLog(`🧠 Saga 叙事分析 (${entities.source}): mode=${entities.mode} · 主角=${entities.protagonist.name}(${entities.protagonist.type}) · 置信度=${c}% · 道具=${entities.props.length} · 关系=${entities.relationships.length} · 动作=${entities.actions.length}`);
}
