/* eslint-disable @typescript-eslint/no-unused-vars */
import { pickLocale, type UiLocale } from '../cli/locale.js';
import { buildPanel } from '../cli/ui.js';
import type { SessionRecord } from '../core/types.js';
import {
  type HeimdallEventEnvelope,
} from '../core/heimdall.js';
import { SessionStore } from '../storage/sessions.js';
import {
  approveHeimdallBlocking,
  deleteHeimdallThreadData,
  followHeimdallEventStream,
  getHeimdallEventStreamResponse,
  getHeimdallThreadCatalogResponse,
  getHeimdallThreadSnapshot,
  ingestHeimdallThreadUploads,
  listHeimdallThreads,
  replyHeimdallClarification,
  unblockHeimdallThread,
  type HeimdallThreadCatalogEntry,
  type HeimdallThreadSnapshot,
} from './heimdallGateway.js';

export {
  deleteHeimdallThreadData,
  getHeimdallThreadSnapshot,
  listHeimdallThreads,
} from './heimdallGateway.js';

export type HeimdallCommandAction =
  | 'show'
  | 'threads'
  | 'events'
  | 'follow'
  | 'upload'
  | 'cleanup'
  | 'reply'
  | 'approve'
  | 'unblock';

export type HeimdallCommandBody = {
  action: HeimdallCommandAction;
  sessionId?: string;
  useLastSession: boolean;
  limit?: number;
  afterOffset?: number;
  timeoutSeconds?: number;
  replyText?: string;
  outputFormat: 'panel' | 'json';
  rest: string[];
};

function looksLikeSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value.trim(),
  );
}

function toPositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseHeimdallCommandBody(
  input: string | undefined,
): HeimdallCommandBody {
  const tokens = (input ?? '').trim().split(/\s+/).filter(Boolean);
  let action: HeimdallCommandAction = 'show';
  let sessionId: string | undefined;
  let useLastSession = false;
  let limit: number | undefined;
  let afterOffset: number | undefined;
  let timeoutSeconds: number | undefined;
  let outputFormat: 'panel' | 'json' = 'panel';
  const rest: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    const lower = token.toLowerCase();

    if (lower === 'show' || lower === 'status') {
      action = 'show';
      continue;
    }
    if (lower === 'threads' || lower === 'list') {
      action = 'threads';
      continue;
    }
    if (lower === 'events' || lower === 'event-log' || lower === 'log') {
      action = 'events';
      continue;
    }
    if (lower === 'follow' || lower === 'stream' || lower === 'tail') {
      action = 'follow';
      continue;
    }
    if (lower === 'upload' || lower === 'uploads' || lower === 'ingest' || lower === 'import') {
      action = 'upload';
      continue;
    }
    if (lower === 'cleanup' || lower === 'delete' || lower === 'clear') {
      action = 'cleanup';
      continue;
    }
    if (lower === 'reply' || lower === 'respond' || lower === 'answer') {
      action = 'reply';
      continue;
    }
    if (lower === 'approve' || lower === 'allow') {
      action = 'approve';
      continue;
    }
    if (lower === 'unblock' || lower === 'close' || lower === 'reopen') {
      action = 'unblock';
      continue;
    }
    if (lower === '--last') {
      useLastSession = true;
      continue;
    }
    if (lower === '--tail' || lower === '--limit' || lower === '-n') {
      const parsed = toPositiveInteger(tokens[index + 1]);
      if (parsed) {
        limit = parsed;
        index += 1;
        continue;
      }
      rest.push(token);
      continue;
    }
    if (lower === '--after' || lower === '--cursor') {
      const parsed = toPositiveInteger(tokens[index + 1]);
      if (parsed !== undefined) {
        afterOffset = parsed;
        index += 1;
        continue;
      }
    }
    if (lower === '--timeout' || lower === '-t') {
      const parsed = toPositiveInteger(tokens[index + 1]);
      if (parsed) {
        timeoutSeconds = parsed;
        index += 1;
        continue;
      }
    }
    if (lower === '--json' || lower === 'json') {
      outputFormat = 'json';
      continue;
    }
    if (!sessionId && looksLikeSessionId(token)) {
      sessionId = token;
      continue;
    }
    if ((action === 'events' || action === 'threads') && limit === undefined) {
      const parsed = toPositiveInteger(token);
      if (parsed) {
        limit = parsed;
        continue;
      }
    }
    if ((action === 'events' || action === 'follow') && afterOffset === undefined) {
      const parsed = toPositiveInteger(token);
      if (parsed !== undefined) {
        afterOffset = parsed;
        continue;
      }
    }
    rest.push(token);
  }

  if (action === 'events') {
    limit = Math.max(1, limit ?? 12);
  }
  if (action === 'threads') {
    limit = Math.max(1, limit ?? 12);
  }
  if (action === 'follow') {
    limit = Math.max(1, limit ?? 12);
    timeoutSeconds = Math.max(1, timeoutSeconds ?? 30);
  }

  const replyText = action === 'reply' && rest.length > 0 ? rest.join(' ') : undefined;

  return {
    action,
    sessionId,
    useLastSession,
    limit,
    afterOffset,
    timeoutSeconds,
    replyText,
    outputFormat,
    rest,
  };
}

function formatHeimdallEventLine(
  envelope: HeimdallEventEnvelope,
): string {
  const suffixes: string[] = [];
  if (envelope.event.workflowMode) {
    suffixes.push(`workflow=${envelope.event.workflowMode}`);
  }
  if (envelope.event.runtimeId) {
    suffixes.push(`runtime=${envelope.event.runtimeId}`);
  }
  if (envelope.event.status) {
    suffixes.push(`status=${envelope.event.status}`);
  }
  if (envelope.event.role) {
    suffixes.push(`role=${envelope.event.role}`);
  }
  return [
    `${envelope.event.createdAt} ${envelope.event.kind}`,
    envelope.event.summary,
    suffixes.length > 0 ? `[${suffixes.join(' ')}]` : '',
  ]
    .filter(Boolean)
    .join(' :: ');
}

function formatHeimdallArtifactLine(
  artifact: HeimdallThreadSnapshot['recentArtifacts'][number],
): string {
  return `${artifact.kind} :: ${artifact.path} :: source=${artifact.source} :: updated=${artifact.updatedAt}`;
}

export async function buildHeimdallOverviewLines(options: {
  cwd: string;
  session: SessionRecord;
}): Promise<string[]> {
  const snapshot = await getHeimdallThreadSnapshot(options);
  return [
    `Heimdall root: ${snapshot.threadRoot}`,
    `Heimdall state: ${snapshot.statePath}${snapshot.stateExists ? '' : ' (pending)'}`,
    `Heimdall event log: ${snapshot.eventLogPath}${snapshot.eventLogExists ? '' : ' (pending)'}`,
    `Heimdall uploads manifest: ${snapshot.uploadManifestPath}${snapshot.uploadManifestExists ? '' : ' (pending)'}`,
    `Heimdall artifacts manifest: ${snapshot.artifactManifestPath}${snapshot.artifactManifestExists ? '' : ' (pending)'}`,
    `Heimdall title: ${snapshot.sessionTitle}`,
    `Heimdall summary chars: ${snapshot.sessionSummaryChars}`,
    `Heimdall blocking: ${snapshot.blockingStatus} :: ${snapshot.blockingReason}`,
    `Heimdall clarification: ${snapshot.clarificationStatus} :: ${snapshot.clarificationReason}`,
    `Heimdall media: total=${snapshot.mediaTotalCount} images=${snapshot.mediaImageCount} docs=${snapshot.mediaDocumentCount} av=${snapshot.mediaAudioVideoCount}`,
    `Heimdall virtual mounts: workspace=${snapshot.virtualMounts.workspace} uploads=${snapshot.virtualMounts.uploads} outputs=${snapshot.virtualMounts.outputs} artifacts=${snapshot.virtualMounts.artifacts}`,
    `Heimdall stage: ${snapshot.lastStage ?? 'not yet recorded'}`,
    `Heimdall last event: ${snapshot.lastEventKind ?? 'not yet recorded'}`,
    `Heimdall sandbox: ${snapshot.sandboxProviderId ?? 'none'}${snapshot.sandboxMode ? `/${snapshot.sandboxMode}` : ''}`,
    `Heimdall isolation: fs=${snapshot.sandboxFilesystemIsolation ?? false} net=${snapshot.sandboxNetworkIsolation ?? false}`,
    `Heimdall active runtimes: ${snapshot.activeRuntimeCount}`,
    `Heimdall event count: ${snapshot.eventCount}`,
    `Heimdall tasks/plans: ${snapshot.taskCount}/${snapshot.planCount}`,
    `Heimdall artifacts: ${snapshot.artifactCount}`,
    `Heimdall uploads: ${snapshot.uploadCount}`,
    `Heimdall changed files: ${snapshot.changedFileCount}`,
    `Heimdall verification runs: ${snapshot.verificationCommandCount}`,
    `Heimdall middleware: ${snapshot.middlewareCount} :: ${snapshot.middlewareIds.join(', ') || 'none'}`,
  ];
}

export async function buildHeimdallThreadsReport(options: {
  cwd: string;
  locale?: UiLocale;
  limit?: number;
}): Promise<string> {
  const locale = options.locale ?? 'en';
  const t = (zh: string, en: string) => pickLocale(locale, { zh, en });
  const payload = await getHeimdallThreadCatalogResponse(options);
  const entries = payload.threads;
  return buildPanel(
    t('Heimdall 线程目录', 'Heimdall thread catalog'),
    entries.length > 0
      ? entries.map(
          (entry) =>
            `${entry.rootSessionId} :: stage=${entry.lastStage ?? 'n/a'} :: event=${entry.lastEventKind ?? 'n/a'} :: blocking=${entry.blockingStatus} :: clarification=${entry.clarificationStatus} :: runtimes=${entry.activeRuntimeCount} :: artifacts=${entry.artifactCount} :: uploads=${entry.uploadCount} :: media=${entry.mediaTotalCount}`,
        )
      : [
          t(
            '当前还没有任何 Heimdall 线程目录。',
            'No Heimdall thread directories have been created yet.',
          ),
        ],
  );
}

export async function buildHeimdallReport(options: {
  cwd: string;
  session: SessionRecord;
  sessionStore?: SessionStore;
  locale?: UiLocale;
  action?: HeimdallCommandAction;
  limit?: number;
  afterOffset?: number;
  timeoutSeconds?: number;
  replyText?: string;
  inputPaths?: string[];
}): Promise<string> {
  const locale = options.locale ?? 'en';
  const t = (zh: string, en: string) => pickLocale(locale, { zh, en });
  const action = options.action ?? 'show';

  if (action === 'threads') {
    return buildHeimdallThreadsReport({
      cwd: options.cwd,
      locale,
      limit: options.limit,
    });
  }

  if (action === 'cleanup') {
    const rootSessionId = options.session.rootSessionId ?? options.session.id;
    const result = await deleteHeimdallThreadData({
      cwd: options.cwd,
      rootSessionId,
    });
    return buildPanel(
      t('Heimdall 线程清理', 'Heimdall thread cleanup'),
      [
        `Session: ${options.session.id}`,
        `Root session: ${rootSessionId}`,
        `Thread root: ${result.threadRoot}`,
        t(
          result.removed ? '结果: 已删除线程目录。' : '结果: 没有找到线程目录。',
          result.removed
            ? 'Result: thread directory removed.'
            : 'Result: no thread directory was present.',
        ),
      ],
    );
  }

  if (action === 'events') {
    const snapshot = await getHeimdallThreadSnapshot(options);
    const window = await getHeimdallEventStreamResponse({
      cwd: options.cwd,
      session: options.session,
      afterOffset: options.afterOffset,
      limit: options.limit,
    });
    return buildPanel(
      t('Heimdall 事件流', 'Heimdall event stream'),
      [
        `Session: ${options.session.id}`,
        `Root session: ${snapshot.rootSessionId}`,
        `Thread root: ${snapshot.threadRoot}`,
        `Event log: ${snapshot.eventLogPath}`,
        `Cursor: ${window.cursor.offset}`,
        `${t('显示条目', 'Showing')}: ${window.events.length}/${snapshot.eventCount}`,
        ...(window.events.length > 0
          ? ['', ...window.events.map(formatHeimdallEventLine)]
          : [
              '',
              t(
                '当前还没有记录任何 Heimdall 事件。',
                'No Heimdall events have been recorded yet.',
              ),
            ]),
      ],
    );
  }

  if (action === 'follow') {
    const snapshot = await getHeimdallThreadSnapshot(options);
    const result = await followHeimdallEventStream({
      cwd: options.cwd,
      session: options.session,
      afterOffset: options.afterOffset,
      limit: options.limit,
      timeoutSeconds: options.timeoutSeconds,
    });
    return buildPanel(
      t('Heimdall 事件跟随', 'Heimdall event follow'),
      [
        `Session: ${options.session.id}`,
        `Root session: ${snapshot.rootSessionId}`,
        `Thread root: ${snapshot.threadRoot}`,
        `Event log: ${snapshot.eventLogPath}`,
        `Cursor: ${result.cursor.offset}`,
        `Timed out: ${result.timedOut}`,
        ...(result.events.length > 0
          ? ['', ...result.events.map(formatHeimdallEventLine)]
          : [
              '',
              t(
                '在等待窗口内没有新的 Heimdall 事件。',
                'No new Heimdall events arrived within the wait window.',
              ),
            ]),
      ],
    );
  }

  if (action === 'upload') {
    const ingestion = await ingestHeimdallThreadUploads({
      cwd: options.cwd,
      session: options.session,
      sessionStore: options.sessionStore,
      inputPaths: options.inputPaths ?? [],
    });
    return buildPanel(
      t('Heimdall 上传摄入', 'Heimdall upload ingestion'),
      [
        `Session: ${options.session.id}`,
        `Imported: ${ingestion.imported.length}`,
        `Skipped: ${ingestion.skipped.length}`,
        ...(ingestion.imported.length > 0
          ? [
              '',
              t('已导入上传', 'Imported uploads'),
              ...ingestion.imported.map(
                (upload) =>
                  `${upload.filename} :: ${upload.storedPath} :: ${upload.sizeBytes ?? 0} bytes`,
              ),
            ]
          : []),
        ...(ingestion.skipped.length > 0
          ? [
              '',
              t('已跳过', 'Skipped'),
              ...ingestion.skipped.map(
                (entry) => `${entry.inputPath} :: ${entry.reason}`,
              ),
            ]
          : []),
        ...(ingestion.imported.length === 0 && ingestion.skipped.length === 0
          ? [
              '',
              t(
                '用法: heimdall upload <path...>',
                'Usage: heimdall upload <path...>',
              ),
            ]
          : []),
      ],
    );
  }

  if (action === 'approve') {
    const result = await approveHeimdallBlocking(options);
    return buildPanel(
      t('Heimdall 审批', 'Heimdall approve'),
      [
        `Session: ${options.session.id}`,
        `Root session: ${result.rootSessionId}`,
        `Updated: ${result.updated}`,
        `Previous blocking: ${result.previousBlockingStatus ?? 'n/a'}`,
        `Blocking now: ${result.blockingStatus ?? 'n/a'}`,
        result.message,
      ],
    );
  }

  if (action === 'unblock') {
    const result = await unblockHeimdallThread(options);
    return buildPanel(
      t('Heimdall 解除阻塞', 'Heimdall unblock'),
      [
        `Session: ${options.session.id}`,
        `Root session: ${result.rootSessionId}`,
        `Updated: ${result.updated}`,
        `Previous blocking: ${result.previousBlockingStatus ?? 'n/a'}`,
        `Blocking now: ${result.blockingStatus ?? 'n/a'}`,
        result.message,
      ],
    );
  }

  if (action === 'reply') {
    const text = options.replyText ?? '';
    const result = await replyHeimdallClarification({
      cwd: options.cwd,
      session: options.session,
      replyText: text,
    });
    return buildPanel(
      t('Heimdall 回复', 'Heimdall reply'),
      [
        `Session: ${options.session.id}`,
        `Root session: ${result.rootSessionId}`,
        `Updated: ${result.updated}`,
        `Previous clarification: ${result.previousClarificationStatus ?? 'n/a'}`,
        `Clarification now: ${result.clarificationStatus ?? 'n/a'}`,
        text ? `Reply text: ${text.slice(0, 120)}` : t('无回复文本', 'No reply text provided'),
        result.message,
      ],
    );
  }

  const snapshot = await getHeimdallThreadSnapshot(options);

  return buildPanel(
    t('Heimdall 线程控制面', 'Heimdall thread control plane'),
    [
      `Session: ${options.session.id}`,
      ...(await buildHeimdallOverviewLines(options)),
      ...(snapshot.artifactCount > 0
        ? [
            '',
            t('最近产物', 'Recent artifacts'),
            ...snapshot.recentArtifacts.map(formatHeimdallArtifactLine),
          ]
        : []),
    ],
  );
}
