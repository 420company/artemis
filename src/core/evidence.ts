import { truncate } from '../utils/fs.js';
import type {
  EvidenceClaim,
  EvidenceConflict,
  EvidenceConflictReason,
  EvidenceEdgeType,
  EvidenceGraph,
  SessionRecord,
} from './types.js';

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, maxChars: number): string {
  return truncate(normalizeWhitespace(text), maxChars);
}

const NEGATION_TOKENS = new Set([
  'not',
  'no',
  'never',
  'cannot',
  'cant',
  'without',
  'isnt',
  'arent',
  'wasnt',
  'werent',
  'shouldnt',
  'dont',
  'doesnt',
  'didnt',
  'wont',
  'couldnt',
  'wouldnt',
]);

function rankClaim(claim: EvidenceClaim): number {
  const kindWeight = {
    decision: 5,
    result: 4,
    risk: 3,
    fact: 2,
    proposal: 1,
  }[claim.kind];
  const statusWeight = {
    refuted: 4,
    unverified: 3,
    observed: 2,
    inferred: 1,
  }[claim.status];

  return kindWeight * 10 + statusWeight;
}

function compareClaims(left: EvidenceClaim, right: EvidenceClaim): number {
  const scoreDelta = rankClaim(right) - rankClaim(left);
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  return right.createdAt.localeCompare(left.createdAt);
}

function getClusterKey(claim: EvidenceClaim): string {
  return (
    claim.clusterKey ||
    canonicalizeClaimStatement(claim.statement).toLowerCase()
  );
}

function getClaimTokens(statement: string): string[] {
  return canonicalizeClaimStatement(statement)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function getNegationShape(claim: EvidenceClaim): {
  base: string;
  negated: boolean;
} {
  const tokens = getClaimTokens(claim.statement);
  const negated = tokens.some((token) => NEGATION_TOKENS.has(token));
  const base = tokens
    .filter((token) => !NEGATION_TOKENS.has(token))
    .join(' ');

  return {
    base,
    negated,
  };
}

function buildConflictId(
  leftId: string,
  rightId: string,
  reason: EvidenceConflictReason,
): string {
  const pair = [leftId, rightId].sort().join('::');
  return `${reason}:${pair}`;
}

function compareConflictClaimPair(left: EvidenceClaim, right: EvidenceClaim): number {
  return compareClaims(left, right);
}

function describeConflict(
  left: EvidenceClaim,
  right: EvidenceClaim,
  reason: EvidenceConflictReason,
): string {
  if (reason === 'status_conflict') {
    return `Status conflict: ${left.status} says "${clip(left.statement, 90)}", while ${right.status} says "${clip(right.statement, 90)}".`;
  }

  return `Negation conflict between "${clip(left.statement, 100)}" and "${clip(right.statement, 100)}".`;
}

function describeClaim(
  graph: EvidenceGraph,
  claim: EvidenceClaim,
  maxChars: number,
): string {
  const supports = countEdgeTargets(graph, claim.id, 'supports');
  const challenges = countEdgeTargets(graph, claim.id, 'challenges');
  const tags = [`${claim.status}/${claim.kind}`];

  if (supports > 0) {
    tags.push(`supports=${supports}`);
  }

  if (challenges > 0) {
    tags.push(`challenges=${challenges}`);
  }

  return `- [${tags.join(' ')}] ${clip(claim.statement, maxChars)}`;
}

function countEdgeTargets(
  graph: EvidenceGraph,
  claimId: string,
  type: EvidenceEdgeType,
): number {
  return graph.edges.filter(
    (edge) => edge.toClaimId === claimId && edge.type === type,
  ).length;
}

function dedupeClaims(claims: EvidenceClaim[]): EvidenceClaim[] {
  const seen = new Set<string>();
  const deduped: EvidenceClaim[] = [];

  for (const claim of [...claims].sort(compareClaims)) {
    const key = `${getClusterKey(claim)}::${claim.kind}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(claim);
  }

  return deduped;
}

function pickClaims(
  graph: EvidenceGraph,
  predicate: (claim: EvidenceClaim) => boolean,
  limit: number,
): EvidenceClaim[] {
  return dedupeClaims(graph.claims.filter(predicate)).slice(0, limit);
}

function formatEdgeLine(graph: EvidenceGraph, edge: EvidenceGraph['edges'][number]): string | null {
  if (!edge) {
    return null;
  }

  const from = graph.claims.find((claim) => claim.id === edge.fromClaimId);
  const to = graph.claims.find((claim) => claim.id === edge.toClaimId);

  if (!from || !to) {
    return null;
  }

  return `- ${edge.type}: "${clip(from.statement, 80)}" -> "${clip(to.statement, 80)}"`;
}

export function scopeEvidenceGraphForSession(
  graph: EvidenceGraph,
  session: Pick<SessionRecord, 'id' | 'rootSessionId' | 'parentSessionId'>,
): EvidenceGraph {
  const rootSessionId = session.rootSessionId ?? session.id;
  const isRootScope =
    !session.parentSessionId || rootSessionId === session.id;

  if (isRootScope) {
    return graph;
  }

  const allowedClaimIds = new Set(
    graph.claims
      .filter((claim) => claim.sourceSessionId === session.id)
      .map((claim) => claim.id),
  );

  return {
    ...graph,
    claims: graph.claims.filter((claim) => allowedClaimIds.has(claim.id)),
    edges: graph.edges.filter(
      (edge) =>
        allowedClaimIds.has(edge.fromClaimId) &&
        allowedClaimIds.has(edge.toClaimId),
    ),
    conflicts: graph.conflicts.filter((conflict) =>
      conflict.claimIds.every((claimId) => allowedClaimIds.has(claimId)),
    ),
  };
}

export function canonicalizeClaimStatement(text: string): string {
  return normalizeWhitespace(text)
    .replace(/^(proposal|evidence|critique|verdict|risk|decision|result)\s*:\s*/i, '')
    .replace(/^verdict\s+/i, '')
    .trim();
}

export function deriveClaimStatement(
  text: string,
  maxChars = 220,
): string {
  const normalized = canonicalizeClaimStatement(text);
  if (!normalized) {
    return 'Empty claim';
  }

  const firstSentence = normalized.match(/.+?[.!?](\s|$)/)?.[0]?.trim();
  return truncate(firstSentence || normalized, maxChars);
}

export function detectEvidenceConflicts(
  graph: EvidenceGraph,
): EvidenceConflict[] {
  const conflicts: EvidenceConflict[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < graph.claims.length; index += 1) {
    const left = graph.claims[index];

    for (let cursor = index + 1; cursor < graph.claims.length; cursor += 1) {
      const right = graph.claims[cursor];

      if (left.kind !== right.kind) {
        continue;
      }

      let reason: EvidenceConflictReason | undefined;
      const sameCluster = getClusterKey(left) === getClusterKey(right);
      if (
        sameCluster &&
        (left.status === 'refuted' || right.status === 'refuted') &&
        left.status !== right.status
      ) {
        reason = 'status_conflict';
      } else {
        const leftShape = getNegationShape(left);
        const rightShape = getNegationShape(right);
        if (
          leftShape.base.length >= 8 &&
          leftShape.base === rightShape.base &&
          leftShape.negated !== rightShape.negated
        ) {
          reason = 'negation_conflict';
        }
      }

      if (!reason) {
        continue;
      }

      const id = buildConflictId(left.id, right.id, reason);
      if (seen.has(id)) {
        continue;
      }

      seen.add(id);
      const pair = [left, right].sort(compareConflictClaimPair);
      conflicts.push({
        id,
        claimIds: [pair[0].id, pair[1].id],
        reason,
        summary: describeConflict(pair[0], pair[1], reason),
        createdAt:
          pair[0].createdAt > pair[1].createdAt
            ? pair[0].createdAt
            : pair[1].createdAt,
      });
    }
  }

  return conflicts.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function synchronizeEvidenceGraph(graph: EvidenceGraph): {
  graph: EvidenceGraph;
  mutated: boolean;
} {
  const conflicts = detectEvidenceConflicts(graph);
  const previous = Array.isArray(graph.conflicts) ? graph.conflicts : [];
  const changed =
    conflicts.length !== previous.length ||
    conflicts.some((conflict, index) => {
      const current = previous[index];
      return (
        !current ||
        current.id !== conflict.id ||
        current.summary !== conflict.summary ||
        current.reason !== conflict.reason
      );
    });

  return {
    graph: {
      ...graph,
      conflicts,
    },
    mutated: changed,
  };
}

export function buildEvidenceDigest(
  graph: EvidenceGraph,
  maxChars = 1_800,
  mode: 'full' | 'compact' = 'full',
): string {
  if (graph.claims.length === 0) {
    return '';
  }

  const decisions = pickClaims(
    graph,
    (claim) => claim.kind === 'decision' || claim.kind === 'proposal',
    3,
  );
  const results = pickClaims(graph, (claim) => claim.kind === 'result', 2);
  const facts = pickClaims(
    graph,
    (claim) => claim.kind === 'fact' && claim.status === 'observed',
    3,
  );
  const risks = pickClaims(
    graph,
    (claim) =>
      claim.kind === 'risk' &&
      (claim.status === 'unverified' || claim.status === 'refuted'),
    3,
  );
  const lines: string[] = ['Evidence digest'];

  if (mode === 'compact') {
    if (decisions.length > 0 || results.length > 0) {
      lines.push('Recent decisions and results:');
      for (const claim of [...decisions.slice(0, 2), ...results.slice(0, 2)]) {
        lines.push(describeClaim(graph, claim, 120));
      }
    }

    if (risks.length > 0) {
      lines.push('Open risks:');
      for (const claim of risks) {
        lines.push(describeClaim(graph, claim, 120));
      }
    }

    if (graph.conflicts.length > 0) {
      lines.push('Conflicts:');
      for (const conflict of graph.conflicts.slice(0, 1)) {
        lines.push(`- [${conflict.reason}] ${clip(conflict.summary, 120)}`);
      }
    }

    return truncate(lines.join('\n'), maxChars);
  }

  if (decisions.length > 0) {
    lines.push('Decisions and proposals:');
    for (const claim of decisions) {
      lines.push(describeClaim(graph, claim, 140));
    }
  }

  if (facts.length > 0) {
    lines.push('Observed facts:');
    for (const claim of facts) {
      lines.push(describeClaim(graph, claim, 140));
    }
  }

  if (results.length > 0) {
    lines.push('Observed results:');
    for (const claim of results) {
      lines.push(describeClaim(graph, claim, 140));
    }
  }

  if (risks.length > 0) {
    lines.push('Open risks:');
    for (const claim of risks) {
      lines.push(describeClaim(graph, claim, 140));
    }
  }

  const challengeLines = graph.edges
    .filter((edge) => edge.type === 'challenges')
    .slice(0, 2)
    .map((edge) => formatEdgeLine(graph, edge))
    .filter((line): line is string => Boolean(line));

  if (challengeLines.length > 0) {
    lines.push('Key challenges:');
    lines.push(...challengeLines);
  }

  if (graph.conflicts.length > 0) {
    lines.push('Conflicts:');
    for (const conflict of graph.conflicts.slice(0, 2)) {
      lines.push(`- [${conflict.reason}] ${clip(conflict.summary, 150)}`);
    }
  }

  return truncate(lines.join('\n'), maxChars);
}

export function buildVerificationChecklist(
  graph: EvidenceGraph,
  maxItems = 8,
): string {
  if (graph.claims.length === 0) {
    return 'No verification checklist yet. Build evidence first.';
  }

  const claimById = new Map(graph.claims.map((claim) => [claim.id, claim]));
  const items: string[] = [];

  for (const edge of graph.edges.filter((entry) => entry.type === 'challenges')) {
    const risk = claimById.get(edge.fromClaimId);
    const target = claimById.get(edge.toClaimId);
    if (!risk || !target) {
      continue;
    }

    items.push(
      `Resolve challenge: confirm whether "${clip(risk.statement, 120)}" actually blocks "${clip(target.statement, 120)}".`,
    );
  }

  for (const conflict of graph.conflicts.slice(0, 4)) {
    items.push(`Resolve contradiction: ${clip(conflict.summary, 170)}`);
  }

  for (const claim of pickClaims(
    graph,
    (entry) =>
      entry.kind === 'risk' &&
      (entry.status === 'unverified' || entry.status === 'refuted'),
    4,
  )) {
    items.push(`Validate open risk: ${clip(claim.statement, 150)}.`);
  }

  for (const claim of pickClaims(
    graph,
    (entry) => entry.kind === 'decision' || entry.kind === 'proposal',
    3,
  )) {
    const hasObservedSupport = graph.edges.some((edge) => {
      if (edge.toClaimId !== claim.id || edge.type !== 'supports') {
        return false;
      }

      const source = claimById.get(edge.fromClaimId);
      return source?.status === 'observed' || source?.kind === 'result';
    });

    if (!hasObservedSupport) {
      items.push(`Add direct evidence for decision: ${clip(claim.statement, 150)}.`);
    }
  }

  for (const claim of pickClaims(graph, (entry) => entry.kind === 'result', 2)) {
    items.push(`Spot-check delivered outcome: ${clip(claim.statement, 150)}.`);
  }

  const dedupedItems = [...new Set(items)].slice(0, maxItems);

  if (dedupedItems.length === 0) {
    return 'No high-signal verification tasks right now.';
  }

  return [
    `Verification checklist for session ${graph.sessionId}`,
    ...dedupedItems.map((item, index) => `${index + 1}. ${item}`),
  ].join('\n');
}

export function formatEvidenceGraph(graph: EvidenceGraph): string {
  if (graph.claims.length === 0) {
    return 'No evidence claims recorded yet.';
  }

  const claimById = new Map(graph.claims.map((claim) => [claim.id, claim]));
  const lines: string[] = [
    `Evidence graph for session ${graph.sessionId}`,
    `Claims: ${graph.claims.length}`,
    `Edges: ${graph.edges.length}`,
    '',
    'Claims',
  ];

  for (const claim of [...graph.claims].sort(compareClaims)) {
    lines.push(
      `- [${claim.status}/${claim.kind}] ${claim.id} ${clip(claim.statement, 180)} source=${claim.sourceProfile ?? 'unknown'}`,
    );
  }

  if (graph.edges.length > 0) {
    lines.push('');
    lines.push('Edges');
    for (const edge of graph.edges) {
      const from = claimById.get(edge.fromClaimId);
      const to = claimById.get(edge.toClaimId);
      if (!from || !to) {
        lines.push(`- ${edge.type}: ${edge.fromClaimId} -> ${edge.toClaimId}`);
        continue;
      }
      lines.push(
        `- ${edge.type}: "${clip(from.statement, 80)}" -> "${clip(to.statement, 80)}"`,
      );
    }
  }

  if (graph.conflicts.length > 0) {
    lines.push('');
    lines.push('Conflicts');
    for (const conflict of graph.conflicts) {
      lines.push(`- [${conflict.reason}] ${clip(conflict.summary, 180)}`);
    }
  }

  return lines.join('\n');
}

export function formatEvidenceConflicts(graph: EvidenceGraph): string {
  if (graph.conflicts.length === 0) {
    return `No contradictions detected for session ${graph.sessionId}.`;
  }

  return [
    `Conflicts for session ${graph.sessionId}`,
    ...graph.conflicts.map(
      (conflict, index) =>
        `${index + 1}. [${conflict.reason}] ${clip(conflict.summary, 220)}`,
    ),
  ].join('\n');
}
