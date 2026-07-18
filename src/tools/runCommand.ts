import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join as joinPath } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { AgentAction } from '../core/types.js';
import { invalidateWalkFilesCache, resolveArtemisHomeDir, truncate } from '../utils/fs.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';
import {
  appendCaptureChunk,
  closeCaptureLog,
  createCommandCapture,
  discardCaptureLogIfComplete,
  taskManager,
} from './taskManager.js';
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
    const storePath = joinPath(resolveArtemisHomeDir(), 'vercel.json');
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

function commandAccessesAllowedArtemisDiagnosticPath(cmd: string): boolean {
  const expanded = expandForInspection(cmd).replace(/\\/g, '/')
  const home = homedir().replace(/\\/g, '/')
  const allowed = [
    `${resolveArtemisHomeDir().replace(/\\/g, '/')}/dreams`,
    `${resolveArtemisHomeDir().replace(/\\/g, '/')}/gateway.log`,
    `${resolveArtemisHomeDir().replace(/\\/g, '/')}/gateway.launchd.log`,
    `${resolveArtemisHomeDir().replace(/\\/g, '/')}/gateway.launchd.err.log`,
  ]
  return allowed.some(path => expanded.includes(path))
}

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
  if (commandAccessesAllowedArtemisDiagnosticPath(cmd)) return false
  const expanded = expandForInspection(cmd)
  return SENSITIVE_PATH_PATTERNS.some(re => re.test(expanded))
}

function commandMatchesDangerousPattern(cmd: string): string | null {
  for (const { re, reason } of DANGEROUS_SHELL_PATTERNS) {
    if (re.test(cmd)) return reason
  }
  return null
}

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
// How long an explicit background start waits before returning, so instant
// failures (bad binary, syntax error) are reported inline instead of forcing a
// task_output round-trip.
const BACKGROUND_START_GRACE_MS = 1_200;

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

// ── persistent shell state (fd 3/4) ──────────────────────────────────────────
// Each command still runs in a fresh process, but on POSIX the wrapper replays
// a serialized snapshot of the previous command's shell state (env vars,
// options, functions, aliases) from fd 3 before running the user command, and
// dumps the new state to fd 4 afterwards. Dump traffic never touches
// stdout/stderr. Any failure in this machinery degrades silently to the
// cwd-only persistence provided by the EXIT-trap markers.

type ShellKind = 'bash' | 'zsh';

type SessionShellState = {
  shell: ShellKind;
  snapshot: string;
};

const SHELL_STATE_START_MARKER = '__ARTEMIS_SHELL_STATE_START__';
const SHELL_STATE_END_MARKER = '__ARTEMIS_SHELL_STATE_END__';
// Keep runaway snapshots (huge functions, giant exported blobs) from growing
// per-command memory and spawn cost without bound.
const MAX_SHELL_SNAPSHOT_CHARS = 400_000;
const SHELL_STATE_SESSION_CAP = 32;

// Env lines whose *name* suggests credentials are filtered out of the dump so
// a secret exported by one command is not replayed into every later command.
// Session/desktop plumbing vars are excluded because replaying stale values
// breaks agents (ssh, dbus) more often than it helps.
const SHELL_STATE_ENV_EXCLUDE_GREP =
  "command grep -viE '_proxy=|SSH_AUTH_SOCK|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR|WAYLAND_DISPLAY|GPG_TTY' | " +
  "command grep -viE '^[^=]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[^=]*='";

const DUMP_BASH_STATE_SCRIPT = `
dump_artemis_bash_state() {
  if ! command -v base64 >/dev/null 2>&1; then return 1; fi
  _artemis_emit() { builtin printf '%s\\n' "$1"; }
  _artemis_emit_encoded() {
    local content="$1"; local var_name="$2"
    if [[ -n "$content" ]]; then
      builtin printf 'artemis_snap_%s=$(command base64 -d <<'"'"'ARTEMIS_SNAP_EOF_%s'"'"'\\n' "$var_name" "$var_name"
      command base64 <<<"$content" | command tr -d '\\n'
      builtin printf '\\nARTEMIS_SNAP_EOF_%s\\n' "$var_name"
      builtin printf ')\\n'
      builtin printf 'builtin eval "$artemis_snap_%s"\\n' "$var_name"
    fi
  }
  _artemis_emit "${SHELL_STATE_START_MARKER}"
  _artemis_emit "$PWD"
  local env_vars
  env_vars=$(builtin export -p 2>/dev/null | ${SHELL_STATE_ENV_EXCLUDE_GREP} || true)
  _artemis_emit_encoded "$env_vars" "ENV_VARS_B64"
  local posix_opts
  posix_opts=$(builtin shopt -po 2>/dev/null | command grep -v 'nounset' || true)
  _artemis_emit_encoded "$posix_opts" "POSIX_OPTS_B64"
  local bash_opts
  bash_opts=$(builtin shopt -p 2>/dev/null || true)
  _artemis_emit_encoded "$bash_opts" "BASH_OPTS_B64"
  local all_functions
  all_functions=$(builtin declare -f 2>/dev/null || true)
  _artemis_emit_encoded "$all_functions" "FUNCTIONS_B64"
  local aliases
  aliases=$(builtin alias -p 2>/dev/null || true)
  _artemis_emit_encoded "$aliases" "ALIASES_B64"
  _artemis_emit "${SHELL_STATE_END_MARKER}"
}
`;

const DUMP_ZSH_STATE_SCRIPT = `
function dump_artemis_zsh_state() {
  builtin zmodload -F zsh/parameter p:parameters p:options p:functions p:aliases 2>/dev/null || true
  _artemis_emit() { builtin print -r -- "$1"; }
  _artemis_emit_encoded() {
    local content="$1"; local var_name="$2"
    if [[ -n "$content" ]]; then
      builtin printf 'artemis_snap_%s=$(command base64 -d <<'"'"'ARTEMIS_SNAP_EOF_%s'"'"'\\n' "$var_name" "$var_name"
      command base64 <<<"$content" | command tr -d '\\n'
      builtin printf '\\nARTEMIS_SNAP_EOF_%s\\n' "$var_name"
      builtin printf ')\\n'
      builtin printf 'builtin eval "$artemis_snap_%s"\\n' "$var_name"
    fi
  }
  _artemis_emit "${SHELL_STATE_START_MARKER}"
  _artemis_emit "$PWD"
  local env_vars
  env_vars=$(builtin typeset -xp 2>/dev/null | ${SHELL_STATE_ENV_EXCLUDE_GREP} || true)
  _artemis_emit_encoded "$env_vars" "ENV_VARS_B64"
  local zsh_opts
  zsh_opts=$(setopt 2>/dev/null | command grep -v '^nounset$' | command awk '{printf "builtin setopt %s 2>/dev/null || true\\n", $0}' || true)
  _artemis_emit_encoded "$zsh_opts" "ZSH_OPTS_B64"
  local all_functions
  all_functions=$(builtin typeset -f 2>/dev/null || true)
  _artemis_emit_encoded "$all_functions" "FUNCTIONS_B64"
  local aliases
  aliases=$(builtin alias -L 2>/dev/null || true)
  _artemis_emit_encoded "$aliases" "ALIASES_B64"
  _artemis_emit "${SHELL_STATE_END_MARKER}"
}
`;

const shellStatesBySession = new Map<string, SessionShellState>();

function detectShellKind(): ShellKind {
  const shellPath = process.env.SHELL ?? '';
  return basename(shellPath) === 'zsh' ? 'zsh' : 'bash';
}

function resolveShellBinary(kind: ShellKind): string | null {
  const fromEnv = process.env.SHELL;
  if (fromEnv && basename(fromEnv) === kind && existsSync(fromEnv)) {
    return fromEnv;
  }
  const fallback = kind === 'zsh' ? '/bin/zsh' : '/bin/bash';
  return existsSync(fallback) ? fallback : null;
}

function buildStatefulWrapper(kind: ShellKind): string {
  const dumpFn = kind === 'zsh' ? 'dump_artemis_zsh_state' : 'dump_artemis_bash_state';
  const dumpScript = kind === 'zsh' ? DUMP_ZSH_STATE_SCRIPT : DUMP_BASH_STATE_SCRIPT;
  if (kind === 'zsh') {
    return (
      `${dumpScript}\n` +
      `__artemis_snap=$(command cat <&3 2>/dev/null) || __artemis_snap=''\n` +
      `builtin unsetopt aliases 2>/dev/null\n` +
      `builtin unalias -m '*' 2>/dev/null || true\n` +
      `if [ -n "$__artemis_snap" ]; then builtin eval "$__artemis_snap" 2>/dev/null || true; fi\n` +
      `builtin unsetopt nounset 2>/dev/null || true\n` +
      `builtin setopt nonomatch 2>/dev/null || true\n` +
      `builtin setopt aliases 2>/dev/null\n` +
      `builtin export PWD="$(builtin pwd)"\n` +
      `builtin eval "$1"\n` +
      `__artemis_cmd_rc=$?\n` +
      `${dumpFn} >&4 2>/dev/null || true\n` +
      `builtin exit $__artemis_cmd_rc`
    );
  }
  return (
    `${dumpScript}\n` +
    `__artemis_snap=$(command cat <&3 2>/dev/null) || __artemis_snap=''\n` +
    `if [ -n "$__artemis_snap" ]; then builtin eval -- "$__artemis_snap" 2>/dev/null || true; fi\n` +
    `builtin set +u 2>/dev/null || true\n` +
    `builtin export PWD="$(builtin pwd)"\n` +
    `builtin shopt -s expand_aliases 2>/dev/null || true\n` +
    `builtin eval "$1"\n` +
    `__artemis_cmd_rc=$?\n` +
    `${dumpFn} >&4 2>/dev/null || true\n` +
    `builtin exit $__artemis_cmd_rc`
  );
}

function getSessionShellState(sessionKey: string, kind: ShellKind): SessionShellState {
  let state = shellStatesBySession.get(sessionKey);
  if (!state || state.shell !== kind) {
    if (shellStatesBySession.size >= SHELL_STATE_SESSION_CAP && !shellStatesBySession.has(sessionKey)) {
      const oldest = shellStatesBySession.keys().next().value;
      if (oldest !== undefined) shellStatesBySession.delete(oldest);
    }
    state = { shell: kind, snapshot: '' };
    shellStatesBySession.set(sessionKey, state);
  }
  return state;
}

/** Parse a fd-4 dump; returns the replayable snapshot (cwd line discarded —
 *  cwd persistence stays with the EXIT-trap marker machinery). */
function parseShellStateDump(raw: string): string | null {
  const startIdx = raw.indexOf(`${SHELL_STATE_START_MARKER}\n`);
  const endIdx = raw.lastIndexOf(SHELL_STATE_END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return null;
  const body = raw.slice(startIdx + SHELL_STATE_START_MARKER.length + 1, endIdx);
  const newlinePos = body.indexOf('\n');
  if (newlinePos === -1) return null;
  const snapshot = body.slice(newlinePos + 1);
  if (snapshot.length > MAX_SHELL_SNAPSHOT_CHARS) return null;
  return snapshot;
}

type StatefulSpawnHandle = {
  child: ChildProcess;
  /** Resolves with the raw fd-4 dump text once available (empty on failure). */
  readDump: () => string;
  sessionState: SessionShellState;
};

/**
 * Spawn the user's shell directly with fd 3/4 wired for state replay/dump.
 * Returns null when the persistent-state path is unavailable (Windows, missing
 * shell binary, spawn failure) so the caller can use the plain path.
 */
function spawnWithShellState(
  wrappedCommand: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; sessionKey: string },
): StatefulSpawnHandle | null {
  if (process.platform === 'win32') return null;
  try {
    const kind = detectShellKind();
    const binary = resolveShellBinary(kind);
    if (!binary) return null;
    const sessionState = getSessionShellState(options.sessionKey, kind);
    const wrapper = buildStatefulWrapper(kind);
    const args = kind === 'bash'
      ? ['-O', 'extglob', '-c', wrapper, '--', wrappedCommand]
      : ['-c', wrapper, '--', wrappedCommand];
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
    });

    const stateIn = child.stdio[3] as Writable | null;
    const stateOut = child.stdio[4] as Readable | null;
    let dumpText = '';
    if (stateIn) {
      stateIn.on('error', () => { /* EPIPE when the child exits early */ });
      stateIn.end(sessionState.snapshot);
    }
    if (stateOut) {
      stateOut.on('error', () => { /* ignore */ });
      stateOut.on('data', (chunk: Buffer) => {
        if (dumpText.length < MAX_SHELL_SNAPSHOT_CHARS * 2) {
          dumpText += String(chunk);
        }
      });
    }
    return {
      child,
      readDump: () => dumpText,
      sessionState,
    };
  } catch {
    return null;
  }
}

export async function executeRunCommand(
  action: Extract<AgentAction, { type: 'run_command' }>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const timeoutMs = resolveRunCommandTimeoutMs(
    action.command,
    action.timeoutMs,
  );

  if (context.permissionMode !== 'full-access' && commandAccessesSensitivePath(action.command)) {
    return Promise.resolve({
      action,
      ok: false,
      output: 'Access denied: command references a protected path.',
    })
  }

  const dangerousReason = commandMatchesDangerousPattern(action.command)
  if (dangerousReason) {
    if (!context.requestUserConfirmation) {
      return Promise.resolve({
        action,
        ok: false,
        output: `Access denied: command ${dangerousReason}. No confirmation channel is available for this high-risk action.`,
      })
    }
    const allowed = await context.requestUserConfirmation({
      question: `High-risk shell command detected: ${dangerousReason}\n\nCommand:\n${truncate(action.command, 800)}\n\nRun it anyway?`,
      timeoutMs: 10 * 60_000,
    })
    if (!allowed) {
      return Promise.resolve({
        action,
        ok: false,
        output: `Command not run: user declined high-risk shell command (${dangerousReason}).`,
      })
    }
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
    const sessionKey = context.sessionId?.trim() || 'default';
    // Prefer the persistent-shell-state spawn (fd 3/4 replay/dump) on POSIX;
    // fall back to the plain `shell: true` spawn on Windows or when the
    // user's shell binary is unavailable.
    const stateHandle = spawnWithShellState(wrappedCommand, {
      cwd: context.cwd,
      env: spawnEnv,
      sessionKey,
    });
    const child = stateHandle?.child ?? spawn(wrappedCommand, {
      cwd: context.cwd,
      shell: true,
      windowsHide: true,
      env: spawnEnv,
      // Create a process group on POSIX so cancellation/timeout can kill the
      // whole shell tree, not just the wrapper shell. On Windows detached
      // process-group semantics differ, so keep the existing direct kill path.
      detached: !isWindows,
    });

    const capture = createCommandCapture();
    const wantsBackground = action.background === true;
    const killOnTimeout = action.killOnTimeout === true;
    let resolved = false;
    let aborted = false;
    let adoptedTaskId: string | null = null;

    const killChild = (signal: NodeJS.Signals = 'SIGTERM'): void => {
      if (child.killed) return;
      if (!isWindows && typeof child.pid === 'number') {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall back to killing the shell process directly. This can happen if
          // the platform did not create a distinct process group for this child.
        }
      }
      child.kill(signal);
    };

    const cleanupAbortListener = (): void => {
      context.abortSignal?.removeEventListener('abort', onAbort);
    };

    const onAbort = (): void => {
      aborted = true;
      killChild('SIGTERM');
      setTimeout(() => {
        if (!resolved) killChild('SIGKILL');
      }, 1_000).unref?.();
    };

    if (context.abortSignal?.aborted) {
      onAbort();
    } else {
      context.abortSignal?.addEventListener('abort', onAbort, { once: true });
    }

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

    child.stdout?.on('data', (chunk) => {
      appendCaptureChunk(capture, 'stdout', chunk);
    });

    child.stderr?.on('data', (chunk) => {
      appendCaptureChunk(capture, 'stderr', chunk);
    });

    const adoptToBackground = (reason: 'explicit' | 'foreground-timeout'): string => {
      const task = taskManager.adopt({
        child,
        capture,
        command: action.command,
        cwd: context.cwd,
        reason,
      });
      adoptedTaskId = task.id;
      return task.id;
    };

    const backgroundNote =
      'note: the task keeps running in the background. Do NOT sleep-poll or busy-wait for it — ' +
      'continue with other work; a system-reminder will notify you when it completes. ' +
      'Use task_output to inspect progress and kill_task to stop it.';

    // ── explicit background start ────────────────────────────────────────────
    if (wantsBackground) {
      cleanupAbortListener();
      if (!taskManager.hasCapacity()) {
        killChild('SIGKILL');
        resolved = true;
        resolve({
          action,
          ok: false,
          output: 'Too many background tasks are already running. Use task_output to review them and kill_task to stop stale ones before starting more.',
        });
        return;
      }
      const taskId = adoptToBackground('explicit');
      const finishStart = (): void => {
        if (resolved) return;
        resolved = true;
        const task = taskManager.get(taskId);
        const running = !task || task.status === 'running';
        if (!running && task) {
          // Completed within the start grace window — report inline and drop
          // the queued completion reminder (it would be redundant).
          taskManager.consumeReminder(taskId);
        }
        resolve({
          action,
          ok: running ? true : task!.exitCode === 0,
          output: [
            `command: ${action.command}`,
            'background: true',
            `task_id: ${taskId}`,
            running
              ? `status: running${typeof child.pid === 'number' ? ` (pid ${child.pid})` : ''}`
              : `status: ${task!.status} (exit_code: ${task!.exitCode ?? -1})`,
            `log_file: ${capture.logPath}`,
            'initial stdout:',
            capture.stdout.render(capture.logPath),
            'initial stderr:',
            capture.stderr.render(capture.logPath),
            ...(running ? [backgroundNote] : []),
          ].join('\n'),
        });
      };
      const graceTimer = setTimeout(finishStart, BACKGROUND_START_GRACE_MS);
      graceTimer.unref?.();
      void taskManager.waitForCompletion(taskId, BACKGROUND_START_GRACE_MS + 200).then(() => {
        clearTimeout(graceTimer);
        finishStart();
      });
    }

    // ── foreground timeout: move to background instead of killing ────────────
    const timer = wantsBackground
      ? null
      : setTimeout(() => {
          if (resolved) {
            return;
          }
          if (!killOnTimeout && taskManager.hasCapacity()) {
            const taskId = adoptToBackground('foreground-timeout');
            resolved = true;
            cleanupAbortListener();
            resolve({
              action,
              ok: true,
              output: [
                `command: ${action.command}`,
                'auto_backgrounded: true',
                `task_id: ${taskId}`,
                `reason: command exceeded the ${timeoutMs}ms foreground budget and was moved to the background instead of being killed`,
                `log_file: ${capture.logPath}`,
                'partial stdout:',
                capture.stdout.render(capture.logPath),
                'partial stderr:',
                capture.stderr.render(capture.logPath),
                backgroundNote,
              ].join('\n'),
            });
            return;
          }
          killChild('SIGTERM');
          setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              killChild('SIGKILL');
            }
          }, 1_500).unref?.();
          resolved = true;
          cleanupAbortListener();
          resolve({
            action,
            ok: false,
            output: `Command timed out after ${timeoutMs}ms and was killed (killOnTimeout).\nstdout:\n${truncate(capture.stdout.render(capture.logPath), TIMEOUT_PREVIEW_CHARS)}\nstderr:\n${truncate(capture.stderr.render(capture.logPath), TIMEOUT_PREVIEW_CHARS)}`,
          });
        }, timeoutMs);

    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      cleanupAbortListener();
      closeCaptureLog(capture);
      if (adoptedTaskId) {
        taskManager.finalize(adoptedTaskId, -1, null);
      }
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

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      cleanupAbortListener();
      if (adoptedTaskId) {
        // Backgrounded (explicitly or by foreground-timeout adoption): the
        // TaskManager owns finalization and completion reminders. Skip cwd /
        // shell-state persistence — the session moved on while this ran.
        taskManager.finalize(adoptedTaskId, code, signal ?? null);
        return;
      }
      closeCaptureLog(capture);
      if (resolved) {
        return;
      }
      (async () => {
        resolved = true;

        // Harvest the fd-4 shell state dump (env/options/functions/aliases)
        // for the next command in this session. Missing or malformed dumps
        // silently keep the previous snapshot (cwd-only degradation).
        if (stateHandle && !aborted) {
          const snapshot = parseShellStateDump(stateHandle.readDump());
          if (snapshot !== null) {
            stateHandle.sessionState.snapshot = snapshot;
          }
        }

        if (aborted) {
          resolve({
            action,
            ok: false,
            output: [
              `command: ${action.command}`,
              'interrupted: true',
              'reason: user correction received while command was running',
              'stdout:',
              truncate(capture.stdout.render(capture.logPath), TIMEOUT_PREVIEW_CHARS),
              'stderr:',
              truncate(capture.stderr.render(capture.logPath), TIMEOUT_PREVIEW_CHARS),
            ].join('\n'),
          });
          return;
        }
        const warnings: string[] = [];
        if (capture.logCapped) {
          warnings.push(
            `Output exceeded the 512MB on-disk log cap; the log at ${capture.logPath} is incomplete. Re-run with a narrower filter if you need the omitted output.`,
          );
        }

        // Peel the marker lines off and persist any cwd change before building
        // the model-facing output. Only do this when the process exited cleanly
        // via the wrapper (not a kill), which we detect by the marker's presence.
        const renderedStdout = capture.stdout.render(capture.logPath);
        const renderedStderr = capture.stderr.render(capture.logPath);
        const { cleaned: cleanedStdout, newCwd } = extractCwdFromOutput(renderedStdout);
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

        if (capture.stdout.truncated || capture.stderr.truncated) {
          warnings.push(
            `Only the first/last portions of the output are shown inline. The complete output is on disk at ${capture.logPath} — inspect it with read_file (negative startLine reads the tail) or search_files.`,
          );
        }
        if (code === 0) {
          invalidateWalkFilesCache();
        }
        // Nothing was truncated → the message already carries the full output,
        // so drop the on-disk copy to avoid tmp litter.
        discardCaptureLogIfComplete(capture);
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
            cleanedStdout,
            'stderr:',
            renderedStderr,
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
