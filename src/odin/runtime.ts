import { createHash } from 'node:crypto';
import type { AgentRole, VerificationCommandRecord } from '../core/types.js';
import type { WorkflowMode } from '../core/workflowMode.js';
import { truncate } from '../utils/fs.js';
import { rankOdinSkills } from './search.js';
import { OdinStore } from './store.js';
import type { OdinSkillStatus } from './types.js';

function normalizePrompt(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function buildCaptureSignature(mode: WorkflowMode, prompt: string): string {
  return `${mode}::${normalizePrompt(prompt)}`;
}

function getMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

function deriveSkillId(mode: WorkflowMode, signature: string): string {
  const digest = createHash('sha1').update(signature).digest('hex').slice(0, 12);
  return `workflow-${mode}-${digest}`;
}

function deriveSkillName(mode: WorkflowMode, prompt: string): string {
  const label = prompt.replace(/\s+/g, ' ').trim();
  const display = label.length > 56 ? `${label.slice(0, 56).trim()}...` : label;
  return `${mode} :: ${display || 'captured workflow'}`;
}

function extractTags(mode: WorkflowMode, prompt: string): string[] {
  const words = prompt
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9._-]{2,}/g);
  return [mode, ...(words ?? [])].filter(
    (value, index, values) => values.indexOf(value) === index,
  ).slice(0, 8);
}

// ─── Skill decay ─────────────────────────────────────────────────────────────

/** How many milliseconds of disuse before confidence drops by 1. Default: 14 days. */
const DECAY_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000;

/** Confidence floor at which a skill is automatically marked stale. */
const STALE_CONFIDENCE_THRESHOLD = 2;

/** Only run one decay pass per session (guarded by lastDecayAt + 24 h). */
const DECAY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export async function applyOdinSkillDecay(options: {
  cwd: string;
}): Promise<{ checked: number; decayed: number; stalified: number }> {
  const store = new OdinStore(options.cwd);
  const data = await store.load();

  // Throttle: skip if last decay was less than 24 h ago
  if (data.lastDecayAt) {
    const msSinceDecay = Date.now() - new Date(data.lastDecayAt).getTime();
    if (msSinceDecay < DECAY_COOLDOWN_MS) {
      return { checked: 0, decayed: 0, stalified: 0 };
    }
  }

  const nowMs = Date.now();
  let checked = 0;
  let decayed = 0;
  let stalified = 0;

  for (const skill of data.skills) {
    if (skill.status !== 'active' || skill.readOnly) {
      continue;
    }

    const lastActivity = skill.lastUsedAt ?? skill.updatedAt ?? skill.createdAt;
    const msSinceUse = nowMs - new Date(lastActivity).getTime();
    const intervals = Math.floor(msSinceUse / DECAY_INTERVAL_MS);

    if (intervals < 1) {
      continue;
    }

    checked++;
    const prevConfidence = skill.confidence;
    const nextConfidence = Math.max(0, prevConfidence - intervals);

    if (nextConfidence === prevConfidence) {
      continue;
    }

    const nextStatus: OdinSkillStatus =
      nextConfidence < STALE_CONFIDENCE_THRESHOLD ? 'stale' : 'active';

    await store.upsertSkill({
      id: skill.id,
      name: skill.name,
      summary: skill.summary,
      description: skill.description,
      tags: skill.tags,
      source: skill.source,
      status: nextStatus,
      scope: skill.scope,
      confidence: nextConfidence,
      readOnly: skill.readOnly,
      lastUsedAt: skill.lastUsedAt,
      lineage: {
        ...skill.lineage,
        changeSummary: `Confidence decayed ${prevConfidence} → ${nextConfidence} (${intervals} × 14-day interval unused)`,
      },
      metadata: skill.metadata,
    });

    decayed++;
    if (nextStatus === 'stale') {
      stalified++;
    }
  }

  await store.setLastDecayAt(new Date().toISOString());
  return { checked, decayed, stalified };
}

// ─── Cloud operations ─────────────────────────────────────────────────────────

/**
 * Returns the configured cloud endpoint, or undefined if not set.
 * Reads ARTEMIS_ODIN_CLOUD_URL from the environment.
 */
function getOdinCloudUrl(): string | undefined {
  const raw = process.env['ARTEMIS_ODIN_CLOUD_URL'];
  return typeof raw === 'string' && raw.trim() ? raw.trim().replace(/\/+$/, '') : undefined;
}

export async function importOdinCloudSkills(options: {
  cwd: string;
  query?: string;
  limit?: number;
}): Promise<{ ok: boolean; output: string }> {
  const cloudUrl = getOdinCloudUrl();
  if (!cloudUrl) {
    return {
      ok: false,
      output: [
        'Cloud import requires ARTEMIS_ODIN_CLOUD_URL to be set.',
        'Set it to the base URL of your Odin cloud skill server, e.g.:',
        '  export ARTEMIS_ODIN_CLOUD_URL=https://my-odin-server.example.com',
      ].join('\n'),
    };
  }

  const params = new URLSearchParams();
  if (options.query) {
    params.set('q', options.query);
  }
  params.set('limit', String(Math.max(1, options.limit ?? 10)));

  let response: Response;
  try {
    response = await fetch(`${cloudUrl}/skills?${params.toString()}`, {
      headers: { accept: 'application/json' },
    });
  } catch (err) {
    return {
      ok: false,
      output: `Cloud import request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      output: `Cloud import failed: ${response.status} ${response.statusText}`,
    };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, output: 'Cloud import failed: response was not valid JSON.' };
  }

  const skillList = Array.isArray((json as Record<string, unknown>)['skills'])
    ? ((json as Record<string, unknown>)['skills'] as unknown[])
    : Array.isArray(json)
    ? (json as unknown[])
    : [];

  const store = new OdinStore(options.cwd);
  let imported = 0;
  let skipped = 0;

  for (const raw of skillList) {
    if (!raw || typeof raw !== 'object') {
      skipped++;
      continue;
    }

    const entry = raw as Partial<import('./types.ts').OdinSkillRecord>;
    if (!entry.id || !entry.name) {
      skipped++;
      continue;
    }

    await store.upsertSkill({
      id: entry.id,
      name: entry.name,
      summary: entry.summary,
      description: entry.description,
      tags: entry.tags,
      source: 'cloud',
      status: entry.status ?? 'active',
      scope: 'cloud',
      confidence: entry.confidence ?? 5,
      readOnly: true,
      lineage: entry.lineage,
      metadata: entry.metadata,
    });
    imported++;
  }

  await store.recordEvolutionEvent({
    kind: 'manual',
    outcome: 'success',
    skillIds: [],
    summary: `Imported ${imported} skill(s) from cloud (${cloudUrl})`,
    metadata: { query: options.query ?? '', imported, skipped, cloudUrl },
  });

  return {
    ok: true,
    output: JSON.stringify({ imported, skipped, query: options.query ?? '', cloudUrl }, null, 2),
  };
}

export async function buildOdinRuntimeSection(options: {
  cwd: string;
  prompt: string;
  profile: 'main' | AgentRole;
}): Promise<string | undefined> {
  const query = options.prompt.trim();
  if (!query) {
    return undefined;
  }

  // Fire-and-forget skill decay — runs at most once per 24 h, does not block.
  applyOdinSkillDecay({ cwd: options.cwd }).catch(() => undefined);

  const store = new OdinStore(options.cwd);
  const data = await store.load();
  const activeSkills = data.skills.filter((skill) => skill.status === 'active');
  const hits = rankOdinSkills(activeSkills, query, {
    scope: 'all',
    limit: options.profile === 'main' ? 3 : 2,
  });

  if (hits.length === 0) {
    return undefined;
  }

  // Progressive disclosure: only inject name + one-line description (Level 0).
  // This keeps the system prompt lean (~80 tokens for 3 skills instead of ~500+).
  const lines = [
    'Odin skill hints (reusable patterns from prior work):',
  ];

  for (const hit of hits) {
    const skill = data.skills.find((entry) => entry.id === hit.skillId);
    if (!skill) {
      continue;
    }

    const desc = truncate(skill.summary || skill.description || '', 90);
    lines.push(`- [${skill.name}] conf=${skill.confidence}: ${desc}`);
  }

  return lines.join('\n');
}

export async function recordOdinWorkflowSuccess(options: {
  cwd: string;
  mode: WorkflowMode;
  prompt: string;
  reply: string;
  turns: number;
  changedFiles?: string[];
  verificationCommands?: VerificationCommandRecord[];
}): Promise<void> {
  const store = new OdinStore(options.cwd);
  const data = await store.load();
  const signature = buildCaptureSignature(options.mode, options.prompt);
  const existingSkill = data.skills.find(
    (skill) => getMetadataString(skill.metadata, 'captureSignature') === signature,
  );
  const priorSuccessCount = data.evolutionEvents.filter(
    (event) =>
      event.outcome === 'success' &&
      getMetadataString(event.metadata, 'captureSignature') === signature,
  ).length;
  const verificationCount = options.verificationCommands?.length ?? 0;
  const changedCount = options.changedFiles?.length ?? 0;
  let skillIds: string[] = [];
  let kind: 'auto-learn' | 'auto-improve' = 'auto-learn';

  if (existingSkill) {
    await store.upsertSkill({
      id: existingSkill.id,
      name: existingSkill.name,
      summary: existingSkill.summary,
      description: existingSkill.description,
      tags: existingSkill.tags,
      source: existingSkill.source,
      status: existingSkill.status,
      scope: existingSkill.scope,
      confidence: Math.min(10, existingSkill.confidence + 1),
      readOnly: existingSkill.readOnly,
      lastUsedAt: new Date().toISOString(),
      lineage: existingSkill.lineage,
      metadata: existingSkill.metadata,
    });
    skillIds = [existingSkill.id];
    kind = 'auto-improve';
  } else if (priorSuccessCount >= 1) {
    const skillId = deriveSkillId(options.mode, signature);
    const skill = await store.upsertSkill({
      id: skillId,
      name: deriveSkillName(options.mode, options.prompt),
      summary: `Captured from repeated ${options.mode} workflows`,
      description: truncate(options.reply, 280),
      tags: extractTags(options.mode, options.prompt),
      source: 'captured',
      status: 'active',
      scope: 'local',
      confidence: Math.min(10, 6 + priorSuccessCount + (verificationCount > 0 ? 1 : 0)),
      lineage: {
        parentSkillIds: [],
        changeSummary: `Captured after repeated successful ${options.mode} workflow runs`,
        captureQuery: options.prompt,
      },
      metadata: {
        captureSignature: signature,
        workflowMode: options.mode,
      },
    });
    skillIds = [skill.id];
    kind = 'auto-learn';
  }

  await store.recordEvolutionEvent({
    kind,
    outcome: 'success',
    skillIds,
    summary:
      skillIds.length > 0
        ? `Odin ${kind} captured reusable workflow state for ${options.mode}`
        : `Odin observed a reusable ${options.mode} workflow candidate`,
    metadata: {
      captureSignature: signature,
      workflowMode: options.mode,
      prompt: truncate(options.prompt, 200),
      replyPreview: truncate(options.reply, 200),
      turns: options.turns,
      changedFiles: options.changedFiles ?? [],
      changedFileCount: changedCount,
      verificationCount,
      verificationCommands: (options.verificationCommands ?? []).map((entry) =>
        truncate(entry.command, 120),
      ),
    },
  });
}

export async function recordOdinWorkflowFailure(options: {
  cwd: string;
  mode: WorkflowMode;
  prompt: string;
  error: string;
}): Promise<void> {
  const store = new OdinStore(options.cwd);
  const signature = buildCaptureSignature(options.mode, options.prompt);
  await store.recordEvolutionEvent({
    kind: 'auto-fix',
    outcome: 'failure',
    skillIds: [],
    summary: `Odin recorded a failed ${options.mode} workflow for later repair`,
    metadata: {
      captureSignature: signature,
      workflowMode: options.mode,
      prompt: truncate(options.prompt, 200),
      error: truncate(options.error, 240),
    },
  });
}

export async function executeOdinSearchSkills(options: {
  cwd: string;
  query: string;
  scope?: 'local' | 'cloud' | 'all';
  limit?: number;
}): Promise<{ ok: boolean; output: string }> {
  const store = new OdinStore(options.cwd);
  const result = await store.searchSkills({
    query: options.query,
    scope: options.scope ?? 'all',
    limit: Math.max(1, options.limit ?? 6),
  });
  if (result.hits.length > 0) {
    await store.touchSkill(result.hits[0].skillId).catch(() => undefined);
  }
  return {
    ok: true,
    output: JSON.stringify(
      {
        query: result.query,
        scope: result.scope,
        total: result.hits.length,
        hits: result.hits.map((hit) => ({
          skillId: hit.skillId,
          score: hit.score,
          reasons: hit.reasons,
        })),
      },
      null,
      2,
    ),
  };
}

export async function resolveOdinSkillContext(options: {
  cwd: string;
  task: string;
  scope?: 'local' | 'cloud' | 'all';
}): Promise<string | undefined> {
  const store = new OdinStore(options.cwd);
  const data = await store.load();
  const activeSkills = data.skills.filter((skill) => skill.status === 'active');
  const hits = rankOdinSkills(activeSkills, options.task, {
    scope: options.scope ?? 'all',
    limit: 2,
  });
  if (hits.length === 0) {
    return undefined;
  }
  const lines: string[] = ['Matched Odin skills:'];
  for (const hit of hits) {
    const skill = data.skills.find((entry) => entry.id === hit.skillId);
    if (!skill) {
      continue;
    }
    await store.touchSkill(hit.skillId).catch(() => undefined);
    lines.push(
      `- ${skill.name} [conf=${skill.confidence}]: ${truncate(skill.summary ?? skill.description ?? '', 200)}`,
    );
  }
  return lines.join('\n');
}

export async function executeOdinFixSkill(options: {
  cwd: string;
  skillId: string;
  errorContext?: string;
  summary?: string;
}): Promise<{ ok: boolean; output: string }> {
  const store = new OdinStore(options.cwd);
  const data = await store.load();
  const skill = store.getSkill(data, options.skillId);
  if (!skill) {
    return { ok: false, output: `Odin skill not found: ${options.skillId}` };
  }
  const fixSummary =
    options.summary ?? `Manual fix applied to skill: ${skill.name}`;
  const updatedSkill = await store.upsertSkill({
    ...skill,
    status: 'stale',
    lineage: {
      ...skill.lineage,
      changeSummary: fixSummary,
    },
  });
  await store.recordEvolutionEvent({
    kind: 'auto-fix',
    outcome: 'partial',
    skillIds: [updatedSkill.id],
    summary: fixSummary,
    metadata: {
      skillId: options.skillId,
      errorContext: options.errorContext ?? '',
    },
  });
  return {
    ok: true,
    output: JSON.stringify(
      {
        skillId: updatedSkill.id,
        name: updatedSkill.name,
        status: updatedSkill.status,
        revision: updatedSkill.lineage?.revision ?? 0,
        summary: fixSummary,
      },
      null,
      2,
    ),
  };
}

export async function executeOdinUploadSkill(options: {
  cwd: string;
  skillId: string;
  visibility?: 'local' | 'private' | 'public';
  notes?: string;
}): Promise<{ ok: boolean; output: string }> {
  const store = new OdinStore(options.cwd);
  const data = await store.load();
  const skill = store.getSkill(data, options.skillId);
  if (!skill) {
    return { ok: false, output: `Odin skill not found: ${options.skillId}` };
  }
  if (skill.readOnly) {
    return {
      ok: false,
      output: `Odin skill ${options.skillId} is read-only and cannot be modified.`,
    };
  }

  const target = options.visibility ?? 'cloud';
  const newScope: 'local' | 'cloud' = target === 'local' ? 'local' : 'cloud';

  // ── Attempt real cloud upload if endpoint is configured ──────────────────
  let cloudUploaded = false;
  let cloudError: string | undefined;

  if (newScope === 'cloud') {
    const cloudUrl = getOdinCloudUrl();
    if (!cloudUrl) {
      return {
        ok: false,
        output: [
          `Cloud upload requires ARTEMIS_ODIN_CLOUD_URL to be set.`,
          `Set it to the base URL of your Odin cloud skill server, e.g.:`,
          `  export ARTEMIS_ODIN_CLOUD_URL=https://my-odin-server.example.com`,
          ``,
          `To mark the skill as locally-scoped only, pass visibility=local.`,
        ].join('\n'),
      };
    }

    try {
      const response = await fetch(`${cloudUrl}/skills`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          skill: {
            id: skill.id,
            name: skill.name,
            summary: skill.summary,
            description: skill.description,
            tags: skill.tags,
            source: skill.source,
            status: skill.status,
            confidence: skill.confidence,
            lineage: skill.lineage,
            metadata: skill.metadata,
          },
          visibility: target,
          notes: options.notes ?? '',
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        cloudError = `Cloud upload returned ${response.status} ${response.statusText}${body ? `: ${truncate(body, 200)}` : ''}`;
      } else {
        cloudUploaded = true;
      }
    } catch (err) {
      cloudError = `Cloud upload request failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (cloudError) {
      return { ok: false, output: cloudError };
    }
  }

  const uploadSummary = options.notes
    ? `Uploaded to ${target}: ${options.notes}`
    : cloudUploaded
    ? `Uploaded to cloud (${getOdinCloudUrl()}) via odin_upload_skill`
    : `Marked as ${target} via odin_upload_skill`;

  const updatedSkill = await store.upsertSkill({
    ...skill,
    scope: newScope,
    lineage: {
      ...skill.lineage,
      changeSummary: uploadSummary,
    },
  });

  await store.recordEvolutionEvent({
    kind: 'manual',
    outcome: 'success',
    skillIds: [updatedSkill.id],
    summary: uploadSummary,
    metadata: {
      skillId: options.skillId,
      visibility: target,
      previousScope: skill.scope,
      newScope,
      cloudUploaded,
      cloudUrl: getOdinCloudUrl() ?? null,
    },
  });

  return {
    ok: true,
    output: JSON.stringify(
      {
        skillId: updatedSkill.id,
        name: updatedSkill.name,
        scope: updatedSkill.scope,
        visibility: target,
        cloudUploaded,
        revision: updatedSkill.lineage?.revision ?? 0,
        summary: uploadSummary,
      },
      null,
      2,
    ),
  };
}
