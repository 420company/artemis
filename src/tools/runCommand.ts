import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import type { AgentAction } from '../core/types.js';
import { invalidateWalkFilesCache, truncate } from '../utils/fs.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';
import {
  isPathInsideWorkspace,
  resolveWorkspaceCandidatePath,
  resolveWorkspaceForTargetPath,
} from '../utils/workspaceRoots.js';

// Detect whether the user's command actually invokes the vercel CLI binary
// (vs. just mentions "vercel" as an argument like `npm install vercel`).
// Two cases qualify:
//   (a) bare `vercel` at the start of a shell-command segment, or
//   (b) `vercel` immediately after a known wrapper (npx / bunx / pnpm dlx / etc.).
const VERCEL_BARE_AT_SEGMENT_START = /(^|[;&|]\s*)\s*vercel\b/;
const VERCEL_AFTER_WRAPPER = /\b(?:npx|bunx|pnpm\s+(?:dlx|exec)|yarn(?:\s+dlx)?)\s+vercel\b/;
const VERCEL_BUN_X = /\bbun\s+x\s+vercel\b/;
function isVercelInvocation(command: string): boolean {
  return (
    VERCEL_BARE_AT_SEGMENT_START.test(command) ||
    VERCEL_AFTER_WRAPPER.test(command) ||
    VERCEL_BUN_X.test(command)
  );
}

function readSavedVercelToken(): string | null {
  try {
    const storePath = joinPath(homedir(), '.artemis', 'vercel.json');
    const raw = readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw) as { token?: unknown };
    return typeof parsed?.token === 'string' && parsed.token.length > 0
      ? parsed.token
      : null;
  } catch {
    return null;
  }
}

/**
 * Build the env passed to spawn(). Starts from process.env and adds an
 * auto-injected VERCEL_TOKEN only when (1) the command uses the vercel CLI
 * and (2) the user hasn't set VERCEL_TOKEN themselves. Read fresh on every
 * spawn so `/vercel logout` takes effect immediately without restart.
 */
function buildSpawnEnv(command: string): NodeJS.ProcessEnv {
  if (process.env.VERCEL_TOKEN) return process.env;
  if (!isVercelInvocation(command)) return process.env;
  const token = readSavedVercelToken();
  if (!token) return process.env;
  return { ...process.env, VERCEL_TOKEN: token };
}

// ── sensitive command guard ───────────────────────────────────────────────────
// Any of these in the command string (after $VAR and ~ expansion and quote
// stripping) triggers a refusal. This is defense-in-depth: a motivated
// attacker with shell access can still bypass via encoding or subshell
// tricks, but the guard raises the effort for a single-line prompt injection.
const SENSITIVE_PATH_PATTERNS = [
  // User-scoped credential dirs (per-user, require $HOME expansion).
  // .artemis/ is broadly protected EXCEPT for the dreams/ subdirectory —
  // dreams contain only user-generated content (md notes, png renders,
  // learned-prompt summaries). They have no tokens / secrets / session data,
  // and the AI legitimately needs to read its own dreams to answer
  // /dream status, reference past dreams, or self-introspect.
  /\.artemis[/\\](?!dreams[/\\]?)/,
  /\.artemis$/,
  /\.claude[/\\]/,
  /providers\.json/,
  /bragi\.json/,
  /\.env($|[\s"'.])/,
  /\.netrc/,
  /\.ssh[/\\]/,
  /\.aws[/\\]/,
  /\.gnupg[/\\]/,
  /\.config[/\\]gh[/\\]/,
  // System-level credential / log paths (absolute, no $HOME)
  /\/etc\/shadow\b/,
  /\/etc\/sudoers\b/,
  /\/etc\/passwd\b/,        // not secret but a strong signal of probing
  /\/root[/\\]/,
  /\/var\/root[/\\]/,       // macOS root home
  /\/private\/etc\//,       // macOS alias for /etc
  /\/var\/log\/auth/,
  /\bkeychain\b/i,
  // SSH/GPG key filenames anywhere on the filesystem
  /\bid_(rsa|ed25519|ecdsa|dsa)\b/,
]

// High-signal "remote payload → shell" pipelines and reverse-shell patterns.
// Each matcher is deliberately conservative (must contain a distinguishing
// construct) so benign commands don't trip it.
const DANGEROUS_SHELL_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\bcurl\b[^|;&`]{0,200}\|\s*(bash|sh|zsh|ksh|dash)\b/i,
    reason: 'pipes curl output directly into a shell' },
  { re: /\bwget\b[^|;&`]{0,200}\|\s*(bash|sh|zsh|ksh|dash)\b/i,
    reason: 'pipes wget output directly into a shell' },
  { re: /\b(base64|xxd|openssl\s+base64)\b[^|;`]{0,200}-d[^|;`]{0,200}\|\s*(bash|sh|zsh|ksh)\b/i,
    reason: 'decodes a base64 payload and pipes it into a shell' },
  { re: /\beval\s+["'$(`][^"']*\b(curl|wget|fetch)\b/i,
    reason: 'evals the output of a remote fetch' },
  { re: /\bbash\s+-i\b[^|]{0,200}>&?\s*\/dev\/tcp\//,
    reason: 'opens an interactive reverse shell over /dev/tcp' },
  { re: /\bmkfifo\b[\s\S]{0,200}\bnc\b/,
    reason: 'sets up a named-pipe reverse shell via nc' },
  { re: /\bnc\b[^|]{0,200}-e\s+\/?(?:bin\/)?(bash|sh|zsh)\b/i,
    reason: 'uses nc -e to expose a shell' },
]

function expandForInspection(cmd: string): string {
  const home = homedir().replace(/\\/g, '/')
  // Expand ~, $HOME, ${HOME}, and strip quotes so "/.s""sh/" becomes "/.ssh/".
  let expanded = cmd
    .replace(/~(?=[/\\]|$)/g, home)
    .replace(/\$\{?HOME\}?/g, home)
    .replace(/["']/g, '')
  // Collapse \$ escapes and $VAR references that are empty, so names split
  // across variables (".s$X{sh}" etc.) are harder to hide.
  expanded = expanded.replace(/\\\$/g, '$').replace(/\$\{[^}]*\}/g, '').replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, '')
  return expanded
}

function commandAccessesSensitivePath(cmd: string): boolean {
  const expanded = expandForInspection(cmd)
  return SENSITIVE_PATH_PATTERNS.some(re => re.test(expanded))
}

function commandMatchesDangerousPattern(cmd: string): string | null {
  for (const { re, reason } of DANGEROUS_SHELL_PATTERNS) {
    if (re.test(cmd)) return reason
  }
  return null
}

const STDOUT_PREVIEW_CHARS = 6_000;
const STDERR_PREVIEW_CHARS = 6_000;
const TIMEOUT_PREVIEW_CHARS = 4_000;
// 30s used to be the default, but it tripped commands like `find`, recursive
// `grep`, slow `git status`, and any command misclassified by the long-running
// pattern list. When the timeout fires the model often gives up and starts
// hallucinating "I checked the file, it's perfect" instead of retrying — see
// /niko bail-out reports. 90s is a better tradeoff: long enough for typical
// file-system / network probes, still bounded enough to interrupt true hangs.
const DEFAULT_TIMEOUT_MS = 90_000;
const EXTENDED_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 600_000;
// Hard cap on in-memory accumulation per stream. Prevents `yes` / `cat /dev/urandom`
// from exhausting node heap when the model runs an unbounded command.
const MAX_STREAM_BYTES = 5_000_000;

const LONG_RUNNING_COMMAND_PATTERNS = [
  /\b(?:npm|pnpm|yarn|bun)\b[\s\S]{0,80}\b(?:create|install|add|ci|init|dlx|exec|update|upgrade|audit)\b/i,
  /\bnpx\b[\s\S]{0,80}\bcreate-[a-z0-9._-]+\b/i,
  /\b(?:npm|pnpm|yarn|bun)\b[\s\S]{0,80}\brun\b[\s\S]{0,40}\b(?:build|test|typecheck|lint|check|verify|dev|start)\b/i,
  /\b(?:cargo|go|pip3?|poetry|composer|bundle|gem|brew)\b[\s\S]{0,80}\b(?:install|build|test|check|update)\b/i,
  // Recursive filesystem scans on large repos can blow past 30s but rarely run
  // longer than a couple of minutes. Treat them as long-running so a bare
  // `find . -name "*.html"` doesn't time out and trigger model hallucination.
  /\bfind\b[\s\S]{0,200}-(?:name|iname|path|regex|type)\b/i,
  /\bgrep\b[\s\S]{0,80}-(?:r|R)\b/i,
  /\bwget\b/i,
  /\bcurl\b[\s\S]{0,200}\b(?:-O|--output|-o\s)/i,
];

function commandLooksLongRunning(command: string): boolean {
  const normalized = command.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return false;
  }

  return LONG_RUNNING_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}

function extractShellDirectoryChanges(command: string): string[] {
  const matches: string[] = [];

  // POSIX + Windows cd / pushd. Windows cmd allows `cd /d <path>` to also
  // switch the drive, so we tolerate optional flag arguments before the
  // actual path. We also treat `cd /D` (uppercase) the same way.
  const pattern = /(?:^|[\n;&|]|&&|\|\|)\s*(?:builtin\s+)?(?:cd|pushd|chdir)\s+((?:\/[Dd]\s+)?(?:"[^"]+"|'[^']+'|[^\s;&|]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    let candidate = (match[1] ?? '').trim();
    // Strip optional Windows `/d ` flag prefix
    candidate = candidate.replace(/^\/[Dd]\s+/, '');
    // Strip surrounding quotes
    if ((candidate.startsWith('"') && candidate.endsWith('"')) ||
        (candidate.startsWith("'") && candidate.endsWith("'"))) {
      candidate = candidate.slice(1, -1);
    }
    if (!candidate || candidate === '-' || candidate === '--') continue;
    matches.push(candidate);
  }

  // Windows bare drive-letter switch: `D:` on its own line means "switch
  // to D's last working directory". We treat it as a workspace switch to
  // the drive root so the trust check fires consistently.
  const driveSwitchPattern = /(?:^|[\n;&|]|&&|\|\|)\s*([A-Za-z]:)(?=\s*(?:$|[\n;&|]|&&|\|\|))/g;
  let driveMatch: RegExpExecArray | null;
  while ((driveMatch = driveSwitchPattern.exec(command)) !== null) {
    const drive = driveMatch[1]!;
    matches.push(`${drive}\\`);
  }

  return matches;
}

export function resolveRunCommandTimeoutMs(
  command: string,
  requestedTimeoutMs?: number,
): number {
  const fallbackTimeoutMs = commandLooksLongRunning(command)
    ? EXTENDED_TIMEOUT_MS
    : DEFAULT_TIMEOUT_MS;

  return Math.min(
    Math.max(requestedTimeoutMs ?? fallbackTimeoutMs, 1_000),
    MAX_TIMEOUT_MS,
  );
}

export async function executeRunCommand(
  action: Extract<AgentAction, { type: 'run_command' }>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const timeoutMs = resolveRunCommandTimeoutMs(
    action.command,
    action.timeoutMs,
  );

  if (context.permissionMode !== 'accept-all' && commandAccessesSensitivePath(action.command)) {
    return Promise.resolve({
      action,
      ok: false,
      output: 'Access denied: command references a protected path.',
    })
  }

  const dangerousReason = commandMatchesDangerousPattern(action.command)
  if (dangerousReason) {
    return Promise.resolve({
      action,
      ok: false,
      output: `Access denied: command ${dangerousReason}. Break it into discrete, inspectable steps if you need the same effect.`,
    })
  }

  let simulatedCwd = context.cwd;
  for (const rawTarget of extractShellDirectoryChanges(action.command)) {
    const candidate = resolveWorkspaceCandidatePath(rawTarget, simulatedCwd);
    if (!isPathInsideWorkspace(simulatedCwd, candidate)) {
      const resolution = await resolveWorkspaceForTargetPath(candidate, simulatedCwd);
      if (!resolution) {
        return Promise.resolve({
          action,
          ok: false,
          output: `Workspace switch failed for shell path: ${rawTarget}`,
        });
      }
      if (!(await context.requestWorkspaceSwitch?.({
        requestedPath: resolution.requestedPath,
        workspacePath: resolution.workspacePath,
        usedNearestExistingParent: resolution.usedNearestExistingParent,
        source: 'run_command',
        toolName: 'run_command',
        originalPath: rawTarget,
        switchNow: false,
      }))) {
        return Promise.resolve({
          action,
          ok: false,
          output: `Workspace trust declined for shell path: ${rawTarget}`,
        });
      }
    }
    simulatedCwd = candidate;
  }

  // Wrap the command so the child shell, *after* running whatever the model
  // asked for, prints its final $PWD and real exit code on dedicated marker
  // lines. We parse those out before returning to the model, and use $PWD to
  // persist any `cd` across subsequent tool calls so command sequences can
  // behave like a continuous shell session.
  //
  // Two things we defend against:
  // 1. Marker forgery — a stray `echo __ARTEMIS_CWD__:/fake` in the command's
  //    output would otherwise be parsed as a real cd. We use a random per-call
  //    nonce in the marker and take the LAST occurrence (the one the trap
  //    emits is guaranteed to come after any stdout the command produced).
  // 2. `set -e` / early exit — the previous wrapper (`{ cmd }; printf ...`)
  //    would skip the printf lines when the command aborted via `set -e` or
  //    an explicit `exit N`, so cwd and exit code were lost. We install an
  //    EXIT trap so the markers fire no matter how the shell dies (including
  //    signal-free early exit; signal kills still skip them, which keeps the
  //    no-op contract for timeout/overflow paths).
  const nonce = randomBytes(8).toString('hex');
  const CWD_MARKER = `__ARTEMIS_CWD_${nonce}__`;
  const EXIT_MARKER = `__ARTEMIS_EXIT_${nonce}__`;
  const isWindows = process.platform === 'win32';
  // Build the command wrapper. On POSIX we use a bash EXIT trap so the
  // markers fire even on `set -e` / explicit `exit N`. On Windows cmd.exe
  // we chain with `&` so the marker echos run regardless of the user
  // command's exit status — `trap`/`printf`/`$PWD` are bash-only and would
  // otherwise produce "'trap' is not recognized" on every Windows run.
  const wrappedCommand = isWindows
    ? [
        `(${action.command})`,
        `set ARTEMIS_RC=%ERRORLEVEL%`,
        `echo.`,
        `echo ${CWD_MARKER}:%CD%`,
        `echo ${EXIT_MARKER}:%ARTEMIS_RC%`,
        `exit /b %ARTEMIS_RC%`,
      ].join(' & ')
    : [
        `trap '__artemis_rc=$?; ` +
        `printf "\\n%s:%s\\n" "${CWD_MARKER}" "$PWD"; ` +
        `printf "%s:%s\\n" "${EXIT_MARKER}" "$__artemis_rc"; ` +
        `exit $__artemis_rc' EXIT`,
        action.command,
      ].join('\n');

  // Auto-inject saved Vercel token when the user's command involves the
  // vercel CLI. This lets `/vercel` set up auth once and have every later
  // `vercel ...` / `npx vercel ...` invocation pick it up without manual
  // env-var juggling. Only injected when no VERCEL_TOKEN already in env, so
  // explicit user-set values still win.
  const spawnEnv = buildSpawnEnv(action.command);

  return new Promise<ToolExecutionResult>((resolve) => {
    const child = spawn(wrappedCommand, {
      cwd: context.cwd,
      shell: true,
      windowsHide: true,
      env: spawnEnv,
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;
    let overflowKilled = false;

    const extractCwdFromOutput = (raw: string): { cleaned: string; newCwd: string | null } => {
      // Take the LAST occurrence: the EXIT-trap's emission is guaranteed to
      // come after any content the user's command printed, so even if the
      // command echoed the same nonce-tagged line (impossible without reading
      // the wrapper at runtime, but still — defense in depth), the trap wins.
      // Also tolerate CRLF line endings — Windows cmd.exe emits \r\n, and
      // the captured cwd value would otherwise end with a stray \r.
      const cwdRe = new RegExp(`\\n?${CWD_MARKER}:([^\\r\\n]*)\\r?\\n`, 'g');
      const exitRe = new RegExp(`\\n?${EXIT_MARKER}:\\d+\\r?\\n?`, 'g');
      const cwdMatches = [...raw.matchAll(cwdRe)];
      const lastCwd = cwdMatches[cwdMatches.length - 1];
      let cleaned = raw.replace(cwdRe, '').replace(exitRe, '');
      // Trim the trailing blank line that the wrapper prepends before the cwd marker.
      if (lastCwd && /\r?\n$/.test(cleaned)) cleaned = cleaned.replace(/\r?\n$/, '');
      return {
        cleaned,
        newCwd: lastCwd ? lastCwd[1]!.trim() : null,
      };
    };

    const timer = setTimeout(() => {
      child.kill();
      if (resolved) {
        return;
      }
      resolved = true;
      resolve({
        action,
        ok: false,
        output: `Command timed out after ${timeoutMs}ms.\nstdout:\n${truncate(stdout, TIMEOUT_PREVIEW_CHARS)}\nstderr:\n${truncate(stderr, TIMEOUT_PREVIEW_CHARS)}`,
      });
    }, timeoutMs);

    const appendBounded = (current: string, chunk: Buffer | string): string => {
      if (current.length >= MAX_STREAM_BYTES) return current;
      const remaining = MAX_STREAM_BYTES - current.length;
      const text = String(chunk);
      const next = text.length > remaining ? current + text.slice(0, remaining) : current + text;
      if (next.length >= MAX_STREAM_BYTES && !overflowKilled) {
        overflowKilled = true;
        child.kill();
      }
      return next;
    };

    child.stdout.on('data', (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      if (resolved) {
        return;
      }
      resolved = true;
      resolve({
        action,
        ok: false,
        output: `Failed to start command: ${error.message}`,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (resolved) {
        return;
      }
      (async () => {
        resolved = true;
        const warnings: string[] = [];
        if (overflowKilled) {
          warnings.push(
            `Command output exceeded ${MAX_STREAM_BYTES} bytes and was killed. Re-run with a narrower filter (head/tail, --max-count, grep) to avoid OOM.`,
          );
        }

        // Peel the marker lines off and persist any cwd change before building
        // the model-facing output. Only do this when the process exited cleanly
        // via the wrapper (not a kill), which we detect by the marker's presence.
        const { cleaned: cleanedStdout, newCwd } = extractCwdFromOutput(stdout);
        let cwdChangeNote: string | null = null;
        if (newCwd && newCwd !== context.cwd) {
          let allowCwdChange = true;
          if (!isPathInsideWorkspace(context.cwd, newCwd)) {
            const resolution = await resolveWorkspaceForTargetPath(newCwd, context.cwd);
            if (!resolution) {
              allowCwdChange = false;
            } else {
              allowCwdChange = await context.requestWorkspaceSwitch?.({
                requestedPath: resolution.requestedPath,
                workspacePath: resolution.workspacePath,
                usedNearestExistingParent: resolution.usedNearestExistingParent,
                source: 'run_command',
                toolName: 'run_command',
                originalPath: newCwd,
                switchNow: true,
              }) ?? false;
            }
          }

          if (allowCwdChange) {
            if (context.updateCwd) {
              await Promise.resolve(context.updateCwd(newCwd));
            }
            cwdChangeNote = `cwd: ${context.cwd} → ${newCwd}`;
          } else {
            warnings.push(
              `cwd change was not persisted because the target workspace was not trusted: ${newCwd}`,
            );
          }
        }

        if (cleanedStdout.length > STDOUT_PREVIEW_CHARS) {
          warnings.push(
            `stdout was truncated to ${STDOUT_PREVIEW_CHARS} characters. Re-run with narrower scope if you need the omitted output.`,
          );
        }
        if (stderr.length > STDERR_PREVIEW_CHARS) {
          warnings.push(
            `stderr was truncated to ${STDERR_PREVIEW_CHARS} characters. Re-run with narrower scope if you need the omitted output.`,
          );
        }
        if (code === 0) {
          invalidateWalkFilesCache();
        }
        resolve({
          action,
          ok: code === 0,
          output: [
            `command: ${action.command}`,
            `exit_code: ${code ?? -1}`,
            ...(cwdChangeNote ? [cwdChangeNote] : []),
            ...(warnings.length > 0
              ? ['warnings:', ...warnings.map((warning) => `- ${warning}`)]
              : []),
            'stdout:',
            truncate(cleanedStdout, STDOUT_PREVIEW_CHARS),
            'stderr:',
            truncate(stderr, STDERR_PREVIEW_CHARS),
          ].join('\n'),
        });
      })().catch((error) => {
        resolve({
          action,
          ok: false,
          output: `Failed to finalize command execution: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    });
  });
}
