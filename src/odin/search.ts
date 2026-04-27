import type { OdinSearchHit, OdinSkillRecord } from './types.js';

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function tokenizeOdinText(value: string): string[] {
  const normalized = normalizeText(value);
  return normalized ? normalized.split(/\s+/).filter(Boolean) : [];
}

export function collectOdinSkillSearchText(skill: OdinSkillRecord): string {
  const segments = [
    skill.id,
    skill.name,
    skill.summary ?? '',
    skill.description ?? '',
    ...(skill.tags ?? []),
    skill.lineage?.changeSummary ?? '',
    skill.lineage?.captureQuery ?? '',
  ];

  return segments.filter(Boolean).join(' ');
}

export function scoreOdinSkill(
  skill: OdinSkillRecord,
  query: string,
): OdinSearchHit | undefined {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) {
    return {
      skillId: skill.id,
      score: skill.lastUsedAt ? 1 : 0,
      reasons: ['empty-query'],
      matchedTokens: [],
    };
  }

  const queryTokens = tokenizeOdinText(normalizedQuery);
  const haystack = collectOdinSkillSearchText(skill);
  const haystackNormalized = normalizeText(haystack);
  const haystackTokens = new Set(tokenizeOdinText(haystack));
  const reasons: string[] = [];
  const matchedTokens = new Set<string>();
  let score = 0;

  if (skill.id.toLowerCase() === normalizedQuery) {
    score += 150;
    reasons.push('exact-id');
  }

  if (normalizeText(skill.name) === normalizedQuery) {
    score += 140;
    reasons.push('exact-name');
  } else if (normalizeText(skill.name).startsWith(normalizedQuery)) {
    score += 100;
    reasons.push('name-prefix');
  }

  if (haystackNormalized.includes(normalizedQuery)) {
    score += 40;
    reasons.push('substring');
  }

  for (const token of queryTokens) {
    if (skill.id.toLowerCase().includes(token)) {
      score += 18;
      matchedTokens.add(token);
      reasons.push(`id-token:${token}`);
    }

    if (token === normalizeText(skill.name)) {
      score += 35;
      matchedTokens.add(token);
      reasons.push(`name-token:${token}`);
    }

    if (haystackTokens.has(token)) {
      score += 12;
      matchedTokens.add(token);
      reasons.push(`match:${token}`);
    }
  }

  const overlap = queryTokens.filter((token) => haystackTokens.has(token)).length;
  if (overlap > 0) {
    score += overlap * 10;
    reasons.push(`token-overlap:${overlap}`);
  }

  if (Array.isArray(skill.tags) && skill.tags.length > 0) {
    const tagHits = skill.tags
      .map((tag) => normalizeText(tag))
      .filter((tag) => queryTokens.includes(tag)).length;
    if (tagHits > 0) {
      score += tagHits * 22;
      reasons.push(`tag-match:${tagHits}`);
    }
  }

  if (typeof skill.lastUsedAt === 'string') {
    score += 3;
    reasons.push('recent-use');
  }

  if (typeof skill.confidence === 'number') {
    score += Math.max(0, Math.min(10, skill.confidence)) * 2;
  }

  const safeScore = Math.max(0, Math.round(score));
  if (safeScore === 0) {
    return undefined;
  }

  return {
    skillId: skill.id,
    score: safeScore,
    reasons: Array.from(new Set(reasons)),
    matchedTokens: Array.from(matchedTokens),
  };
}

export function rankOdinSkills(
  skills: OdinSkillRecord[],
  query: string,
  options?: {
    scope?: 'local' | 'cloud' | 'all';
    limit?: number;
  },
): OdinSearchHit[] {
  const scope = options?.scope ?? 'all';
  const limit = options?.limit ?? 8;
  const hits = skills
    .filter((skill) => scope === 'all' || skill.scope === scope)
    .map((skill) => scoreOdinSkill(skill, query))
    .filter((hit): hit is OdinSearchHit => Boolean(hit))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.skillId.localeCompare(right.skillId);
    });

  return hits.slice(0, limit);
}

