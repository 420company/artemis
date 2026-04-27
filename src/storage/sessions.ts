import {
  appendFile,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AgentRole,
  AgentPhase,
  ClaimStatus,
  EvidenceConflict,
  EvidenceEdge,
  EvidenceEdgeType,
  EvidenceGraph,
  EvidenceKind,
  HeimdallEventRecord,
  SessionAutonomyMode,
  SessionMessage,
  SessionRecord,
  TaskItem,
  TaskRuntimeRecord,
  VerificationCommandRecord,
} from '../core/types.js';
import { isHeimdallEventKind } from '../core/types.js';
import {
  canonicalizeClaimStatement,
  synchronizeEvidenceGraph,
} from '../core/evidence.js';
import {
  normalizeTaskRuntimeCollection,
} from '../core/taskRuntime.js';
import { isTaskStatus } from '../core/tasks.js';
import {
  ensureDir,
  pathExists,
  resolveDataRootDir,
} from '../utils/fs.js';
import {
  invalidateSessionSearchCache,
  syncSessionSearchIndex,
} from './sessionSearch.js';

function now(): string {
  return new Date().toISOString();
}

function deriveTitle(cwd: string): string {
  return `Session in ${path.basename(cwd) || cwd}`;
}

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim();
}

function normalizeFilePath(inputPath: string): string {
  return inputPath.replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function sameStringArray(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameVerificationCommandArray(
  left: VerificationCommandRecord[],
  right: VerificationCommandRecord[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => {
      const other = right[index];
      return (
        value.command === other?.command &&
        value.ok === other?.ok &&
        value.createdAt === other?.createdAt
      );
    })
  );
}

function sameHeimdallEventArray(
  left: HeimdallEventRecord[],
  right: HeimdallEventRecord[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => JSON.stringify(value) === JSON.stringify(right[index]))
  );
}

type CreateSessionOptions = {
  title?: string;
  autonomyMode?: SessionAutonomyMode;
  kind?: 'main' | 'agent';
  parentSessionId?: string;
  rootSessionId?: string;
  runtimeTaskId?: string;
  agentRole?: AgentRole;
  agentPhase?: AgentPhase;
  delegatedTask?: string;
};

function sameTaskArray(left: TaskItem[], right: TaskItem[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => {
      const other = right[index];
      return (
        value.id === other?.id &&
        value.content === other?.content &&
        value.status === other?.status
      );
    })
  );
}

function sameTaskRuntimeArray(
  left: TaskRuntimeRecord[],
  right: TaskRuntimeRecord[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => {
      const other = right[index];
      return JSON.stringify(value) === JSON.stringify(other);
    })
  );
}

function normalizeStickyNativeMcpTools(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return uniqueStrings(
    value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => /^mcp(__|_prompt__|_resource__)/.test(entry)),
  ).slice(-64);
}

function normalizeSessionAutonomyMode(
  value: unknown,
): SessionAutonomyMode {
  return value === 'autodrive' ? 'autodrive' : 'standard';
}

function normalizeHeimdallEventCollection(
  value: unknown,
): HeimdallEventRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const records: HeimdallEventRecord[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    const id =
      typeof candidate.id === 'string' && candidate.id.trim()
        ? candidate.id.trim()
        : '';
    const kind = isHeimdallEventKind(candidate.kind) ? candidate.kind : null;
    const createdAt =
      typeof candidate.createdAt === 'string' && candidate.createdAt.trim()
        ? candidate.createdAt.trim()
        : '';
    const summary =
      typeof candidate.summary === 'string' && candidate.summary.trim()
        ? candidate.summary.trim()
        : '';
    if (!id || !kind || !createdAt || !summary || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const metadata =
      candidate.metadata &&
      typeof candidate.metadata === 'object' &&
      !Array.isArray(candidate.metadata)
        ? Object.fromEntries(
            Object.entries(candidate.metadata as Record<string, unknown>)
              .filter(
                (pair): pair is [string, string] =>
                  typeof pair[0] === 'string' && typeof pair[1] === 'string',
              )
              .map(([key, value]) => [key.trim(), value.trim()])
              .filter(([key, value]) => key.length > 0 && value.length > 0),
          )
        : undefined;

    records.push({
      id,
      kind,
      createdAt,
      summary,
      runtimeId:
        typeof candidate.runtimeId === 'string' && candidate.runtimeId.trim()
          ? candidate.runtimeId.trim()
          : undefined,
      sessionId:
        typeof candidate.sessionId === 'string' && candidate.sessionId.trim()
          ? candidate.sessionId.trim()
          : undefined,
      workerSessionId:
        typeof candidate.workerSessionId === 'string' &&
        candidate.workerSessionId.trim()
          ? candidate.workerSessionId.trim()
          : undefined,
      workflowMode:
        candidate.workflowMode === 'direct' ||
        candidate.workflowMode === 'niko' ||
        candidate.workflowMode === 'contest' ||
        candidate.workflowMode === 'athena' ||
        candidate.workflowMode === 'design' ||
        candidate.workflowMode === 'nidhogg'
          ? candidate.workflowMode
          : undefined,
      role:
        candidate.role === 'planner' ||
        candidate.role === 'researcher' ||
        candidate.role === 'builder' ||
        candidate.role === 'reviewer' ||
        candidate.role === 'brainstormer' ||
        candidate.role === 'arbiter'
          ? candidate.role
          : undefined,
      phase:
        candidate.phase === 'proposal' || candidate.phase === 'execution'
          ? candidate.phase
          : undefined,
      status:
        candidate.status === 'queued' ||
        candidate.status === 'running' ||
        candidate.status === 'waiting_approval' ||
        candidate.status === 'completed' ||
        candidate.status === 'failed' ||
        candidate.status === 'interrupted'
          ? candidate.status
          : undefined,
      metadata:
        metadata && Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }

  return records
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-256);
}

export class SessionStore {
  private readonly cwd: string;
  private readonly rootDir: string;
  private readonly sessionDir: string;
  private readonly workflowDir: string;
  private readonly evidenceDir: string;
  private readonly sessionCache = new Map<string, SessionRecord>();
  private readonly evidenceCache = new Map<string, EvidenceGraph>();

  constructor(cwd: string) {
    this.cwd = cwd;
    this.rootDir = resolveDataRootDir(cwd);
    this.sessionDir = path.join(this.rootDir, 'sessions');
    this.workflowDir = path.join(this.rootDir, 'workflows');
    this.evidenceDir = path.join(this.rootDir, 'evidence');
  }

  async ensure(): Promise<void> {
    await ensureDir(this.sessionDir);
    await ensureDir(this.workflowDir);
    await ensureDir(this.evidenceDir);
  }

  createSession(options?: CreateSessionOptions): SessionRecord {
    const createdAt = now();
    const id = randomUUID();
    const session = {
      id,
      rootSessionId: options?.rootSessionId ?? id,
      runtimeTaskId: options?.runtimeTaskId,
      cwd: this.cwd,
      title: options?.title ?? deriveTitle(this.cwd),
      autonomyMode: options?.autonomyMode ?? 'standard',
      kind: options?.kind ?? 'main',
      parentSessionId: options?.parentSessionId,
      agentRole: options?.agentRole,
      agentPhase: options?.agentPhase,
      delegatedTask: options?.delegatedTask,
      plan: [],
      tasks: [],
      taskRuntimes: [],
      summary: '',
      changedFiles: [],
      verificationCommands: [],
      stickyNativeMcpTools: [],
      heimdallEvents: [],
      createdAt,
      updatedAt: createdAt,
      messages: [],
    };
    this.sessionCache.set(id, session);
    return session;
  }

  appendMessage(
    session: SessionRecord,
    role: SessionMessage['role'],
    content: string,
    name?: string,
  ): SessionRecord {
    const message: SessionMessage = {
      id: randomUUID(),
      role,
      content,
      name,
      createdAt: now(),
    };

    session.messages.push(message);
    session.updatedAt = now();
    return session;
  }

  recordChangedFiles(
    session: SessionRecord,
    filePaths: string[],
  ): SessionRecord {
    const normalized = uniqueStrings(
      [
        ...(session.changedFiles ?? []),
        ...filePaths.map(normalizeFilePath).filter(Boolean),
      ],
    ).sort();
    session.changedFiles = normalized;
    session.updatedAt = now();
    return session;
  }

  recordVerificationCommand(
    session: SessionRecord,
    command: string,
    ok: boolean,
  ): SessionRecord {
    const nextRecord: VerificationCommandRecord = {
      command: normalizeCommand(command),
      ok,
      createdAt: now(),
    };
    const existing = (session.verificationCommands ?? []).filter(
      (entry) =>
        !(entry.command === nextRecord.command && entry.ok === nextRecord.ok),
    );
    session.verificationCommands = [...existing, nextRecord];
    session.updatedAt = now();
    return session;
  }

  appendHeimdallEvent(
    session: SessionRecord,
    event: HeimdallEventRecord,
  ): SessionRecord {
    session.heimdallEvents = [
      ...(session.heimdallEvents ?? []),
      event,
    ].slice(-256);
    session.updatedAt = now();
    return session;
  }

  async save(session: SessionRecord): Promise<void> {
    await this.ensure();
    const normalized = this.normalizeSession(session);
    if (normalized.mutated) {
      session = normalized.session;
    }
    session.updatedAt = now();
    this.sessionCache.set(session.id, session);
    await writeFile(
      path.join(this.sessionDir, `${session.id}.json`),
      JSON.stringify(session, null, 2),
      'utf8',
    );
    invalidateSessionSearchCache(this.cwd);
    await syncSessionSearchIndex(this.cwd, session);
  }

  async load(sessionId: string): Promise<SessionRecord> {
    const cached = this.sessionCache.get(sessionId);
    if (cached) {
      return cached;
    }

    await this.ensure();
    const raw = await readFile(
      path.join(this.sessionDir, `${sessionId}.json`),
      'utf8',
    );
    const normalized = this.normalizeSession(JSON.parse(raw) as SessionRecord);
    if (normalized.mutated) {
      await this.save(normalized.session);
    }
    this.sessionCache.set(normalized.session.id, normalized.session);
    return normalized.session;
  }

  async loadLatest(): Promise<SessionRecord | null> {
    await this.ensure();
    const sessions = await this.list();
    const latest = sessions[0] ?? null;
    if (!latest) {
      return null;
    }

    const rootId =
      latest.kind === 'agent'
        ? latest.rootSessionId ?? latest.parentSessionId
        : latest.rootSessionId;

    if (!rootId || rootId === latest.id) {
      return latest;
    }

    return (
      sessions.find((session) => session.id === rootId) ??
      this.load(rootId).catch(() => latest)
    );
  }

  async list(): Promise<SessionRecord[]> {
    await this.ensure();
    const entries = await readdir(this.sessionDir);
    const sessions: Array<{ session: SessionRecord; mtimeMs: number }> = [];

    for (const entry of entries) {
      if (!entry.endsWith('.json')) {
        continue;
      }

      const filePath = path.join(this.sessionDir, entry);
      if (!(await pathExists(filePath))) {
        continue;
      }

      const [raw, info] = await Promise.all([
        readFile(filePath, 'utf8'),
        stat(filePath),
      ]);
      sessions.push({
        session: JSON.parse(raw) as SessionRecord,
        mtimeMs: info.mtimeMs,
      });
    }
    const normalizedSessions = this.normalizeSessionCollection(
      sessions.map((entry) => entry.session),
    );
    if (normalizedSessions.mutatedIds.size > 0) {
      await Promise.all(
        [...normalizedSessions.mutatedIds].map(async (sessionId) => {
          const session = normalizedSessions.sessions.find(
            (entry) => entry.id === sessionId,
          );
          if (session) {
            await this.save(session);
          }
        }),
      );
    }

    return sessions
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((entry) => {
        const session =
          normalizedSessions.sessions.find(
            (normalized) => normalized.id === entry.session.id,
          ) ?? entry.session;
        this.sessionCache.set(session.id, session);
        return session;
      });
  }

  getWorkflowPath(sessionId: string): string {
    return path.join(this.workflowDir, `${sessionId}.md`);
  }

  async loadWorkflow(sessionId: string): Promise<string | null> {
    await this.ensure();
    const workflowPath = this.getWorkflowPath(sessionId);

    if (!(await pathExists(workflowPath))) {
      return null;
    }

    return readFile(workflowPath, 'utf8');
  }

  async appendWorkflowEntry(
    session: SessionRecord,
    title: string,
    lines: string[],
  ): Promise<void> {
    await this.ensure();

    const workflowPath = this.getWorkflowPath(session.id);
    if (!(await pathExists(workflowPath))) {
      const header = [
        '# Artemis Workflow',
        '',
        `Session: ${session.title}`,
        `Session ID: ${session.id}`,
        `Working directory: ${session.cwd}`,
        '',
      ].join('\n');
      await writeFile(workflowPath, `${header}\n`, 'utf8');
    }

    const block = [
      `## ${now()} ${title}`,
      ...lines.map((line) => `- ${line}`),
      '',
    ].join('\n');

    await appendFile(workflowPath, `${block}\n`, 'utf8');
  }

  getEvidencePath(sessionId: string): string {
    return path.join(this.evidenceDir, `${sessionId}.json`);
  }

  private createEmptyEvidenceGraph(sessionId: string): EvidenceGraph {
    return {
      sessionId,
      updatedAt: now(),
      claims: [],
      edges: [],
      conflicts: [],
    };
  }

  private normalizeEvidenceGraph(
    graph: EvidenceGraph,
  ): { graph: EvidenceGraph; mutated: boolean } {
    let mutated = false;
    const validConflicts = Array.isArray(graph.conflicts)
      ? graph.conflicts.filter(
          (entry): entry is EvidenceConflict =>
            Boolean(entry) &&
            typeof entry === 'object' &&
            typeof entry.id === 'string' &&
            Array.isArray(entry.claimIds) &&
            entry.claimIds.length === 2 &&
            typeof entry.claimIds[0] === 'string' &&
            typeof entry.claimIds[1] === 'string' &&
            (entry.reason === 'status_conflict' ||
              entry.reason === 'negation_conflict') &&
            typeof entry.summary === 'string' &&
            typeof entry.createdAt === 'string',
        )
      : [];
    const claims = graph.claims.map((claim) => {
      const statement = canonicalizeClaimStatement(claim.statement);
      const clusterKey = (claim.clusterKey || statement).toLowerCase();

      if (statement !== claim.statement || clusterKey !== claim.clusterKey) {
        mutated = true;
      }

      return {
        ...claim,
        statement,
        clusterKey,
      };
    });
    const synchronized = synchronizeEvidenceGraph({
      ...graph,
      claims,
      conflicts: validConflicts,
    });

    return {
      graph: synchronized.graph,
      mutated: mutated || synchronized.mutated,
    };
  }

  private getEvidenceOwnerId(session: SessionRecord): string {
    return session.rootSessionId ?? session.id;
  }

  private normalizeSession(
    session: SessionRecord,
    sessionMap?: Map<string, SessionRecord>,
  ): { session: SessionRecord; mutated: boolean } {
    let mutated = false;
    const normalizedChangedFiles = uniqueStrings(
      (Array.isArray(session.changedFiles) ? session.changedFiles : [])
        .map(normalizeFilePath)
        .filter(Boolean),
    ).sort();
    const normalizedVerificationCommands = (Array.isArray(session.verificationCommands)
      ? session.verificationCommands
      : []
    )
      .filter(
        (entry): entry is VerificationCommandRecord =>
          Boolean(entry) &&
          typeof entry === 'object' &&
          typeof entry.command === 'string' &&
          typeof entry.ok === 'boolean' &&
          typeof entry.createdAt === 'string',
      )
      .map((entry) => ({
        ...entry,
        command: normalizeCommand(entry.command),
      }));
    const normalizedTasks = (Array.isArray(session.tasks) ? session.tasks : [])
      .filter(
        (entry): entry is TaskItem =>
          Boolean(entry) &&
          typeof entry === 'object' &&
          typeof entry.id === 'string' &&
          typeof entry.content === 'string' &&
          typeof entry.status === 'string',
      )
      .map((entry) => ({
        id: entry.id,
        content: entry.content.trim(),
        status: isTaskStatus(entry.status) ? entry.status : 'pending',
      }))
      .filter((entry) => entry.content.length > 0);
    const normalizedTaskRuntimes = normalizeTaskRuntimeCollection(
      session.taskRuntimes,
    );
    const normalizedHeimdallEvents = normalizeHeimdallEventCollection(
      session.heimdallEvents ??
        ((session as unknown as Record<string, unknown>).harnessEvents),
    );
    const normalizedStickyNativeMcpTools = normalizeStickyNativeMcpTools(
      session.stickyNativeMcpTools,
    );
    const normalizedAutonomyMode = normalizeSessionAutonomyMode(
      session.autonomyMode,
    );
    const {
      harnessEvents: _legacyHarnessEvents,
      ...sessionWithoutLegacyHarness
    } = session as unknown as Record<string, unknown>;
    const nextSession: SessionRecord = {
      ...(sessionWithoutLegacyHarness as SessionRecord),
      autonomyMode: normalizedAutonomyMode,
      plan: Array.isArray(session.plan) ? session.plan : [],
      tasks: normalizedTasks,
      taskRuntimes: normalizedTaskRuntimes,
      summary: typeof session.summary === 'string' ? session.summary : '',
      changedFiles: normalizedChangedFiles,
      verificationCommands: normalizedVerificationCommands,
      stickyNativeMcpTools: normalizedStickyNativeMcpTools,
      heimdallEvents: normalizedHeimdallEvents,
    };

    if (!nextSession.rootSessionId) {
      if (nextSession.parentSessionId && sessionMap?.has(nextSession.parentSessionId)) {
        const resolveRootSessionId = (
          currentId: string,
          seen = new Set<string>(),
        ): string => {
          if (seen.has(currentId)) {
            return currentId;
          }
          seen.add(currentId);
          const current = sessionMap.get(currentId);
          if (!current) {
            return currentId;
          }
          if (current.rootSessionId) {
            return current.rootSessionId;
          }
          if (current.parentSessionId) {
            return resolveRootSessionId(current.parentSessionId, seen);
          }
          return current.id;
        };
        nextSession.rootSessionId = resolveRootSessionId(nextSession.parentSessionId);
      } else if (nextSession.parentSessionId) {
        nextSession.rootSessionId = nextSession.parentSessionId;
      } else {
        nextSession.rootSessionId = nextSession.id;
      }
      mutated = true;
    }

    if (
      !Array.isArray(session.plan) ||
      !Array.isArray(session.tasks) ||
      !Array.isArray(session.taskRuntimes) ||
      typeof session.summary !== 'string' ||
      session.autonomyMode !== normalizedAutonomyMode ||
      !Array.isArray(session.changedFiles) ||
      !Array.isArray(session.verificationCommands) ||
      !Array.isArray(session.stickyNativeMcpTools) ||
      (!Array.isArray(session.heimdallEvents) &&
        !Array.isArray((session as unknown as Record<string, unknown>).harnessEvents)) ||
      !sameTaskArray(session.tasks ?? [], normalizedTasks) ||
      !sameTaskRuntimeArray(session.taskRuntimes ?? [], normalizedTaskRuntimes) ||
      !sameHeimdallEventArray(
        session.heimdallEvents ??
          (Array.isArray((session as unknown as Record<string, unknown>).harnessEvents)
            ? ((session as unknown as Record<string, unknown>)
                .harnessEvents as HeimdallEventRecord[])
            : []),
        normalizedHeimdallEvents,
      ) ||
      !sameStringArray(session.changedFiles ?? [], normalizedChangedFiles) ||
      !sameStringArray(
        session.stickyNativeMcpTools ?? [],
        normalizedStickyNativeMcpTools,
      ) ||
      !sameVerificationCommandArray(
        session.verificationCommands ?? [],
        normalizedVerificationCommands,
      )
    ) {
      mutated = true;
    }

    return {
      session: nextSession,
      mutated,
    };
  }

  private normalizeSessionCollection(
    sessions: SessionRecord[],
  ): { sessions: SessionRecord[]; mutatedIds: Set<string> } {
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const normalized: SessionRecord[] = [];
    const mutatedIds = new Set<string>();

    for (const session of sessions) {
      const result = this.normalizeSession(session, byId);
      normalized.push(result.session);
      if (result.mutated) {
        mutatedIds.add(result.session.id);
      }
      byId.set(result.session.id, result.session);
    }

    return {
      sessions: normalized,
      mutatedIds,
    };
  }

  async loadEvidenceGraph(sessionId: string): Promise<EvidenceGraph> {
    const cached = this.evidenceCache.get(sessionId);
    if (cached) {
      return cached;
    }

    await this.ensure();
    const evidencePath = this.getEvidencePath(sessionId);

    if (!(await pathExists(evidencePath))) {
      const empty = this.createEmptyEvidenceGraph(sessionId);
      this.evidenceCache.set(sessionId, empty);
      return empty;
    }

    const raw = await readFile(evidencePath, 'utf8');
    const normalized = this.normalizeEvidenceGraph(
      JSON.parse(raw) as EvidenceGraph,
    );

    if (normalized.mutated) {
      await this.saveEvidenceGraph(normalized.graph);
    }

    this.evidenceCache.set(normalized.graph.sessionId, normalized.graph);
    return normalized.graph;
  }

  private async saveEvidenceGraph(graph: EvidenceGraph): Promise<void> {
    await this.ensure();
    const normalized = this.normalizeEvidenceGraph(graph).graph;
    normalized.updatedAt = now();
    this.evidenceCache.set(normalized.sessionId, normalized);
    await writeFile(
      this.getEvidencePath(normalized.sessionId),
      JSON.stringify(normalized, null, 2),
      'utf8',
    );
  }

  async upsertEvidenceClaim(
    session: SessionRecord,
    claim: {
      statement: string;
      status: ClaimStatus;
      kind: EvidenceKind;
      sourceSessionId?: string;
      sourceProfile?: 'main' | AgentRole;
    },
  ) {
    const sessionId = this.getEvidenceOwnerId(session);
    const graph = await this.loadEvidenceGraph(sessionId);
    const normalizedStatement = canonicalizeClaimStatement(claim.statement);
    const clusterKey = normalizedStatement.toLowerCase();
    const existing = graph.claims.find(
      (entry) =>
        (entry.clusterKey ||
          canonicalizeClaimStatement(entry.statement).toLowerCase()) ===
          clusterKey &&
        entry.kind === claim.kind &&
        entry.status === claim.status &&
        entry.sourceSessionId === (claim.sourceSessionId ?? session.id),
    );

    if (existing) {
      return existing;
    }

    const nextClaim = {
      id: randomUUID(),
      clusterKey,
      statement: normalizedStatement,
      status: claim.status,
      kind: claim.kind,
      sourceSessionId: claim.sourceSessionId ?? session.id,
      sourceProfile: claim.sourceProfile,
      createdAt: now(),
    };

    graph.claims.push(nextClaim);
    await this.saveEvidenceGraph(graph);
    return nextClaim;
  }

  async addEvidenceEdge(
    session: SessionRecord,
    fromClaimId: string,
    toClaimId: string,
    type: EvidenceEdgeType,
  ): Promise<EvidenceEdge> {
    const sessionId = this.getEvidenceOwnerId(session);
    const graph = await this.loadEvidenceGraph(sessionId);
    const existing = graph.edges.find(
      (entry) =>
        entry.fromClaimId === fromClaimId &&
        entry.toClaimId === toClaimId &&
        entry.type === type,
    );

    if (existing) {
      return existing;
    }

    const edge: EvidenceEdge = {
      id: randomUUID(),
      fromClaimId,
      toClaimId,
      type,
      createdAt: now(),
    };
    graph.edges.push(edge);
    await this.saveEvidenceGraph(graph);
    return edge;
  }
}
