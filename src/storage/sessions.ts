import {
  appendFile,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { removeStaleTempFiles, writeFileAtomic } from './atomicWrite.js';
import { holdsSessionLock, withSessionLock } from './sessionLock.js';
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
  createContextStorage,
  isCompactionBoundary,
  normalizeContextState,
  readFullHistory,
  readHistoryPage,
  type HistoryPage,
  resolveContextBudget,
  spillToolResultIfLarge,
  type ContextStorage,
} from '../core/compaction/index.js';

/** Entries the runtime writes into a history that the user never wrote or saw. */
export function isSyntheticHistoryMessage(message: SessionMessage): boolean {
  return isCompactionBoundary(message) || message.name === 'runtime_context';
}
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

// Intake safety net for tool results appended without a window-aware budget
// (runAgent spills with the active model's budget before appending).
const DEFAULT_INTAKE_BUDGET = resolveContextBudget();

const VALID_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/**
 * Bring a stored message to the current shape. Old session files may lack
 * ids or timestamps, carry non-string content, or use retired roles.
 */
function normalizeStoredMessage(
  raw: unknown,
  index: number,
  fallbackCreatedAt: string,
): { message: SessionMessage | null; mutated: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { message: null, mutated: true };
  }
  const candidate = raw as Record<string, unknown>;
  let mutated = false;
  let role = candidate.role;
  if (role === 'tool_result') {
    role = 'tool';
    mutated = true;
  }
  if (typeof role !== 'string' || !VALID_ROLES.has(role)) {
    return { message: null, mutated: true };
  }
  let content = candidate.content;
  if (typeof content !== 'string') {
    content = content === undefined || content === null
      ? ''
      : Array.isArray(content)
        ? content
          .map((block) => (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
            ? (block as { text: string }).text
            : ''))
          .filter(Boolean)
          .join('\n')
        : JSON.stringify(content);
    mutated = true;
  }
  let id = candidate.id;
  if (typeof id !== 'string' || !id) {
    id = `msg-migrated-${index}-${randomUUID().slice(0, 8)}`;
    mutated = true;
  }
  let createdAt = candidate.createdAt;
  if (typeof createdAt !== 'string' || !createdAt) {
    createdAt = fallbackCreatedAt;
    mutated = true;
  }
  // toolCalls must be an array of { id, name, arguments: string }; drop
  // anything else (old or damaged files held strings and nulls).
  let toolCalls = candidate.toolCalls;
  if (toolCalls !== undefined) {
    const valid = Array.isArray(toolCalls)
      ? toolCalls
        .filter((call): call is Record<string, unknown> =>
          Boolean(call) && typeof call === 'object' && !Array.isArray(call) &&
          typeof (call as Record<string, unknown>).id === 'string' &&
          typeof (call as Record<string, unknown>).name === 'string')
        .map((call) => ({
          id: call.id as string,
          name: call.name as string,
          arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
        }))
      : [];
    if (!Array.isArray(toolCalls) || valid.length !== toolCalls.length ||
      valid.some((call, i) => (toolCalls as Array<Record<string, unknown>>)[i]?.arguments !== call.arguments)) {
      mutated = true;
    }
    toolCalls = valid.length > 0 ? valid : undefined;
  }
  if (!mutated) {
    return { message: raw as SessionMessage, mutated: false };
  }
  const { toolCalls: _rawToolCalls, ...rest } = candidate;
  return {
    message: {
      ...(rest as unknown as SessionMessage),
      id: id as string,
      role: role as SessionMessage['role'],
      content: content as string,
      createdAt: createdAt as string,
      ...(toolCalls ? { toolCalls: toolCalls as SessionMessage['toolCalls'] } : {}),
    },
    mutated: true,
  };
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

/** Messages per `session show` page by default. */
export const DEFAULT_HISTORY_PAGE = 500;
/** Longest message text `session show` returns by default. */
const MAX_SHOWN_CHARS = 100_000;

/** A message a chat UI shows: user or assistant text. */
export function isChatVisibleMessage(message: SessionMessage): boolean {
  return (message.role === 'user' || message.role === 'assistant') &&
    typeof message.content === 'string' && message.content.trim().length > 0;
}

function projectChatMessage(message: SessionMessage): SessionMessage {
  const {
    toolCalls: _toolCalls,
    rawContentBlocks: _raw,
    contentBlocks: _blocks,
    reasoningContent: _reasoning,
    ...rest
  } = message as SessionMessage & { contentBlocks?: unknown; reasoningContent?: unknown };
  const content = rest.content ?? '';
  if (content.length <= MAX_SHOWN_CHARS) return rest as SessionMessage;
  const head = content.slice(0, Math.floor(MAX_SHOWN_CHARS * 0.7));
  const tail = content.slice(content.length - Math.floor(MAX_SHOWN_CHARS * 0.3));
  const omitted = content.length - head.length - tail.length;
  return {
    ...rest,
    content: `${head}\n… [${omitted.toLocaleString('en-US')} chars omitted; full text: artemis session show <id> --full] …\n${tail}`,
  } as SessionMessage;
}

/** A session file that still cannot be parsed after retries (read-only load). */
export class SessionUnreadableError extends Error {
  readonly code = 'session_unreadable';
  constructor(sessionId: string, cause: unknown) {
    super(`Session ${sessionId} could not be read (${cause instanceof Error ? cause.message : String(cause)}).`);
    this.name = 'SessionUnreadableError';
  }
}

type SessionFileRead = { ok: true; record: SessionRecord } | { ok: false; error: unknown };

/** Read and parse a session file, retrying parse errors with a short backoff. ENOENT is thrown. */
async function readSessionFile(filePath: string, attempts: number): Promise<SessionFileRead> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** (attempt - 1)));
    const raw = await readFile(filePath, 'utf8');
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ok: true, record: parsed as SessionRecord };
      }
      lastError = new Error('not a session object');
    } catch (error) {
      lastError = error;
    }
  }
  return { ok: false, error: lastError };
}

export class SessionStore {
  private readonly cwd: string;
  private readonly rootDir: string;
  private readonly sessionDir: string;
  private readonly workflowDir: string;
  private readonly evidenceDir: string;
  private readonly sessionCache = new Map<string, SessionRecord>();
  private readonly evidenceCache = new Map<string, EvidenceGraph>();
  /** Last serialized form written per session, to skip identical rewrites. */
  private readonly lastWritten = new Map<string, string>();
  /** When stale temp files were last swept from the sessions directory. */
  private lastTempSweep = 0;

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

  /** Directory for a session's context files (transcript archive, spilled tool outputs). */
  getContextDir(sessionId: string): string {
    return path.join(this.sessionDir, sessionId);
  }

  /** Advisory lock file for runs on this session (see storage/sessionLock.ts). */
  getLockPath(sessionId: string): string {
    return path.join(this.sessionDir, `${sessionId}.lock`);
  }

  getContextStorage(session: Pick<SessionRecord, 'id'>): ContextStorage {
    return createContextStorage(this.getContextDir(session.id));
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
      // Large tool output goes to a file under the session directory; the
      // history keeps a preview with the path. Nothing is cut silently.
      content: role === 'tool'
        ? spillToolResultIfLarge(content, {
          storage: this.getContextStorage(session),
          toolName: name,
          inlineTokens: DEFAULT_INTAKE_BUDGET.inlineToolResultTokens,
          inlineReadTokens: DEFAULT_INTAKE_BUDGET.inlineReadTokens,
          previewTokens: DEFAULT_INTAKE_BUDGET.toolPreviewTokens,
        }).content
        : content,
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
    this.sessionCache.set(session.id, session);
    // Skip the rewrite (and the search-index sync) when nothing changed since
    // the last write; runAgent saves at many checkpoints per turn.
    const comparable = JSON.stringify({ ...session, updatedAt: '' });
    if (this.lastWritten.get(session.id) === comparable) {
      return;
    }
    session.updatedAt = now();
    // Conversation content: readable by the owner only. Written to a temp
    // file and renamed into place, so a concurrent reader (the web server
    // runs `session show` without the lock) never sees half a file.
    await writeFileAtomic(
      path.join(this.sessionDir, `${session.id}.json`),
      JSON.stringify(session, null, 2),
      { mode: 0o600 },
    );
    this.lastWritten.set(session.id, comparable);
    invalidateSessionSearchCache(this.cwd);
    await syncSessionSearchIndex(this.cwd, session);
  }

  /**
   * Load a session.
   *
   * - `fresh`: read from disk even when cached (another process may have
   *   written it; callers holding the session lock use this).
   * - `readOnly`: never write anything (`artemis session show`). A file
   *   that cannot be parsed raises SessionUnreadableError instead of being
   *   quarantined.
   *
   * A parse error is retried a few times first (a writer from an older
   * version may be mid-write). Only then, and only while holding the
   * session lock, is the file moved aside.
   */
  async load(sessionId: string, options: { fresh?: boolean; readOnly?: boolean } = {}): Promise<SessionRecord> {
    const cached = this.sessionCache.get(sessionId);
    if (cached && !options.fresh) {
      return cached;
    }

    if (!options.readOnly) {
      await this.ensure();
      await this.sweepTempFiles();
    }
    const filePath = path.join(this.sessionDir, `${sessionId}.json`);
    const attempt = await readSessionFile(filePath, 4);
    if (!attempt.ok) {
      if (options.readOnly) {
        throw new SessionUnreadableError(sessionId, attempt.error);
      }
      const lockPath = this.getLockPath(sessionId);
      const quarantineUnderLock = async (): Promise<SessionRecord> => {
        // Re-read under the lock: the writer may have finished meanwhile.
        const again = await readSessionFile(filePath, 2);
        if (again.ok) return this.adoptLoaded(sessionId, again.record);
        return this.quarantine(sessionId, filePath, again.error);
      };
      return holdsSessionLock(lockPath)
        ? quarantineUnderLock()
        : withSessionLock(lockPath, quarantineUnderLock, { label: `Session ${sessionId}` });
    }
    return this.adoptLoaded(sessionId, attempt.record);
  }

  private adoptLoaded(sessionId: string, record: SessionRecord): SessionRecord {
    // The file name is the id; a missing or wrong id inside is repaired.
    if (record.id !== sessionId) record.id = sessionId;
    // Normalized in memory only: loading never writes (the next save does).
    const normalized = this.normalizeSession(record);
    this.sessionCache.set(normalized.session.id, normalized.session);
    return normalized.session;
  }

  /**
   * An unreadable session file must not brick the session: it is moved
   * aside to `<id>.json.corrupt-<time>` (kept for inspection) and a fresh,
   * empty session with the same id takes its place. Called only under the
   * session lock, after re-reading failed.
   */
  private async quarantine(sessionId: string, filePath: string, error: unknown): Promise<SessionRecord> {
    const aside = `${filePath}.corrupt-${Date.now()}`;
    await rename(filePath, aside).catch(() => undefined);
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[session] ${sessionId}: the session file could not be read (${reason}); it was moved to ${aside} and a fresh session was started.\n`,
    );
    const fresh = this.createSession({ title: 'Recovered session' });
    this.sessionCache.delete(fresh.id);
    const recovered: SessionRecord = {
      ...fresh,
      id: sessionId,
      rootSessionId: sessionId,
      metadata: { recoveredFrom: aside, recoveredAt: now() },
    };
    await this.save(recovered);
    return recovered;
  }

  /**
   * Every message of the conversation in order, including the ones moved to
   * the transcript archive by compaction; the compaction boundary and
   * runtime-context entries are left out. This is the user-visible history
   * (`artemis session show`), not what the model is sent.
   */
  async loadFullHistory(session: SessionRecord): Promise<{ messages: SessionMessage[]; archived: number }> {
    return readFullHistory(this.getContextDir(session.id), session.messages, isSyntheticHistoryMessage);
  }

  /**
   * One page of what a chat UI renders (user and assistant text, newest
   * last), read from the end of the archive. Tool messages, tool-call
   * arguments, raw provider blocks and inline images are left out, and a
   * very long text is shortened with a note (`session show --full` has it).
   */
  async loadHistoryPage(
    session: SessionRecord,
    options: { limit?: number; before?: string } = {},
  ): Promise<HistoryPage> {
    return readHistoryPage(this.getContextDir(session.id), session.messages, isSyntheticHistoryMessage, {
      limit: Math.max(1, options.limit ?? DEFAULT_HISTORY_PAGE),
      before: options.before,
      include: isChatVisibleMessage,
      project: projectChatMessage,
    });
  }

  /** Remove a session's context directory (archive, spilled tool outputs). */
  async removeContextDir(sessionId: string): Promise<void> {
    await rm(this.getContextDir(sessionId), { recursive: true, force: true });
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

  /** Leftovers of interrupted atomic writes, at most every ten minutes. */
  private async sweepTempFiles(): Promise<void> {
    if (Date.now() - this.lastTempSweep < 10 * 60_000) return;
    this.lastTempSweep = Date.now();
    await removeStaleTempFiles(this.sessionDir).catch(() => 0);
  }

  async list(): Promise<SessionRecord[]> {
    await this.ensure();
    await this.sweepTempFiles();
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
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        // One damaged file must not hide every other session.
        process.stderr.write(`[session] skipped unreadable session file ${entry}\n`);
        continue;
      }
      sessions.push({
        session: { ...(parsed as SessionRecord), id: (parsed as SessionRecord).id || entry.slice(0, -5) },
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
    // Messages: old files may hold malformed entries; keep every usable one.
    let messagesMutated = !Array.isArray(session.messages);
    const fallbackCreatedAt =
      typeof session.createdAt === 'string' && session.createdAt ? session.createdAt : now();
    const normalizedMessages: SessionMessage[] = [];
    (Array.isArray(session.messages) ? session.messages : []).forEach((entry, index) => {
      const result = normalizeStoredMessage(entry, index, fallbackCreatedAt);
      if (result.mutated) messagesMutated = true;
      if (result.message) normalizedMessages.push(result.message);
    });
    // Context-management state lives in metadata.context; repair it in place.
    let metadata = session.metadata;
    if (metadata && typeof metadata === 'object' && 'context' in metadata) {
      const normalizedContext = normalizeContextState(metadata.context);
      if (JSON.stringify(normalizedContext) !== JSON.stringify(metadata.context)) {
        metadata = { ...metadata, context: normalizedContext };
        mutated = true;
      }
    }
    if (messagesMutated) mutated = true;
    const {
      harnessEvents: _legacyHarnessEvents,
      ...sessionWithoutLegacyHarness
    } = session as unknown as Record<string, unknown>;
    const nextSession: SessionRecord = {
      ...(sessionWithoutLegacyHarness as SessionRecord),
      messages: messagesMutated ? normalizedMessages : session.messages,
      ...(metadata !== session.metadata ? { metadata } : {}),
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
