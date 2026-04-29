import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { buildVerificationChecklist } from './evidence.js';
import type {
  AgentAction,
  EvidenceGraph,
  SessionMessage,
  SessionRecord,
} from './types.js';
import { SessionStore } from '../storage/sessions.js';
import { pathExists } from '../utils/fs.js';

const VERIFICATION_PATTERNS = [
  /\b(tsc|typecheck|type-check)\b/i,
  /\b(eslint|lint|ruff|mypy)\b/i,
  /\b(test|jest|vitest|pytest|playwright|cypress)\b/i,
  /\b(cargo check|cargo test|go test|dotnet test)\b/i,
  /\b(check)\b/i,
];

type PackageJson = {
  packageManager?: string;
  scripts?: Record<string, string>;
};

type ScriptRunner = 'npm' | 'pnpm' | 'yarn' | 'bun';
type VerificationCheckPriority = 'high' | 'medium' | 'low';
type VerificationCheckKind = 'command' | 'inspection';
type VerificationCheck = {
  key: string;
  summary: string;
  rationale: string;
  priority: VerificationCheckPriority;
  kind: VerificationCheckKind;
  command?: string;
  covers?: string[];
};
type RenameIntent = {
  from: string;
  to: string;
};
type VerificationHistory = {
  passed: string[];
  failed: string[];
};
type VerificationPlan = {
  sessionId: string;
  relatedSessionIds: string[];
  changedFiles: string[];
  renameIntents: RenameIntent[];
  checks: VerificationCheck[];
  completedCommands: string[];
  notes: string[];
};

function addSuggestion(suggestions: string[], command: string): void {
  if (!suggestions.includes(command)) {
    suggestions.push(command);
  }
}

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim();
}

function normalizeFilePath(inputPath: string): string {
  return inputPath.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function clip(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars - 3)}...`;
}

function uniq<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function parseToolMessage(
  message: SessionMessage,
): { action?: AgentAction; ok?: boolean } | null {
  if (message.role !== 'tool') {
    return null;
  }

  try {
    return JSON.parse(message.content) as { action?: AgentAction; ok?: boolean };
  } catch {
    return null;
  }
}

function parsePatchPaths(patch: string): string[] {
  const paths: string[] = [];

  for (const rawLine of patch.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (
      line.startsWith('*** Update File: ') ||
      line.startsWith('*** Add File: ') ||
      line.startsWith('*** Delete File: ') ||
      line.startsWith('*** Move to: ')
    ) {
      paths.push(normalizeFilePath(line.split(': ')[1] ?? ''));
    }
  }

  return paths.filter(Boolean);
}

function parsePatchRenameIntents(patch: string): RenameIntent[] {
  const intents: RenameIntent[] = [];
  let currentPath: string | null = null;

  for (const rawLine of patch.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (
      line.startsWith('*** Update File: ') ||
      line.startsWith('*** Add File: ') ||
      line.startsWith('*** Delete File: ')
    ) {
      currentPath = normalizeFilePath(line.split(': ')[1] ?? '');
      continue;
    }

    if (line.startsWith('*** Move to: ')) {
      const nextPath = normalizeFilePath(line.split(': ')[1] ?? '');
      if (currentPath && nextPath && currentPath !== nextPath) {
        intents.push({
          from: currentPath,
          to: nextPath,
        });
      }
      currentPath = nextPath || currentPath;
    }
  }

  return intents;
}

function extractActionPaths(action: AgentAction): string[] {
  switch (action.type) {
    case 'write_file':
    case 'insert_in_file':
    case 'replace_in_file':
      return [normalizeFilePath(action.path)];
    case 'apply_patch':
      return parsePatchPaths(action.patch);
    default:
      return [];
  }
}

export function getChangedFilesForAction(action: AgentAction): string[] {
  return extractActionPaths(action);
}

function collectChangedFiles(sessions: SessionRecord[]): string[] {
  const changedFiles: string[] = sessions.flatMap(
    (session) => session.changedFiles ?? [],
  );

  for (const session of sessions) {
    for (const message of session.messages) {
      const parsed = parseToolMessage(message);
      if (!parsed?.action || parsed.ok !== true || !isWriteAction(parsed.action)) {
        continue;
      }

      changedFiles.push(...extractActionPaths(parsed.action));
    }
  }

  return uniq(changedFiles).sort();
}

function collectVerificationHistory(
  sessions: SessionRecord[],
): VerificationHistory {
  const passed: string[] = [];
  const failed: string[] = [];

  for (const session of sessions) {
    for (const entry of session.verificationCommands ?? []) {
      if (entry.ok) {
        passed.push(normalizeCommand(entry.command));
      } else {
        failed.push(normalizeCommand(entry.command));
      }
    }
  }

  for (const session of sessions) {
    for (const message of session.messages) {
      const parsed = parseToolMessage(message);
      if (
        parsed?.action?.type !== 'run_command' ||
        !isVerificationCommand(parsed.action.command)
      ) {
        continue;
      }

      const normalized = normalizeCommand(parsed.action.command);
      if (parsed.ok === true) {
        passed.push(normalized);
      } else {
        failed.push(normalized);
      }
    }
  }

  return {
    passed: uniq(passed),
    failed: uniq(failed),
  };
}

function collectUserInputs(sessions: SessionRecord[]): string[] {
  const inputs: string[] = [];

  for (const session of sessions) {
    for (const message of session.messages) {
      if (message.role !== 'user') {
        continue;
      }

      const normalized = message.content.trim();
      if (normalized) {
        inputs.push(normalized);
      }
    }
  }

  return uniq(inputs);
}

function looksLikeRenameToken(token: string): boolean {
  return /^[A-Za-z0-9_./-]{2,120}$/.test(token);
}

function collectRenameIntents(sessions: SessionRecord[]): RenameIntent[] {
  const intents: RenameIntent[] = [];
  const texts = collectUserInputs(sessions);
  const renamePattern =
    /\brename\s+["'`]?([A-Za-z0-9_./-]{2,120})["'`]?\s+to\s+["'`]?([A-Za-z0-9_./-]{2,120})["'`]?\b/gi;

  for (const text of texts) {
    let match: RegExpExecArray | null;
    while ((match = renamePattern.exec(text)) !== null) {
      const from = match[1]?.trim();
      const to = match[2]?.trim();
      if (
        from &&
        to &&
        from !== to &&
        looksLikeRenameToken(from) &&
        looksLikeRenameToken(to)
      ) {
        intents.push({ from, to });
      }
    }
  }

  for (const session of sessions) {
    for (const message of session.messages) {
      const parsed = parseToolMessage(message);
      if (parsed?.action?.type === 'apply_patch' && parsed.ok === true) {
        intents.push(...parsePatchRenameIntents(parsed.action.patch));
      }

      if (
        parsed?.action?.type !== 'replace_in_file' ||
        parsed.ok !== true ||
        parsed.action.replaceAll !== true
      ) {
        continue;
      }

      const from = parsed.action.find.trim();
      const to = parsed.action.replace.trim();
      if (
        from &&
        to &&
        from !== to &&
        looksLikeRenameToken(from) &&
        looksLikeRenameToken(to)
      ) {
        intents.push({ from, to });
      }
    }
  }

  const seen = new Set<string>();
  return intents.filter((intent) => {
    const key = `${intent.from}=>${intent.to}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function addCheck(checks: VerificationCheck[], nextCheck: VerificationCheck): void {
  if (
    checks.some(
      (entry) =>
        entry.key === nextCheck.key ||
        (entry.command && nextCheck.command && entry.command === nextCheck.command) ||
        entry.summary === nextCheck.summary,
    )
  ) {
    return;
  }

  checks.push(nextCheck);
}

function hasCliSurfaceChanges(changedFiles: string[]): boolean {
  return changedFiles.some(
    (filePath) =>
      filePath === 'src/index.ts' ||
      filePath.startsWith('src/cli/') ||
      filePath.startsWith('bin/'),
  );
}

function hasVerificationSurfaceChanges(changedFiles: string[]): boolean {
  return hasWorkflowSurfaceChanges(changedFiles);
}

function hasWorkflowSurfaceChanges(changedFiles: string[]): boolean {
  return changedFiles.some(
    (filePath) =>
      filePath.startsWith('src/core/evidence') ||
      filePath.startsWith('src/core/verification') ||
      filePath.startsWith('src/core/athena') ||
      filePath.startsWith('src/core/design') ||
      filePath.startsWith('src/core/nidhogg') ||
      filePath.startsWith('src/core/workflow') ||
      filePath.startsWith('src/core/instructionFile') ||
      filePath.startsWith('src/core/promptCache') ||
      filePath.startsWith('src/storage/sessions') ||
      filePath.startsWith('src/channels/runtime') ||
      filePath.startsWith('src/cli/interactive') ||
      filePath.startsWith('src/cli/runCli'),
  );
}

function hasRuntimeSurfaceChanges(changedFiles: string[]): boolean {
  return changedFiles.some(
    (filePath) =>
      filePath.startsWith('src/tools/') ||
      filePath.startsWith('src/security/') ||
      filePath.startsWith('src/core/agent') ||
      filePath.startsWith('src/core/agentProfiles') ||
      filePath.startsWith('src/core/systemPrompt') ||
      filePath.startsWith('src/core/providerNativeTools') ||
      filePath.startsWith('src/telegram/bridge') ||
      filePath.startsWith('src/channels/runtime'),
  );
}

function hasReleaseSurfaceChanges(changedFiles: string[]): boolean {
  return changedFiles.some(
    (filePath) =>
      filePath === 'package.json' ||
      filePath === 'package-lock.json' ||
      filePath === 'README.md' ||
      filePath.startsWith('bin/') ||
      filePath === 'src/index.ts' ||
      filePath.startsWith('src/cli/') ||
      filePath.startsWith('scripts/releaseSmoke'),
  );
}

function shouldSuggestTypecheck(changedFiles: string[]): boolean {
  if (changedFiles.length === 0) {
    return true;
  }

  return changedFiles.some((filePath) =>
    /(?:^|\/)(?:tsconfig(?:\.[^./]+)?|package\.json|package-lock\.json|eslint\.config\.(?:js|mjs|cjs)|\.eslintrc(?:\.[^./]+)?)$/i.test(
      filePath,
    ) || /\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i.test(filePath),
  );
}

function shouldSuggestCargoChecks(changedFiles: string[]): boolean {
  if (changedFiles.length === 0) {
    return true;
  }

  return changedFiles.some(
    (filePath) => filePath === 'Cargo.toml' || /\.rs$/i.test(filePath),
  );
}

function shouldSuggestGoChecks(changedFiles: string[]): boolean {
  if (changedFiles.length === 0) {
    return true;
  }

  return changedFiles.some(
    (filePath) => filePath === 'go.mod' || /\.go$/i.test(filePath),
  );
}

function shouldSuggestPythonChecks(changedFiles: string[]): boolean {
  if (changedFiles.length === 0) {
    return true;
  }

  return changedFiles.some(
    (filePath) =>
      filePath === 'pyproject.toml' ||
      filePath === 'requirements.txt' ||
      /\.py$/i.test(filePath),
  );
}

function summarizeCoverage(changedFiles: string[], maxItems = 4): string[] {
  return changedFiles.slice(0, maxItems);
}

function buildSuggestionRationale(
  suggestion: string,
  changedFiles: string[],
): string {
  if (/\btest:workflow-smoke\b/i.test(suggestion)) {
    return `Workflow coordination surfaces changed: ${summarizeCoverage(changedFiles).join(', ') || 'workflow files'}.`;
  }

  if (/\btest:runtime-smoke\b/i.test(suggestion)) {
    return `Runtime tool or permission surfaces changed: ${summarizeCoverage(changedFiles).join(', ') || 'runtime files'}.`;
  }

  if (/\btest:release-smoke\b/i.test(suggestion)) {
    return `CLI or release-facing surfaces changed: ${summarizeCoverage(changedFiles).join(', ') || 'release files'}.`;
  }

  if (/\b(tsc|typecheck|type-check)\b/i.test(suggestion)) {
    return `TypeScript-facing files changed: ${summarizeCoverage(changedFiles).join(', ') || 'repo sources'}.`;
  }

  if (/\b(eslint|lint|ruff|mypy)\b/i.test(suggestion)) {
    return `Cross-file edits need a fast structural lint pass over ${changedFiles.length || 'current'} changed file(s).`;
  }

  if (/\b(test|jest|vitest|pytest|playwright|cypress|check)\b/i.test(suggestion)) {
    return 'Behavior changed enough that at least one automated regression pass should run before sign-off.';
  }

  return 'It is the most relevant automated verifier detected from project metadata.';
}

function buildFallbackChecks(graph: EvidenceGraph): VerificationCheck[] {
  const fallback = buildVerificationChecklist(graph)
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.replace(/^\d+\.\s*/, '').trim())
    .filter(Boolean);

  return fallback.slice(0, 4).map((item, index) => ({
    key: `fallback-${index + 1}`,
    summary: item,
    rationale: 'Derived from the current evidence graph because no stronger verifier was inferred.',
    priority: 'medium',
    kind: 'inspection',
  }));
}

function getRunScriptCommand(runner: ScriptRunner, script: string): string {
  switch (runner) {
    case 'pnpm':
      return `pnpm ${script}`;
    case 'yarn':
      return `yarn ${script}`;
    case 'bun':
      return `bun run ${script}`;
    case 'npm':
    default:
      return script === 'test' ? 'npm test' : `npm run ${script}`;
  }
}

async function detectNodeRunner(
  cwd: string,
  packageJson: PackageJson | null,
): Promise<ScriptRunner> {
  const manager = packageJson?.packageManager?.toLowerCase() ?? '';

  if (manager.startsWith('pnpm')) {
    return 'pnpm';
  }

  if (manager.startsWith('yarn')) {
    return 'yarn';
  }

  if (manager.startsWith('bun')) {
    return 'bun';
  }

  if (await pathExists(path.join(cwd, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }

  if (await pathExists(path.join(cwd, 'yarn.lock'))) {
    return 'yarn';
  }

  if (
    await pathExists(path.join(cwd, 'bun.lockb')) ||
    await pathExists(path.join(cwd, 'bun.lock'))
  ) {
    return 'bun';
  }

  return 'npm';
}

async function loadPackageJson(cwd: string): Promise<PackageJson | null> {
  const packageJsonPath = path.join(cwd, 'package.json');
  if (!(await pathExists(packageJsonPath))) {
    return null;
  }

  try {
    return JSON.parse(
      await readFile(packageJsonPath, 'utf8'),
    ) as PackageJson;
  } catch {
    return null;
  }
}

export function isWriteAction(action: AgentAction): boolean {
  return (
    action.type === 'write_file' ||
    action.type === 'insert_in_file' ||
    action.type === 'replace_in_file' ||
    action.type === 'apply_patch'
  );
}

export function isVerificationCommand(command: string): boolean {
  return VERIFICATION_PATTERNS.some((pattern) => pattern.test(command));
}

export async function getVerificationSuggestions(
  cwd: string,
  changedFiles: string[] = [],
): Promise<string[]> {
  const suggestions: string[] = [];
  const packageJson = await loadPackageJson(cwd);
  const useMinimalPlan = changedFiles.length > 0;

  if (packageJson) {
    const scripts = packageJson.scripts ?? {};
    const runner = await detectNodeRunner(cwd, packageJson);

    if (shouldSuggestTypecheck(changedFiles) && typeof scripts.typecheck === 'string') {
      addSuggestion(suggestions, getRunScriptCommand(runner, 'typecheck'));
    } else if (
      shouldSuggestTypecheck(changedFiles) &&
      await pathExists(path.join(cwd, 'tsconfig.json'))
    ) {
      addSuggestion(suggestions, 'npx tsc --noEmit');
    }

    let targetedTestsAdded = false;

    if (useMinimalPlan) {
      if (
        hasWorkflowSurfaceChanges(changedFiles) &&
        typeof scripts['test:workflow-smoke'] === 'string'
      ) {
        addSuggestion(
          suggestions,
          getRunScriptCommand(runner, 'test:workflow-smoke'),
        );
        targetedTestsAdded = true;
      }

      if (
        hasRuntimeSurfaceChanges(changedFiles) &&
        typeof scripts['test:runtime-smoke'] === 'string'
      ) {
        addSuggestion(
          suggestions,
          getRunScriptCommand(runner, 'test:runtime-smoke'),
        );
        targetedTestsAdded = true;
      }

      if (
        (hasCliSurfaceChanges(changedFiles) || hasReleaseSurfaceChanges(changedFiles)) &&
        typeof scripts['test:release-smoke'] === 'string'
      ) {
        addSuggestion(
          suggestions,
          getRunScriptCommand(runner, 'test:release-smoke'),
        );
        targetedTestsAdded = true;
      }
    }

    if (!useMinimalPlan || !targetedTestsAdded) {
      if (typeof scripts.lint === 'string') {
        addSuggestion(suggestions, getRunScriptCommand(runner, 'lint'));
      } else if (
        await pathExists(path.join(cwd, '.eslintrc')) ||
        await pathExists(path.join(cwd, '.eslintrc.json')) ||
        await pathExists(path.join(cwd, '.eslintrc.js')) ||
        await pathExists(path.join(cwd, 'eslint.config.js')) ||
        await pathExists(path.join(cwd, 'eslint.config.mjs'))
      ) {
        addSuggestion(suggestions, 'npx eslint . --quiet');
      }

      if (typeof scripts.test === 'string') {
        addSuggestion(suggestions, getRunScriptCommand(runner, 'test'));
      } else if (typeof scripts.check === 'string') {
        addSuggestion(suggestions, getRunScriptCommand(runner, 'check'));
      }
    }
  }

  if (
    shouldSuggestCargoChecks(changedFiles) &&
    await pathExists(path.join(cwd, 'Cargo.toml'))
  ) {
    addSuggestion(suggestions, 'cargo check');
    addSuggestion(suggestions, 'cargo test');
  }

  if (
    shouldSuggestGoChecks(changedFiles) &&
    await pathExists(path.join(cwd, 'go.mod'))
  ) {
    addSuggestion(suggestions, 'go test ./...');
  }

  if (
    shouldSuggestPythonChecks(changedFiles) &&
    await pathExists(path.join(cwd, 'pyproject.toml')) ||
    shouldSuggestPythonChecks(changedFiles) &&
    await pathExists(path.join(cwd, 'requirements.txt'))
  ) {
    addSuggestion(suggestions, 'pytest');
    addSuggestion(suggestions, 'ruff check .');
  }

  return suggestions.slice(0, 4);
}

async function loadSessionFamily(
  sessionStore: SessionStore,
  session: SessionRecord,
): Promise<SessionRecord[]> {
  const rootSessionId =
    session.rootSessionId ?? session.parentSessionId ?? session.id;
  const sessions = await sessionStore.list();

  return sessions
    .filter((entry) => {
      const entryRootId =
        entry.rootSessionId ?? entry.parentSessionId ?? entry.id;
      return (
        entryRootId === rootSessionId ||
        entry.id === rootSessionId ||
        entry.parentSessionId === rootSessionId
      );
    })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

async function buildVerificationPlan(
  sessionStore: SessionStore,
  session: SessionRecord,
  graph: EvidenceGraph,
  cwd: string,
): Promise<VerificationPlan> {
  const family = await loadSessionFamily(sessionStore, session);
  const changedFiles = collectChangedFiles(family);
  const renameIntents = collectRenameIntents(family);
  const history = collectVerificationHistory(family);
  const suggestions = await getVerificationSuggestions(cwd, changedFiles);
  const checks: VerificationCheck[] = [];
  const hasWriteDrivenVerificationNeed =
    changedFiles.length > 0 || renameIntents.length > 0;

  for (const conflict of graph.conflicts.slice(0, 2)) {
    addCheck(checks, {
      key: conflict.id,
      summary: `Resolve contradiction: ${clip(conflict.summary, 170)}`,
      rationale: 'Conflicting evidence is a release blocker until one side is disproved.',
      priority: 'high',
      kind: 'inspection',
    });
  }

  const claimById = new Map(graph.claims.map((claim) => [claim.id, claim]));
  for (const edge of graph.edges.filter((entry) => entry.type === 'challenges').slice(0, 2)) {
    const risk = claimById.get(edge.fromClaimId);
    const target = claimById.get(edge.toClaimId);
    if (!risk || !target) {
      continue;
    }

    addCheck(checks, {
      key: `${edge.id}-challenge`,
      summary: `Verify that "${clip(risk.statement, 100)}" does not invalidate "${clip(target.statement, 100)}".`,
      rationale: 'Open challenge edges should be closed before the parent decision is treated as verified.',
      priority: 'high',
      kind: 'inspection',
    });
  }

  for (const intent of renameIntents.slice(0, 2)) {
    addCheck(checks, {
      key: `rename-old-${intent.from}-${intent.to}`,
      summary: `Sweep lingering references for ${intent.from} -> ${intent.to}.`,
      rationale:
        'Covers direct refs, type refs, string literals, dynamic import paths, re-exports, tests, and mocks.',
      priority: 'high',
      kind: 'command',
      command: `rg -n --fixed-strings "${intent.from}" src tests __tests__ __mocks__`,
    });
    addCheck(checks, {
      key: `rename-new-${intent.from}-${intent.to}`,
      summary: `Spot-check the renamed token landed where expected: ${intent.to}.`,
      rationale: 'Confirms the new name appears in the intended call sites after the old token sweep goes clean.',
      priority: 'medium',
      kind: 'command',
      command: `rg -n --fixed-strings "${intent.to}" src tests __tests__ __mocks__`,
    });
  }

  if (hasWriteDrivenVerificationNeed) {
    for (const suggestion of suggestions) {
      const normalized = normalizeCommand(suggestion);
      if (history.passed.includes(normalized)) {
        continue;
      }

      addCheck(checks, {
        key: `command-${normalized}`,
        summary: `Run ${normalized}.`,
        rationale: buildSuggestionRationale(normalized, changedFiles),
        priority: /\b(test|check)\b/i.test(normalized) ? 'medium' : 'high',
        kind: 'command',
        command: normalized,
        covers: summarizeCoverage(changedFiles),
      });
    }
  }

  if (hasCliSurfaceChanges(changedFiles)) {
    addCheck(checks, {
      key: 'cli-help-smoke',
      summary: 'Smoke-test the CLI entrypoint.',
      rationale: 'CLI-facing files changed, so argument parsing and command registration need a fast runtime check.',
      priority: 'high',
      kind: 'command',
      command: 'node --experimental-strip-types src/index.ts help',
      covers: changedFiles.filter(
        (filePath) =>
          filePath === 'src/index.ts' ||
          filePath.startsWith('src/cli/') ||
          filePath.startsWith('bin/'),
      ),
    });

    if (await pathExists(path.join(cwd, 'bin', 'artemis.mjs'))) {
      addCheck(checks, {
        key: 'cli-bin-smoke',
        summary: 'Smoke-test the installed bin wrapper.',
        rationale: 'The shipped bin path should stay wired after CLI changes.',
        priority: 'medium',
        kind: 'command',
        command: 'node .\\bin\\artemis.mjs help',
      });
    }
  }

  if (hasVerificationSurfaceChanges(changedFiles)) {
    addCheck(checks, {
      key: 'verify-command-smoke',
      summary: 'Smoke-test the verification report path.',
      rationale: 'Verification/evidence/session plumbing changed, so the user-facing verify command should be exercised directly.',
      priority: 'high',
      kind: 'command',
      command: `node --experimental-strip-types src/index.ts verify ${session.id}`,
      covers: changedFiles.filter(
        (filePath) =>
          filePath.startsWith('src/core/evidence') ||
          filePath.startsWith('src/core/verification') ||
          filePath.startsWith('src/storage/sessions') ||
          filePath.startsWith('src/channels/runtime') ||
          filePath.startsWith('src/cli/interactive') ||
          filePath.startsWith('src/cli/runCli'),
      ),
    });
  }

  if (checks.length === 0) {
    for (const check of buildFallbackChecks(graph)) {
      addCheck(checks, check);
    }
  }

  const notes: string[] = [];
  if (changedFiles.length > 0) {
    notes.push(`Detected ${changedFiles.length} changed file(s) across the session family.`);
  } else {
    notes.push('No successful write actions were detected in the session family yet.');
  }
  if (history.passed.length > 0) {
    notes.push(`Already passed: ${history.passed.join(' | ')}.`);
  }
  if (history.failed.length > 0) {
    notes.push(`Previously failed: ${history.failed.join(' | ')}.`);
  }
  if (renameIntents.length > 0) {
    notes.push(
      `Rename watch: ${renameIntents.map((intent) => `${intent.from} -> ${intent.to}`).join(' | ')}.`,
    );
  }

  return {
    sessionId: session.id,
    relatedSessionIds: family.map((entry) => entry.id),
    changedFiles,
    renameIntents,
    checks: checks.slice(0, 8),
    completedCommands: history.passed,
    notes,
  };
}

export async function buildVerificationPlanReport(
  sessionStore: SessionStore,
  session: SessionRecord,
  graph: EvidenceGraph,
  cwd: string,
): Promise<string> {
  const plan = await buildVerificationPlan(sessionStore, session, graph, cwd);
  const lines: string[] = [
    `Verification plan for session ${plan.sessionId}`,
    `Related sessions: ${plan.relatedSessionIds.length}`,
  ];

  if (plan.changedFiles.length > 0) {
    lines.push('');
    lines.push('Changed files');
    for (const filePath of plan.changedFiles) {
      lines.push(`- ${filePath}`);
    }
  }

  if (plan.checks.length > 0) {
    lines.push('');
    lines.push('Planned checks');
    for (const [index, check] of plan.checks.entries()) {
      lines.push(
        `${index + 1}. [${check.priority}/${check.kind}] ${check.summary}`,
      );
      if (check.command) {
        lines.push(`   Command: ${check.command}`);
      }
      lines.push(`   Why: ${check.rationale}`);
      if (check.covers && check.covers.length > 0) {
        lines.push(`   Covers: ${check.covers.join(', ')}`);
      }
    }
  } else {
    lines.push('');
    lines.push('No high-signal verification tasks right now.');
  }

  if (plan.completedCommands.length > 0) {
    lines.push('');
    lines.push('Completed commands');
    for (const command of plan.completedCommands) {
      lines.push(`- ${command}`);
    }
  }

  if (plan.notes.length > 0) {
    lines.push('');
    lines.push('Notes');
    for (const note of plan.notes) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join('\n');
}

export function buildVerificationReminder(
  suggestions: string[],
): string {
  const lines = [
    '[system reminder] Files were modified in this session.',
    'Before reporting completion, run a relevant verification command and report the result.',
  ];

  if (suggestions.length > 0) {
    lines.push('Suggested verification commands:');
    for (const suggestion of suggestions) {
      lines.push(`- ${suggestion}`);
    }
  } else {
    lines.push(
      'No obvious verifier was detected. If verification is not available, state that explicitly instead of implying success.',
    );
  }

  return lines.join('\n');
}
