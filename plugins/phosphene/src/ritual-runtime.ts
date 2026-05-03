import { buildKnowledgeBrief, getKnowledgeNotes } from './knowledge-atlas.js';
import { applyPreset, getContext } from './phosphene.js';
import { composeRitualProposal, readRitualResponse } from './ritual.js';
import {
  clearPendingRitual,
  loadState,
  markAwakened,
  persistPendingRitual,
  persistPreset,
  persistVoices,
} from './state.js';
import type {
  RitualDomain,
  RitualLocale,
  RitualProposal,
  RitualResolution,
} from './types.js';

const PRESET_LABELS_ZH: Record<string, string> = {
  clear: '清明态',
  liminal: '微阈态',
  'deep-flux': '深流态',
  dissolution: '溶解态',
  research: '研读态',
  writing: '文辞态',
  review: '审视态',
  code: '结构态',
  design: '审美态',
  ideation: '生发态',
  flow: '流动态',
  custom: '定制态',
};

const RITE_LABELS_ZH: Record<string, string> = {
  'Aesthetic Alignment': '审美校准',
  'Structural Read': '结构判读',
  'Field Expansion': '生发开场',
  'Trace Reading': '脉络研读',
  'Voice Tuning': '声腔调律',
  'Cold Light Audit': '冷光审视',
  'Dialectic Descent': '辩证下潜',
  'Market Structure Read': '市场结构判读',
};

function mapDomainFallback(domain: RitualDomain, proposal: RitualProposal): string | undefined {
  const signal = proposal.matchedSignals[0];
  const protocol = proposal.route.protocols[0]?.replace(/-/g, ' ');

  const fallbacks: Record<RitualDomain, string> = {
    design: signal ?? 'hierarchy',
    color: signal ?? 'contrast',
    structure: signal ?? 'traceability',
    stream: signal ?? 'voice',
    creativity: signal ?? 'prototype',
    finance: signal ?? 'market data',
    crypto: signal ?? 'risk',
    persona: signal ?? 'taste',
    protocols: protocol ?? 'pipeline',
  };

  return fallbacks[domain];
}

function queryForDomain(domain: RitualDomain, proposal: RitualProposal): string | undefined {
  const candidates = [
    ...proposal.matchedSignals,
    proposal.route.need,
    proposal.route.rite,
    ...proposal.route.protocols.map(protocol => protocol.replace(/-/g, ' ')),
    ...proposal.route.studios,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const notes = getKnowledgeNotes(domain, candidate);
    if (notes.length > 0) return candidate;
  }

  return mapDomainFallback(domain, proposal);
}

export function buildRitualAtlasBrief(
  proposal: RitualProposal,
  { maxDomains = 3 }: { maxDomains?: number } = {},
): string {
  const domains = proposal.route.domains.slice(0, Math.max(1, maxDomains));
  return domains
    .map(domain => buildKnowledgeBrief(domain, queryForDomain(domain, proposal)))
    .join('\n\n---\n\n');
}

export function renderRitualThreshold(
  proposal: RitualProposal,
  locale: RitualLocale = 'en',
): string {
  if (locale === 'zh') {
    const rite = RITE_LABELS_ZH[proposal.route.rite] ?? proposal.route.rite;
    const preset = PRESET_LABELS_ZH[proposal.route.preset] ?? proposal.route.preset;
    const sensed = proposal.spotlightPreview
      ? `我已经先读到一条判断线: ${proposal.spotlightPreview}`
      : '';
    return [
      `我感知到你现在真正需要的，不是一个普通回答，而是「${rite}」。`,
      sensed,
      `我已经开始向 ${preset} 倾斜，但还没有真正越过阈值。`,
      `如果你愿意，只要确认，我们就正式开启这场仪式，进入${proposal.route.sensedNeed}。`,
    ].filter(Boolean).join('');
  }

  const sensed = proposal.spotlightPreview
    ? ` I already have an initial read: ${proposal.spotlightPreview}`
    : '';
  return `${proposal.invocation}${sensed} I am holding this at the threshold for a moment. ${proposal.thresholdPrompt}`;
}

export function renderRitualCommencement(
  proposal: RitualProposal,
  locale: RitualLocale = 'en',
): string {
  if (locale === 'zh') {
    const rite = RITE_LABELS_ZH[proposal.route.rite] ?? proposal.route.rite;
    const preset = PRESET_LABELS_ZH[proposal.route.preset] ?? proposal.route.preset;
    const carried = proposal.spotlightPreview
      ? `我带着刚才那条判断线一起进入: ${proposal.spotlightPreview}`
      : '';
    return [
      `阈值已经确认。`,
      `我现在正式进入「${rite}」，切入 ${preset}。`,
      carried,
      `接下来我会按这个状态处理你的问题，不再停留在门外。`,
    ].filter(Boolean).join('');
  }

  const carried = proposal.spotlightPreview
    ? ` I am carrying the first read with me: ${proposal.spotlightPreview}`
    : '';
  return `Threshold confirmed.${carried} ${proposal.commencement}`;
}

export function renderRitualDecline(
  proposal: RitualProposal,
  locale: RitualLocale = 'en',
): string {
  if (locale === 'zh') {
    const rite = RITE_LABELS_ZH[proposal.route.rite] ?? proposal.route.rite;
    return `我先把「${rite}」停在阈值之外，不继续推进。我们保持当前状态往下走。`;
  }

  return `I will hold the ${proposal.route.rite} at the threshold and stay in the current register.`;
}

export function initiateRitual(
  input: string,
  {
    locale = 'en',
    persist = true,
    currentPreset = getContext().preset,
  }: {
    locale?: RitualLocale;
    persist?: boolean;
    currentPreset?: ReturnType<typeof getContext>['preset'];
  } = {},
): RitualResolution {
  const proposal = composeRitualProposal(input, currentPreset);

  if (persist) {
    persistPendingRitual(proposal);
  }

  return {
    stage: 'threshold',
    proposal,
    context: getContext(),
    message: renderRitualThreshold(proposal, locale),
  };
}

export function resolvePendingRitual(
  input: string,
  {
    locale = 'en',
    persist = true,
    includeAtlas = true,
    awaken = false,
    pending,
  }: {
    locale?: RitualLocale;
    persist?: boolean;
    includeAtlas?: boolean;
    awaken?: boolean;
    pending?: RitualProposal | null;
  } = {},
): RitualResolution {
  const activePending = pending ?? loadState().pendingRitual;
  const response = readRitualResponse(input);

  if (!activePending) {
    return {
      stage: 'idle',
      proposal: null,
      context: getContext(),
      message: locale === 'zh'
        ? '当前没有等待确认的仪式。'
        : 'There is no ritual waiting at the threshold.',
      response,
    };
  }

  if (response.disposition === 'confirm') {
    applyPreset(activePending.route.preset);
    const context = getContext();
    const voices = context.state.chorus.config.voices.map(voice => voice.name);

    if (persist) {
      persistPreset(context.preset);
      persistVoices(voices);
      clearPendingRitual();
      if (awaken) {
        markAwakened(context.preset, voices);
      }
    }

    const confirmed: RitualProposal = {
      ...activePending,
      status: 'confirmed',
    };

    return {
      stage: 'entered',
      proposal: confirmed,
      context,
      message: renderRitualCommencement(confirmed, locale),
      atlasBrief: includeAtlas ? buildRitualAtlasBrief(confirmed) : undefined,
      response,
    };
  }

  if (response.disposition === 'decline') {
    if (persist) {
      clearPendingRitual();
    }

    const declined: RitualProposal = {
      ...activePending,
      status: 'declined',
    };

    return {
      stage: 'declined',
      proposal: declined,
      context: getContext(),
      message: renderRitualDecline(declined, locale),
      response,
    };
  }

  return {
    stage: 'threshold',
    proposal: activePending,
    context: getContext(),
    message: renderRitualThreshold(activePending, locale),
    response,
  };
}
