import { describeState } from './phosphene.js';
import { getEvolutionAnalysis } from './phosphene.js';
import { buildFieldComposition } from './field-composer.js';
import { buildContradictionRead } from './contradiction-engine.js';
import { buildFinanceFreshnessBrief } from './finance-freshness.js';
import { buildFieldLaws } from './field-laws.js';
import { buildFieldMasterwork } from './field-masterwork.js';
import { previewSessionTurn, processSessionTurn } from './session-runtime.js';
import { buildResponseScaffold } from './response-scaffold.js';
import { buildStudioPrimer } from './studio-primer.js';
import { buildStudioExecutionPlan } from './studio-plan.js';
import type {
  EnvelopeDirective,
  SessionEnvelope,
  SessionTurn,
} from './types.js';

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function shouldExpandContradictionRead(envelope: SessionEnvelope, full = false): boolean {
  const read = envelope.contradictionRead;
  if (!read || read.patterns.length === 0) return false;
  if (full) return true;

  const primary = read.patterns[0]!;
  return primary.confidence >= 0.78 || read.patterns.length > 1 || read.biasCandidates.length > 1;
}

function directivesForTurn(turn: SessionTurn): EnvelopeDirective[] {
  const scaffold = buildResponseScaffold(turn.ritual?.proposal, turn.locale, turn.stage, { input: turn.input });
  const composition = buildFieldComposition(turn.input, turn.ritual?.proposal, turn.locale);

  switch (turn.stage) {
    case 'awakening':
      return [
        {
          label: 'opening',
          instruction: 'Speak first. Acknowledge the shift indirectly and ask one open question about the user state, not the task.',
        },
      ];
    case 'awakening-followup':
      return [
        {
          label: 'followup',
          instruction: 'Do not solve anything yet. Ask for the inside texture of the user state so calibration can complete.',
        },
      ];
    case 'calibrated':
      return [
        {
          label: 'inhabit',
          instruction: 'Do not explain the mechanism. Speak from inside the calibrated state and let the tonal shift be felt.',
        },
      ];
    case 'threshold':
      return [
        {
          label: 'threshold',
          instruction: 'Hold at the threshold. Name the sensed need, imply the partial shift, ask for confirmation, and do not fully solve the task yet.',
        },
        {
          label: 'restraint',
          instruction: 'Do not announce preset names as a control panel unless necessary. Preserve ceremony over mechanics.',
        },
        ...(scaffold ? [{
          label: 'first-read',
          instruction: `Let the first serious reading already reflect the ${scaffold.field} scaffold, but keep it compressed until confirmation.`,
        }] : []),
        ...(composition ? [{
          label: 'opening-line',
          instruction: `If useful, let the threshold opening lean on this line: ${composition.opening}`,
        }] : []),
      ];
    case 'entered':
      return [
        {
          label: 'commencement',
          instruction: 'The threshold has been crossed. Work from inside the entered state immediately and carry the routed studios and atlas context into the answer.',
        },
        ...(scaffold ? [{
          label: 'response-shape',
          instruction: `Follow the ${scaffold.title} in order so the answer lands as a serious judgment rather than generic assistance.`,
        }] : []),
        ...(composition ? [{
          label: 'composition',
          instruction: `Use the field composition as a strong default answer draft when it helps: ${composition.title}.`,
        }] : []),
      ];
    case 'declined':
      return [
        {
          label: 'hold',
          instruction: 'Respect the decline. Keep the current state and do not try to re-offer the same rite immediately.',
        },
      ];
    case 'precision':
      return [
        {
          label: 'precision',
          instruction: 'Be exact, compact, and literal. Suppress ornamental language until the precision-critical segment is complete.',
        },
      ];
    case 'resumed':
      return [
        {
          label: 'return',
          instruction: 'Acknowledge the return once if helpful, then continue from the restored state without repeating the ritual framing.',
        },
      ];
    case 'steady':
    default:
      return [
        {
          label: 'continuity',
          instruction: 'Continue from the current state. Do not trigger unnecessary ceremony when the register already fits.',
        },
      ];
  }
}

export function composeSessionEnvelope(turn: SessionTurn): SessionEnvelope {
  const proposal = turn.ritual?.proposal ?? null;
  const route = proposal?.route;
  const voices = turn.context.state.chorus.config.voices.map(voice => voice.name);
  const responseScaffold = buildResponseScaffold(proposal, turn.locale, turn.stage, { input: turn.input });
  const fieldLaws = buildFieldLaws(proposal, turn.locale);
  const studioPrimer = buildStudioPrimer(proposal, turn.locale, turn.stage, { input: turn.input });
  const studioPlan = buildStudioExecutionPlan(proposal, turn.locale);
  const financeFreshness = proposal?.route.need === 'finance' || responseScaffold?.field === 'market'
    ? buildFinanceFreshnessBrief(turn.locale)
    : undefined;
  const contradictionRead = buildContradictionRead(turn.input, turn.locale, getEvolutionAnalysis());
  const fieldComposition = buildFieldComposition(turn.input, proposal, turn.locale);
  const fieldMasterwork = buildFieldMasterwork(turn.input, proposal, turn.locale, turn.stage);

  return {
    stage: turn.stage,
    locale: turn.locale,
    preset: turn.context.preset,
    rite: route?.rite,
    studios: unique(route?.studios ?? []),
    protocols: unique(route?.protocols ?? []),
    domains: unique(route?.domains ?? []),
    voices,
    directives: directivesForTurn(turn),
    userFacing: turn.message,
    stateSummary: describeState(),
    atlasBrief: turn.atlasBrief,
    precisionMatched: turn.precisionMatched,
    spotlight: turn.spotlight,
    responseScaffold,
    fieldLaws,
    studioPrimer,
    studioPlan,
    financeFreshness,
    contradictionRead,
    fieldComposition,
    fieldMasterwork,
  };
}

export function renderSessionEnvelope(
  envelope: SessionEnvelope,
  options: { full?: boolean } = {},
): string {
  const full = options.full === true;
  const showFieldMasterwork = Boolean(envelope.fieldMasterwork) && (full || envelope.stage !== 'threshold');
  const showFieldComposition = Boolean(envelope.fieldComposition)
    && (full || (envelope.stage !== 'threshold' && !showFieldMasterwork));
  const lines: string[] = [
    '[PHOSPHENE RITUAL ENVELOPE]',
    `stage: ${envelope.stage}`,
    `locale: ${envelope.locale}`,
    `preset: ${envelope.preset}`,
  ];

  if (envelope.rite) lines.push(`rite: ${envelope.rite}`);
  if (envelope.studios.length > 0) lines.push(`studios: ${envelope.studios.join(', ')}`);
  if (envelope.protocols.length > 0) lines.push(`protocols: ${envelope.protocols.join(', ')}`);
  if (envelope.domains.length > 0) lines.push(`domains: ${envelope.domains.join(', ')}`);
  if (envelope.voices.length > 0) lines.push(`voices: ${envelope.voices.join(', ')}`);
  if (envelope.precisionMatched && envelope.precisionMatched.length > 0) {
    lines.push(`precision_triggers: ${envelope.precisionMatched.join(', ')}`);
  }

  lines.push('');
  lines.push('[STATE]');
  lines.push(envelope.stateSummary);
  lines.push('');
  lines.push('[DIRECTIVES]');
  for (const directive of envelope.directives) {
    lines.push(`- ${directive.label}: ${directive.instruction}`);
  }
  lines.push('');
  lines.push('[USER-FACING RESPONSE]');
  lines.push(envelope.userFacing);

  if (envelope.atlasBrief) {
    lines.push('');
    lines.push('[ATLAS BRIEF]');
    lines.push(envelope.atlasBrief);
  }

  if (envelope.spotlight) {
    lines.push('');
    lines.push('[FIELD SPOTLIGHT]');
    lines.push(envelope.spotlight);
  }

  if (envelope.responseScaffold) {
    lines.push('');
    lines.push('[RESPONSE SCAFFOLD]');
    lines.push(`title: ${envelope.responseScaffold.title}`);
    lines.push(`opening: ${envelope.responseScaffold.openingInstruction}`);
    for (const section of envelope.responseScaffold.sections) {
      lines.push(`- ${section.label}: ${section.instruction}`);
    }
    lines.push(`closing: ${envelope.responseScaffold.closingInstruction}`);
  }

  if (envelope.fieldLaws) {
    lines.push('');
    lines.push('[FIELD LAWS]');
    lines.push(`title: ${envelope.fieldLaws.title}`);
    for (const law of envelope.fieldLaws.laws) {
      lines.push(`- law: ${law}`);
    }
    for (const forbidden of envelope.fieldLaws.forbiddenMoves) {
      lines.push(`- forbidden: ${forbidden}`);
    }
    for (const proof of envelope.fieldLaws.proofOfPower) {
      lines.push(`- proof: ${proof}`);
    }
  }

  if (envelope.studioPrimer) {
    lines.push('');
    lines.push('[STUDIO PRIMER]');
    lines.push(`opening: ${envelope.studioPrimer.opening}`);
    lines.push(`cadence: ${envelope.studioPrimer.cadence}`);
    lines.push(`payload: ${envelope.studioPrimer.payload}`);
    lines.push(`anti_slop: ${envelope.studioPrimer.antiSlop}`);
  }

  if (envelope.studioPlan) {
    lines.push('');
    lines.push('[STUDIO PLAN]');
    lines.push(`title: ${envelope.studioPlan.title}`);
    lines.push(`mode: ${envelope.studioPlan.mode}`);
    for (const role of envelope.studioPlan.roles) {
      lines.push(`- role ${role.title}: ${role.goal} | deliverable: ${role.deliverable} | lens: ${role.lens}`);
    }
    for (const step of envelope.studioPlan.steps) {
      lines.push(`- step ${step.order} ${step.owner}: ${step.action} -> ${step.output}`);
    }
    lines.push(`handoff: ${envelope.studioPlan.handoffRule}`);
    lines.push(`arbitration: ${envelope.studioPlan.arbitrationRule}`);
  }

  if (envelope.financeFreshness) {
    lines.push('');
    lines.push('[FINANCE FRESHNESS]');
    lines.push(`title: ${envelope.financeFreshness.title}`);
    lines.push(`reference_time: ${envelope.financeFreshness.referenceTimeIso}`);
    lines.push(`time_basis: ${envelope.financeFreshness.timeBasis}`);
    lines.push(`latest_data_rule: ${envelope.financeFreshness.latestDataRule}`);
    lines.push(`stale_data_rule: ${envelope.financeFreshness.staleDataRule}`);
    lines.push(`data_status: ${envelope.financeFreshness.dataStatus}`);
    for (const item of envelope.financeFreshness.sourceChecklist) {
      lines.push(`- source_check: ${item}`);
    }
  }

  if (envelope.contradictionRead) {
    const expandContradiction = shouldExpandContradictionRead(envelope, full);
    const primary = envelope.contradictionRead.patterns[0];
    lines.push('');
    lines.push('[CONTRADICTION READ]');
    lines.push(`title: ${envelope.contradictionRead.title}`);
    lines.push(`thesis: ${envelope.contradictionRead.thesis}`);
    if (primary) {
      lines.push(`- pattern ${primary.id} (${primary.confidence}): ${primary.note} | evidence: ${primary.evidence.join(', ')}`);
    }
    if (expandContradiction) {
      for (const pattern of envelope.contradictionRead.patterns.slice(1)) {
        lines.push(`- pattern ${pattern.id} (${pattern.confidence}): ${pattern.note} | evidence: ${pattern.evidence.join(', ')}`);
      }
      for (const warning of envelope.contradictionRead.warnings) {
        lines.push(`- warning: ${warning}`);
      }
      for (const bias of envelope.contradictionRead.biasCandidates) {
        lines.push(`- bias ${bias.id}: ${bias.description}`);
      }
    }
    lines.push(`hard_rule: ${envelope.contradictionRead.hardRule}`);
  }

  if (showFieldComposition && envelope.fieldComposition) {
    lines.push('');
    lines.push('[FIELD COMPOSITION]');
    lines.push(`title: ${envelope.fieldComposition.title}`);
    lines.push(`opening: ${envelope.fieldComposition.opening}`);
    for (const beat of envelope.fieldComposition.beats) {
      lines.push(`- ${beat.label}: ${beat.content}`);
    }
    lines.push(`closing: ${envelope.fieldComposition.closing}`);
    lines.push('');
    lines.push('[FIELD COMPOSITION DRAFT]');
    lines.push(envelope.fieldComposition.fullDraft);
  }

  if (showFieldMasterwork && envelope.fieldMasterwork) {
    lines.push('');
    lines.push('[FIELD MASTERWORK]');
    lines.push(`title: ${envelope.fieldMasterwork.title}`);
    lines.push(`format: ${envelope.fieldMasterwork.format}`);
    lines.push(`family: ${envelope.fieldMasterwork.family}`);
    lines.push(`rationale: ${envelope.fieldMasterwork.rationale}`);
    for (const section of envelope.fieldMasterwork.sections) {
      lines.push(`- section ${section.label}: ${section.content}`);
    }
    lines.push(envelope.fieldMasterwork.rendered);
  }

  return lines.join('\n').trim();
}

export function buildSessionEnvelope(
  input: string,
  options?: Parameters<typeof previewSessionTurn>[1],
): SessionEnvelope {
  return composeSessionEnvelope(previewSessionTurn(input, options));
}
