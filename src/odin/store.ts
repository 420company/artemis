import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, pathExists, resolveDataRootDir } from '../utils/fs.js';
import {
  rankOdinSkills,
} from './search.js';
import type {
  OdinEvolutionEvent,
  OdinEvolutionKind,
  OdinEvolutionOutcome,
  OdinSearchQuery,
  OdinSearchRecord,
  OdinSearchResult,
  OdinSkillLineage,
  OdinSkillRecord,
  OdinSkillSource,
  OdinSkillStatus,
  OdinSkillUpsertInput,
  OdinStoreData,
} from './types.js';

function now(): string {
  return new Date().toISOString();
}

function createEmptyStore(): OdinStoreData {
  return {
    version: 1,
    updatedAt: now(),
    skills: [],
    searchRecords: [],
    evolutionEvents: [],
  };
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized : undefined;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => normalizeText(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function normalizeSource(value: unknown): OdinSkillSource {
  return value === 'cloud' ||
    value === 'captured' ||
    value === 'imported' ||
    value === 'manual'
    ? value
    : 'local';
}

function normalizeStatus(value: unknown): OdinSkillStatus {
  return value === 'draft' ||
    value === 'active' ||
    value === 'stale' ||
    value === 'failed' ||
    value === 'archived'
    ? value
    : 'draft';
}

function normalizeScope(value: unknown): 'local' | 'cloud' | 'all' {
  return value === 'local' || value === 'cloud' ? value : 'all';
}

function normalizeConfidence(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 0;
  }

  return Math.max(0, Math.min(10, Math.round(value)));
}

type OdinSkillNormalizationInput = Omit<Partial<OdinSkillRecord>, 'lineage'> & {
  lineage?: Partial<OdinSkillLineage>;
};

function normalizeSkill(
  input: OdinSkillNormalizationInput,
): OdinSkillRecord | undefined {
  const id = normalizeId(input.id ?? '');
  const name = normalizeText(input.name);

  if (!id || !name) {
    return undefined;
  }

  const createdAt = typeof input.createdAt === 'string' ? input.createdAt : now();
  const updatedAt = typeof input.updatedAt === 'string' ? input.updatedAt : createdAt;

  return {
    id,
    name,
    summary: normalizeText(input.summary),
    description: normalizeText(input.description),
    tags: normalizeTags(input.tags),
    source: normalizeSource(input.source),
    status: normalizeStatus(input.status),
    scope: normalizeScope(input.scope),
    confidence: normalizeConfidence(input.confidence),
    readOnly: input.readOnly === true,
    createdAt,
    updatedAt,
    lastUsedAt: normalizeText(input.lastUsedAt),
    lineage: input.lineage
      ? {
          parentSkillIds: Array.isArray(input.lineage.parentSkillIds)
            ? input.lineage.parentSkillIds
                .map((entry) => normalizeText(entry))
                .filter((entry): entry is string => Boolean(entry))
            : [],
          originEventId: normalizeText(input.lineage.originEventId),
          originSearchId: normalizeText(input.lineage.originSearchId),
          changeSummary: normalizeText(input.lineage.changeSummary),
          captureQuery: normalizeText(input.lineage.captureQuery),
          revision: Number.isInteger(input.lineage.revision)
            ? Math.max(0, Number(input.lineage.revision))
            : 0,
        }
      : undefined,
    metadata:
      input.metadata && typeof input.metadata === 'object'
        ? { ...input.metadata }
        : undefined,
  };
}

function normalizeSearchRecord(input: Partial<OdinSearchRecord>): OdinSearchRecord | undefined {
  const query = normalizeText(input.query);
  if (!query) {
    return undefined;
  }

  return {
    id: normalizeText(input.id) ?? randomUUID(),
    query,
    scope: normalizeScope(input.scope),
    limit: Number.isInteger(input.limit) ? Math.max(1, Number(input.limit)) : 8,
    autoImport: input.autoImport === true,
    results: Array.isArray(input.results)
      ? input.results
          .filter(
            (entry): entry is OdinSearchRecord['results'][number] =>
              Boolean(entry) &&
              typeof entry === 'object' &&
              typeof entry.skillId === 'string' &&
              typeof entry.score === 'number',
          )
          .map((entry) => ({
            skillId: normalizeId(entry.skillId),
            score: Math.max(0, Math.round(entry.score)),
            reasons: Array.isArray(entry.reasons)
              ? entry.reasons
                  .map((reason) => normalizeText(reason))
                  .filter((reason): reason is string => Boolean(reason))
              : [],
            matchedTokens: Array.isArray(entry.matchedTokens)
              ? entry.matchedTokens
                  .map((token) => normalizeText(token))
                  .filter((token): token is string => Boolean(token))
              : [],
          }))
      : [],
    searchedAt: typeof input.searchedAt === 'string' ? input.searchedAt : now(),
  };
}

function normalizeEvolutionEvent(
  input: Partial<OdinEvolutionEvent>,
): OdinEvolutionEvent | undefined {
  const summary = normalizeText(input.summary);
  if (!summary) {
    return undefined;
  }

  const kind: OdinEvolutionKind =
    input.kind === 'auto-learn' ||
    input.kind === 'auto-improve' ||
    input.kind === 'auto-fix'
      ? input.kind
      : 'manual';

  const outcome: OdinEvolutionOutcome =
    input.outcome === 'success' ||
    input.outcome === 'partial' ||
    input.outcome === 'failure'
      ? input.outcome
      : 'success';

  return {
    id: normalizeText(input.id) ?? randomUUID(),
    kind,
    outcome,
    skillIds: Array.isArray(input.skillIds)
      ? input.skillIds
          .map((entry) => normalizeText(entry))
          .filter((entry): entry is string => Boolean(entry))
          .map((entry) => normalizeId(entry))
      : [],
    summary,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : now(),
    metadata:
      input.metadata && typeof input.metadata === 'object'
        ? { ...input.metadata }
        : undefined,
  };
}

function getEmptySkillIndex(): OdinStoreData {
  return createEmptyStore();
}

export class OdinStore {
  private readonly rootDir: string;
  private readonly filePath: string;

  constructor(cwd: string) {
    this.rootDir = resolveDataRootDir(cwd);
    this.filePath = path.join(this.rootDir, 'odin.json');
  }

  async ensure(): Promise<void> {
    await ensureDir(this.rootDir);
  }

  async load(): Promise<OdinStoreData> {
    await this.ensure();

    if (!(await pathExists(this.filePath))) {
      return getEmptySkillIndex();
    }

    const raw = await readFile(this.filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<OdinStoreData>;

    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : now(),
      lastDecayAt: typeof parsed.lastDecayAt === 'string' ? parsed.lastDecayAt : undefined,
      skills: Array.isArray(parsed.skills)
        ? parsed.skills
            .map((entry) => normalizeSkill(entry as Partial<OdinSkillRecord>))
            .filter((entry): entry is OdinSkillRecord => Boolean(entry))
        : [],
      searchRecords: Array.isArray(parsed.searchRecords)
        ? parsed.searchRecords
            .map((entry) =>
              normalizeSearchRecord(entry as Partial<OdinSearchRecord>),
            )
            .filter((entry): entry is OdinSearchRecord => Boolean(entry))
        : [],
      evolutionEvents: Array.isArray(parsed.evolutionEvents)
        ? parsed.evolutionEvents
            .map((entry) =>
              normalizeEvolutionEvent(entry as Partial<OdinEvolutionEvent>),
            )
            .filter((entry): entry is OdinEvolutionEvent => Boolean(entry))
        : [],
    };
  }

  async save(data: OdinStoreData): Promise<void> {
    await this.ensure();
    await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  private async persist(nextData: OdinStoreData): Promise<OdinStoreData> {
    nextData.updatedAt = now();
    await this.save(nextData);
    return nextData;
  }

  async upsertSkill(input: OdinSkillUpsertInput): Promise<OdinSkillRecord> {
    const data = await this.load();
    const normalized = normalizeSkill({
      ...input,
      id: input.id,
      name: input.name,
      tags: input.tags,
      source: input.source,
      status: input.status,
      scope: input.scope,
      confidence: input.confidence,
      readOnly: input.readOnly,
      lastUsedAt: input.lastUsedAt,
      lineage: input.lineage,
      metadata: input.metadata,
    });

    if (!normalized) {
      throw new Error('Odin skill requires both id and name.');
    }

    const existingIndex = data.skills.findIndex(
      (entry) => entry.id === normalized.id,
    );

    if (existingIndex >= 0) {
      const existing = data.skills[existingIndex];
      normalized.createdAt = existing.createdAt;
      normalized.updatedAt = now();
      normalized.lineage = {
        parentSkillIds: normalized.lineage?.parentSkillIds ?? existing.lineage?.parentSkillIds ?? [],
        originEventId: normalized.lineage?.originEventId ?? existing.lineage?.originEventId,
        originSearchId: normalized.lineage?.originSearchId ?? existing.lineage?.originSearchId,
        changeSummary: normalized.lineage?.changeSummary ?? existing.lineage?.changeSummary,
        captureQuery: normalized.lineage?.captureQuery ?? existing.lineage?.captureQuery,
        revision: (existing.lineage?.revision ?? 0) + 1,
      };
      data.skills[existingIndex] = normalized;
    } else {
      normalized.createdAt = now();
      normalized.updatedAt = normalized.createdAt;
      normalized.lineage = {
        parentSkillIds: normalized.lineage?.parentSkillIds ?? [],
        originEventId: normalized.lineage?.originEventId,
        originSearchId: normalized.lineage?.originSearchId,
        changeSummary: normalized.lineage?.changeSummary,
        captureQuery: normalized.lineage?.captureQuery,
        revision: normalized.lineage?.revision ?? 0,
      };
      data.skills.push(normalized);
    }

    await this.persist(data);
    return normalized;
  }

  async touchSkill(skillId: string): Promise<OdinSkillRecord | undefined> {
    const data = await this.load();
    const normalizedId = normalizeId(skillId);
    const skill = data.skills.find((entry) => entry.id === normalizedId);
    if (!skill) {
      return undefined;
    }

    skill.lastUsedAt = now();
    skill.updatedAt = skill.lastUsedAt;
    await this.persist(data);
    return skill;
  }

  async recordSearch(
    input: OdinSearchQuery,
    hits?: OdinSearchResult['hits'],
  ): Promise<OdinSearchRecord> {
    const data = await this.load();
    const record = normalizeSearchRecord({
      id: randomUUID(),
      query: input.query,
      scope: input.scope ?? 'all',
      limit: input.limit ?? 8,
      autoImport: input.autoImport === true,
      results: hits ?? [],
      searchedAt: now(),
    });

    if (!record) {
      throw new Error('Odin search requires a non-empty query.');
    }

    data.searchRecords.push(record);
    await this.persist(data);
    return record;
  }

  async searchSkills(query: OdinSearchQuery): Promise<OdinSearchResult> {
    const data = await this.load();
    let cloudSkills: OdinSkillRecord[] = [];

    if (query.scope === 'cloud' || query.scope === 'all') {
      try {
        // Point to the official community skills registry
        const res = await fetch('https://raw.githubusercontent.com/420company/artemis-skills/main/registry.json');
        if (res.ok) {
           const remoteData = (await res.json()) as Partial<OdinSkillRecord>[];
           if (Array.isArray(remoteData)) {
              cloudSkills = remoteData.map((s) => ({
                 ...s,
                 source: 'cloud',
                 scope: 'cloud',
                 id: s.id ?? randomUUID()
              })) as OdinSkillRecord[];
           }
        }
      } catch (e) {
        // Fallback gracefully to offline mode
      }
    }

    // Merge offline and true-cloud records for the ranking algorithm
    const combinedPool = [...data.skills, ...cloudSkills];
    const hits = rankOdinSkills(combinedPool, query.query, {
      scope: query.scope,
      limit: query.limit,
    });
    const record = await this.recordSearch(query, hits);

    return {
      query: record.query,
      scope: record.scope,
      limit: record.limit,
      hits: record.results,
    };
  }

  async recordEvolutionEvent(
    input: Omit<OdinEvolutionEvent, 'id' | 'createdAt'> & {
      id?: string;
      createdAt?: string;
    },
  ): Promise<OdinEvolutionEvent> {
    const data = await this.load();
    const event = normalizeEvolutionEvent({
      ...input,
      id: input.id ?? randomUUID(),
      createdAt: input.createdAt ?? now(),
    });

    if (!event) {
      throw new Error('Odin evolution events require a summary.');
    }

    data.evolutionEvents.push(event);
    await this.persist(data);
    return event;
  }

  listSkills(data: OdinStoreData): OdinSkillRecord[] {
    return [...data.skills].sort((left, right) => {
      if (left.updatedAt !== right.updatedAt) {
        return right.updatedAt.localeCompare(left.updatedAt);
      }

      return left.name.localeCompare(right.name);
    });
  }

  getSkill(data: OdinStoreData, skillId: string): OdinSkillRecord | undefined {
    const normalizedId = normalizeId(skillId);
    return data.skills.find((entry) => entry.id === normalizedId);
  }

  async setLastDecayAt(timestamp: string): Promise<void> {
    const data = await this.load();
    data.lastDecayAt = timestamp;
    await this.persist(data);
  }

  /** Convenience: list skills with optional status filter */
  async list(options?: { status?: string }): Promise<OdinSkillRecord[]> {
    const data = await this.load();
    const all = this.listSkills(data);
    if (!options?.status) return all;
    return all.filter((s) => s.status === options.status);
  }

  /** Convenience: search by query string */
  async search(options: { query: string; limit?: number }): Promise<OdinSearchResult> {
    return this.searchSkills({ query: options.query, limit: options.limit });
  }

  /** Convenience: capture/create a new skill */
  async capture(input: OdinSkillUpsertInput): Promise<OdinSkillRecord> {
    return this.upsertSkill(input);
  }

  /** Convenience: apply score decay to all skills */
  async applyDecay(): Promise<{ affected: number }> {
    const data = await this.load();
    let affected = 0;
    const now = new Date().toISOString();
    for (const skill of data.skills) {
      if (typeof skill.confidence === 'number' && skill.confidence > 0) {
        skill.confidence = Math.max(0, skill.confidence - 0.05);
        skill.updatedAt = now;
        affected++;
      }
    }
    data.lastDecayAt = now;
    await this.persist(data);
    return { affected };
  }

  /** Convenience: delete a skill by id */
  async delete(skillId: string): Promise<boolean> {
    const data = await this.load();
    const normalizedId = normalizeId(skillId);
    const before = data.skills.length;
    data.skills = data.skills.filter((s) => s.id !== normalizedId);
    await this.persist(data);
    return data.skills.length < before;
  }
}
