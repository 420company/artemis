/**
 * WP-15 Phase 1 — parameter validators for extras tools exposed through runAgent.
 *
 * Intentionally does NOT import ./extras.ts (keeps registry.ts free of a static edge
 * into extras). Parity with buildExtraToolDefs() is enforced two ways:
 *   - compile time: EXTRA_PARAM_SPECS is typed against ExtraAgentAction in
 *     src/core/types.ts (keys, value types and optionality must match);
 *   - test time: tests/extras-parity.test.ts diffs it against buildExtraToolDefs().
 *
 * Validators never throw. Each returns a list of human-readable (English) error
 * messages; an empty array means the action is valid.
 *
 * ── Input hardening for shell-bound parameters ──────────────────────────────
 * Threat model: every parameter value is LLM-generated content (possibly steered
 * by prompt injection), so it is untrusted input to the execution layer.
 *
 * Where this sits: these validators are the pre-execution gate. runAgent calls
 * them before dispatching an extras tool; a non-empty error list means the tool
 * is never executed.
 *
 * Four strategies, chosen by how the execution layer embeds the value:
 *   1. Bare concatenation into a shell command
 *      (git_diff.path, git_add.paths, git_branch.create, git_branch.checkout,
 *      which_command.command):
 *      rejectShellMetachars() blacklists  ; & | $ ` ( ) < > \n \r * ? ~ #
 *   2. Concatenation inside double quotes (git_commit.message, format_code.path):
 *      rejectDquoteBreakout() rejects only  " $ ` \ and newline. Inside "..."
 *      only these keep a special meaning; ; & | < > etc. are literal there, so they
 *      stay allowed and ordinary commit messages keep working.
 *   3. npm_run.script: allowlist ^[A-Za-z0-9:_-]+$ (npm script names only).
 *   4. calculate.expression: mirrors the execution layer's character allowlist
 *      (strip Math.xxx / PI / E, the remainder must match ^[\d\s+\-*\/%().,^]+$).
 *
 * The blacklists (1, 2) are defense in depth, not the primary control. Character
 * blacklists are inherently incomplete; the robust fix is argv-based execution
 * (no shell) in the execution layer. These checks only narrow what can reach a
 * shell if that layer is ever wrong or regresses. They only ADD rejections; every
 * input previously rejected is still rejected.
 */
import type { AgentAction, ExtraAgentAction, ExtraAgentActionType } from '../core/types.js';

export type ParamTag = 'string' | 'number' | 'boolean' | 'string[]' | 'string|string[]';

export interface RuntimeParamSpec {
  type: ParamTag;
  required: boolean;
  /** Reject '' / whitespace-only strings (paths, ids, commit messages, ...). */
  nonEmpty?: boolean;
}

// ── Compile-time derivation of the spec shape from the AgentAction variants ──
type TagOf<V> = [V] extends [string]
  ? 'string'
  : [V] extends [number]
    ? 'number'
    : [V] extends [boolean]
      ? 'boolean'
      : [V] extends [string[]]
        ? 'string[]'
        : [V] extends [string | string[]]
          ? 'string|string[]'
          : never;

type IsRequired<T, P extends keyof T> = Pick<T, P> extends Required<Pick<T, P>> ? true : false;

type ParamsOf<K extends ExtraAgentActionType> = Omit<Extract<ExtraAgentAction, { type: K }>, 'type'>;

type SpecFor<T> = {
  [P in keyof T]-?: {
    type: TagOf<NonNullable<T[P]>>;
    required: IsRequired<T, P>;
    nonEmpty?: boolean;
  };
};

export type ExtraParamSpecs = { [K in ExtraAgentActionType]: SpecFor<ParamsOf<K>> };

// ── Param table (mirrors buildExtraToolDefs() input_schema) ─────────────────
export const EXTRA_PARAM_SPECS: ExtraParamSpecs = {
  // File operations
  delete_file: { path: { type: 'string', required: true, nonEmpty: true } },
  move_file: {
    from: { type: 'string', required: true, nonEmpty: true },
    to: { type: 'string', required: true, nonEmpty: true },
  },
  copy_file: {
    from: { type: 'string', required: true, nonEmpty: true },
    to: { type: 'string', required: true, nonEmpty: true },
  },
  create_directory: { path: { type: 'string', required: true, nonEmpty: true } },
  delete_directory: {
    path: { type: 'string', required: true, nonEmpty: true },
    force: { type: 'boolean', required: false },
  },
  file_info: { path: { type: 'string', required: true, nonEmpty: true } },
  list_directory: { path: { type: 'string', required: false } },
  // Git
  git_status: {},
  git_diff: {
    staged: { type: 'boolean', required: false },
    path: { type: 'string', required: false },
  },
  git_log: { limit: { type: 'number', required: false } },
  git_add: { paths: { type: 'string|string[]', required: false } },
  git_commit: { message: { type: 'string', required: true, nonEmpty: true } },
  git_branch: {
    create: { type: 'string', required: false, nonEmpty: true },
    checkout: { type: 'string', required: false, nonEmpty: true },
  },
  // Text processing
  regex_match: {
    text: { type: 'string', required: true },
    pattern: { type: 'string', required: true },
    flags: { type: 'string', required: false },
  },
  json_query: {
    json: { type: 'string', required: true },
    query: { type: 'string', required: true },
  },
  format_json: {
    text: { type: 'string', required: true },
    indent: { type: 'number', required: false },
  },
  diff_text: {
    original: { type: 'string', required: true },
    modified: { type: 'string', required: true },
  },
  sort_lines: {
    text: { type: 'string', required: true },
    direction: { type: 'string', required: false },
  },
  dedupe_lines: { text: { type: 'string', required: true } },
  count_lines: { path: { type: 'string', required: true, nonEmpty: true } },
  // Encoding / crypto
  base64_encode: { text: { type: 'string', required: true } },
  base64_decode: { text: { type: 'string', required: true } },
  hash_text: {
    text: { type: 'string', required: true },
    algorithm: { type: 'string', required: false },
  },
  generate_uuid: {},
  // System
  get_env: {
    key: { type: 'string', required: false },
    keys: { type: 'string[]', required: false },
  },
  which_command: { command: { type: 'string', required: true, nonEmpty: true } },
  get_system_info: {},
  date_now: { format: { type: 'string', required: false } },
  calculate: { expression: { type: 'string', required: true, nonEmpty: true } },
  // Network
  check_url: { url: { type: 'string', required: true, nonEmpty: true } },
  download_file: {
    url: { type: 'string', required: true, nonEmpty: true },
    destination: { type: 'string', required: false },
  },
  dns_lookup: { hostname: { type: 'string', required: true, nonEmpty: true } },
  parse_url: { url: { type: 'string', required: true, nonEmpty: true } },
  // Development
  npm_run: { script: { type: 'string', required: false } },
  format_code: { path: { type: 'string', required: true, nonEmpty: true } },
  get_imports: { path: { type: 'string', required: true, nonEmpty: true } },
  path_info: { path: { type: 'string', required: true, nonEmpty: true } },
  url_encode: {
    text: { type: 'string', required: true },
    mode: { type: 'string', required: false },
  },
  hash_file: {
    path: { type: 'string', required: true, nonEmpty: true },
    algorithm: { type: 'string', required: false },
  },
  // Notebook
  notebook_create: {
    title: { type: 'string', required: true, nonEmpty: true },
    content: { type: 'string', required: false },
    tags: { type: 'string[]', required: false },
  },
  notebook_list: {},
  notebook_update: {
    id: { type: 'string', required: true, nonEmpty: true },
    title: { type: 'string', required: false },
    content: { type: 'string', required: false },
    tags: { type: 'string[]', required: false },
  },
  notebook_delete: { id: { type: 'string', required: true, nonEmpty: true } },
  notebook_view: { id: { type: 'string', required: true, nonEmpty: true } },
  notebook_search: { search: { type: 'string', required: true, nonEmpty: true } },
  notebook_addTag: {
    id: { type: 'string', required: true, nonEmpty: true },
    tags: { type: 'string[]', required: true },
  },
  notebook_removeTag: {
    id: { type: 'string', required: true, nonEmpty: true },
    tags: { type: 'string[]', required: true },
  },
  notebook_tree: {},
};

// ── Enum-like parameter values ───────────────────────────────────────────────
export const SORT_DIRECTIONS = ['asc', 'desc'] as const;
export const HASH_ALGORITHMS = ['md5', 'sha1', 'sha256', 'sha512'] as const;
export const DATE_FORMATS = ['iso', 'local', 'unix', 'date', 'time'] as const;
export const URL_ENCODE_MODES = ['encode', 'decode'] as const;

export type ExtraParamEnums = {
  readonly [K in ExtraAgentActionType]?: { readonly [P in keyof ParamsOf<K>]?: readonly string[] };
};

/** Allowed values for enum-like string params (checked only when the param is provided). */
export const EXTRA_PARAM_ENUMS: ExtraParamEnums = {
  sort_lines: { direction: SORT_DIRECTIONS },
  hash_text: { algorithm: HASH_ALGORITHMS },
  hash_file: { algorithm: HASH_ALGORITHMS },
  date_now: { format: DATE_FORMATS },
  url_encode: { mode: URL_ENCODE_MODES },
};

/** All extras action types, in table order. */
export const EXTRA_ACTION_TYPES: readonly ExtraAgentActionType[] = Object.keys(
  EXTRA_PARAM_SPECS,
) as ExtraAgentActionType[];

export function isExtraActionType(type: unknown): type is ExtraAgentActionType {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(EXTRA_PARAM_SPECS, type);
}

export function isExtraAgentAction(action: AgentAction | null | undefined): boolean {
  const type = (action as { type?: unknown } | null | undefined)?.type;
  return isExtraActionType(type);
}

// ── Internal helpers (never throw) ───────────────────────────────────────────
type Bag = Record<string, unknown>;

interface StrOpts {
  required: boolean;
  nonEmpty?: boolean;
  allowed?: readonly string[];
}

interface NumOpts {
  required: boolean;
  integer?: boolean;
  min?: number;
  max?: number;
}

interface PresenceOpts {
  required: boolean;
}

const REQ: StrOpts = { required: true };
const REQ_NE: StrOpts = { required: true, nonEmpty: true };
const OPT: StrOpts = { required: false };
const OPT_NE: StrOpts = { required: false, nonEmpty: true };

function isAbsent(v: unknown): boolean {
  return v === undefined || v === null;
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function show(v: unknown): string {
  if (typeof v === 'string') {
    const s = v.length > 60 ? `${v.slice(0, 57)}...` : v;
    return `"${s}"`;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return typeName(v);
}

function begin(action: unknown, expected: ExtraAgentActionType, errs: string[]): Bag | null {
  if (action === null || action === undefined || typeof action !== 'object' || Array.isArray(action)) {
    errs.push(`action must be an object (got ${typeName(action)}).`);
    return null;
  }
  const a = action as Bag;
  if (a.type !== undefined && a.type !== expected) {
    errs.push(`type must be "${expected}" (got ${show(a.type)}).`);
  }
  return a;
}

function checkString(a: Bag, key: string, errs: string[], opts: StrOpts): void {
  const v = a[key];
  const desc = opts.nonEmpty ? 'non-empty string' : 'string';
  if (isAbsent(v)) {
    if (opts.required) errs.push(`${key} is required and must be a ${desc}.`);
    return;
  }
  if (typeof v !== 'string') {
    errs.push(`${key} must be a ${desc} (got ${typeName(v)}).`);
    return;
  }
  if (opts.nonEmpty && v.trim() === '') {
    errs.push(`${key} must be a non-empty string.`);
    return;
  }
  if (opts.allowed && !opts.allowed.includes(v)) {
    errs.push(`${key} must be one of: ${opts.allowed.join(', ')} (got ${show(v)}).`);
  }
}

function checkNumber(a: Bag, key: string, errs: string[], opts: NumOpts): void {
  const v = a[key];
  const desc = opts.integer ? 'integer' : 'number';
  if (isAbsent(v)) {
    if (opts.required) errs.push(`${key} is required and must be a ${desc}.`);
    return;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    errs.push(`${key} must be a finite ${desc} (got ${show(v)}).`);
    return;
  }
  if (opts.integer && !Number.isInteger(v)) {
    errs.push(`${key} must be an integer (got ${v}).`);
    return;
  }
  if (opts.min !== undefined && v < opts.min) {
    errs.push(`${key} must be >= ${opts.min} (got ${v}).`);
  }
  if (opts.max !== undefined && v > opts.max) {
    errs.push(`${key} must be <= ${opts.max} (got ${v}).`);
  }
}

function checkBoolean(a: Bag, key: string, errs: string[], opts: PresenceOpts): void {
  const v = a[key];
  if (isAbsent(v)) {
    if (opts.required) errs.push(`${key} is required and must be a boolean.`);
    return;
  }
  if (typeof v !== 'boolean') {
    errs.push(`${key} must be a boolean (got ${show(v)}).`);
  }
}

function firstNonStringIndex(arr: unknown[]): number {
  for (let i = 0; i < arr.length; i++) {
    if (typeof arr[i] !== 'string') return i;
  }
  return -1;
}

function checkStringArray(a: Bag, key: string, errs: string[], opts: PresenceOpts): void {
  const v = a[key];
  if (isAbsent(v)) {
    if (opts.required) errs.push(`${key} is required and must be an array of strings.`);
    return;
  }
  if (!Array.isArray(v)) {
    errs.push(`${key} must be an array of strings (got ${typeName(v)}).`);
    return;
  }
  const bad = firstNonStringIndex(v);
  if (bad !== -1) {
    errs.push(`${key}[${bad}] must be a string (got ${typeName(v[bad])}).`);
  }
}

function checkStringOrStringArray(a: Bag, key: string, errs: string[], opts: PresenceOpts): void {
  const v = a[key];
  if (isAbsent(v)) {
    if (opts.required) errs.push(`${key} is required and must be a string or an array of strings.`);
    return;
  }
  if (typeof v === 'string') return;
  if (!Array.isArray(v)) {
    errs.push(`${key} must be a string or an array of strings (got ${typeName(v)}).`);
    return;
  }
  const bad = firstNonStringIndex(v);
  if (bad !== -1) {
    errs.push(`${key}[${bad}] must be a string (got ${typeName(v[bad])}).`);
  }
}

function checkRegexCompiles(a: Bag, errs: string[]): void {
  if (typeof a.pattern !== 'string') return;
  const flags = isAbsent(a.flags) ? 'gm' : a.flags;
  if (typeof flags !== 'string') return;
  try {
    new RegExp(a.pattern, flags);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errs.push(`pattern/flags do not form a valid regular expression: ${msg}`);
  }
}

// ── Shell-injection hardening helpers (never throw) ──────────────────────────
// All regexes below are non-global (except the two used only with
// String.prototype.replace, which resets lastIndex itself), so .test() is
// stateless and safe to reuse across calls.

/**
 * Bare concatenation: characters that let a value terminate, chain, substitute,
 * redirect, glob, expand or comment out parts of an unquoted shell command.
 */
const SHELL_METACHAR_RE = /[;&|$`()<>\n\r*?~#]/;

/**
 * Inside double quotes only  "  $  `  \  and newline keep a special meaning
 * (quote breakout, parameter/command substitution, escapes, line breaks).
 * ; & | < > * ? ~ # ( ) are literal inside "..." and intentionally allowed.
 */
const DQUOTE_BREAKOUT_RE = /["$`\\\n]/;

/** npm script names: letters, digits, colon, underscore, hyphen. */
const NPM_SCRIPT_RE = /^[A-Za-z0-9:_-]+$/;

/** calculate: tokens stripped before the character allowlist is applied. */
const CALC_STRIP_MATH_RE = /Math\.[A-Za-z_][A-Za-z0-9_]*/g;
const CALC_STRIP_CONST_RE = /\b(?:PI|E)\b/g;
/** calculate: mirrors the execution layer's character allowlist. */
const CALC_ALLOWED_RE = /^[\d\s+\-*/%().,^]+$/;
const CALC_DISALLOWED_CHAR_RE = /[^\d\s+\-*/%().,^]/;

const MAX_REPORTED_CHARS = 10;

/** Distinct characters of `s` matching the (non-global) single-char regex `re`. */
function findChars(s: string, re: RegExp): string[] {
  const found: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (re.test(ch) && !found.includes(ch)) found.push(ch);
  }
  return found;
}

/** Render characters as JSON string literals, e.g. ";" , "\n". */
function describeChars(chars: readonly string[]): string {
  const shown = chars.slice(0, MAX_REPORTED_CHARS).map((c) => JSON.stringify(c));
  if (chars.length > MAX_REPORTED_CHARS) shown.push('...');
  return shown.join(', ');
}

/**
 * Invoke `fn` for the string value of `key`, or for every string element when the
 * value is an array (labelled key[i]). Non-string values are skipped: their type
 * errors are reported by checkString / checkStringOrStringArray.
 */
function forEachStringValue(a: Bag, key: string, fn: (label: string, s: string) => void): void {
  const v = a[key];
  if (typeof v === 'string') {
    fn(key, v);
    return;
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const item = v[i];
      if (typeof item === 'string') fn(`${key}[${i}]`, item);
    }
  }
}

/**
 * For values concatenated UNQUOTED into a shell command.
 * Rejects ; & | $ ` ( ) < > \n \r * ? ~ #  (defense in depth, see file header).
 */
function rejectShellMetachars(a: Bag, key: string, errs: string[]): void {
  forEachStringValue(a, key, (label, s) => {
    const bad = findChars(s, SHELL_METACHAR_RE);
    if (bad.length > 0) {
      errs.push(
        `${label} contains shell metacharacters (${describeChars(bad)}) rejected to prevent command injection.`,
      );
    }
  });
}

/**
 * For values concatenated INSIDE DOUBLE QUOTES into a shell command.
 * Narrower than rejectShellMetachars on purpose: within "..." only  " $ ` \  and
 * newline are special. Characters such as ; & | < > ( ) # are plain text there, so
 * they are allowed (e.g. a commit message "fix: a & b; see #12" stays valid).
 */
function rejectDquoteBreakout(a: Bag, key: string, errs: string[]): void {
  forEachStringValue(a, key, (label, s) => {
    const bad = findChars(s, DQUOTE_BREAKOUT_RE);
    if (bad.length > 0) {
      errs.push(
        `${label} contains characters that are special inside double quotes (${describeChars(bad)}) rejected to prevent command injection.`,
      );
    }
  });
}

/** npm_run.script: allowlist; only applied when script is a string. */
function checkNpmScriptName(a: Bag, errs: string[]): void {
  const v = a.script;
  if (typeof v !== 'string') return;
  if (!NPM_SCRIPT_RE.test(v)) {
    const bad = findChars(v, /[^A-Za-z0-9:_-]/);
    const detail = bad.length > 0 ? `disallowed characters: ${describeChars(bad)}` : 'empty name';
    errs.push(
      `script must be an npm script name matching ^[A-Za-z0-9:_-]+$ (got ${show(v)}; ${detail}); rejected to prevent command injection.`,
    );
  }
}

/**
 * calculate.expression: mirrors the execution layer's allowlist (defense in depth).
 * Math.xxx calls/constants and bare PI / E tokens are stripped first; whatever is
 * left must consist only of digits, whitespace and  + - * / % ( ) . , ^
 * An empty remainder (e.g. "Math.PI") contains no characters at all and passes.
 */
function checkCalcExpression(a: Bag, errs: string[]): void {
  const v = a.expression;
  if (typeof v !== 'string' || v.trim() === '') return; // REQ_NE already reported
  const rest = v.replace(CALC_STRIP_MATH_RE, '').replace(CALC_STRIP_CONST_RE, '');
  if (rest === '') return;
  if (!CALC_ALLOWED_RE.test(rest)) {
    const bad = findChars(rest, CALC_DISALLOWED_CHAR_RE);
    errs.push(
      `expression contains characters outside the math allowlist (${describeChars(bad)}); ` +
        'only digits, whitespace, + - * / % ( ) . , ^, Math.* functions, PI and E are allowed.',
    );
  }
}

/**
 * Generic, table-driven validation against EXTRA_PARAM_SPECS + EXTRA_PARAM_ENUMS.
 * Used by the parity tests; the per-tool validators below additionally apply
 * tool-specific semantic checks (integer ranges, regex compilation, shell
 * hardening, ...).
 */
export function validateExtraParams(type: string, action: unknown): string[] {
  const errs: string[] = [];
  if (!isExtraActionType(type)) {
    errs.push(`unknown extras action type: ${show(type)}.`);
    return errs;
  }
  const a = begin(action, type, errs);
  if (!a) return errs;
  const spec = EXTRA_PARAM_SPECS[type] as unknown as Record<string, RuntimeParamSpec>;
  const enums = (EXTRA_PARAM_ENUMS[type] ?? {}) as Record<string, readonly string[] | undefined>;
  for (const key of Object.keys(spec)) {
    const p = spec[key];
    switch (p.type) {
      case 'string':
        checkString(a, key, errs, { required: p.required, nonEmpty: p.nonEmpty, allowed: enums[key] });
        break;
      case 'number':
        checkNumber(a, key, errs, { required: p.required });
        break;
      case 'boolean':
        checkBoolean(a, key, errs, { required: p.required });
        break;
      case 'string[]':
        checkStringArray(a, key, errs, { required: p.required });
        break;
      case 'string|string[]':
        checkStringOrStringArray(a, key, errs, { required: p.required });
        break;
    }
  }
  return errs;
}

// ── Dispatcher (function declarations below are hoisted) ─────────────────────
export type ExtraValidator = (action: any) => string[];

export const EXTRA_VALIDATORS: Readonly<Record<ExtraAgentActionType, ExtraValidator>> = {
  delete_file: validateDeleteFileAction,
  move_file: validateMoveFileAction,
  copy_file: validateCopyFileAction,
  create_directory: validateCreateDirectoryAction,
  delete_directory: validateDeleteDirectoryAction,
  file_info: validateFileInfoAction,
  list_directory: validateListDirectoryAction,
  git_status: validateGitStatusAction,
  git_diff: validateGitDiffAction,
  git_log: validateGitLogAction,
  git_add: validateGitAddAction,
  git_commit: validateGitCommitAction,
  git_branch: validateGitBranchAction,
  regex_match: validateRegexMatchAction,
  json_query: validateJsonQueryAction,
  format_json: validateFormatJsonAction,
  diff_text: validateDiffTextAction,
  sort_lines: validateSortLinesAction,
  dedupe_lines: validateDedupeLinesAction,
  count_lines: validateCountLinesAction,
  base64_encode: validateBase64EncodeAction,
  base64_decode: validateBase64DecodeAction,
  hash_text: validateHashTextAction,
  generate_uuid: validateGenerateUuidAction,
  get_env: validateGetEnvAction,
  which_command: validateWhichCommandAction,
  get_system_info: validateGetSystemInfoAction,
  date_now: validateDateNowAction,
  calculate: validateCalculateAction,
  check_url: validateCheckUrlAction,
  download_file: validateDownloadFileAction,
  dns_lookup: validateDnsLookupAction,
  parse_url: validateParseUrlAction,
  npm_run: validateNpmRunAction,
  format_code: validateFormatCodeAction,
  get_imports: validateGetImportsAction,
  path_info: validatePathInfoAction,
  url_encode: validateUrlEncodeAction,
  hash_file: validateHashFileAction,
  notebook_create: validateNotebookCreateAction,
  notebook_list: validateNotebookListAction,
  notebook_update: validateNotebookUpdateAction,
  notebook_delete: validateNotebookDeleteAction,
  notebook_view: validateNotebookViewAction,
  notebook_search: validateNotebookSearchAction,
  notebook_addTag: validateNotebookAddTagAction,
  notebook_removeTag: validateNotebookRemoveTagAction,
  notebook_tree: validateNotebookTreeAction,
};

/** Validate any extras action by its `type`. Returns errors for non-extras types. */
export function validateExtraAction(action: AgentAction | null | undefined): string[] {
  const type = (action as { type?: unknown } | null | undefined)?.type;
  if (!isExtraActionType(type)) {
    return [`not an extras action type: ${show(type)}.`];
  }
  return EXTRA_VALIDATORS[type](action);
}

// ── Validator <-> buildExtraToolDefs() input_schema audit (48 tools) ─────────
// Checked per field: required (listed in schema `required`), type, allowed set for
// enum-like fields (taken from the schema description), nonEmpty (paths/ids/messages).
// Result: required/type/allowed match input_schema for all 48 tools; no mismatch
// required a fix. Places where the validator is intentionally stricter than the
// schema are marked (+). NE is always a validator-side addition (the schema has no
// minLength) and is applied to required path/id/message-like fields.
// Legend: R=required O=optional NE=non-empty S=shell blacklist D=dquote check
//
//  #  tool                field              req type             extra
//  1  delete_file         path               R   string           NE
//  2  move_file           from, to           R   string           NE
//  3  copy_file           from, to           R   string           NE
//  4  create_directory    path               R   string           NE
//  5  delete_directory    path               R   string           NE
//                         force              O   boolean
//  6  file_info           path               R   string           NE
//  7  list_directory      path               O   string           (default: current dir)
//  8  git_status          (no params)
//  9  git_diff            staged             O   boolean
//                         path               O   string           S
// 10  git_log             limit              O   number           (+) integer >= 1
// 11  git_add             paths              O   string|string[]  S (each element); schema has no
//                                                                 `type`, description says "string or array"
// 12  git_commit          message            R   string           NE, D
// 13  git_branch          create             O   string           NE (+), S
//                         checkout           O   string           NE (+), S
// 14  regex_match         text               R   string
//                         pattern            R   string           (+) must compile with flags
//                         flags              O   string           (default "gm")
// 15  json_query          json, query        R   string
// 16  format_json         text               R   string
//                         indent             O   number           (+) integer 0..10
// 17  diff_text           original, modified R   string
// 18  sort_lines          text               R   string
//                         direction          O   string           asc | desc
// 19  dedupe_lines        text               R   string
// 20  count_lines         path               R   string           NE
// 21  base64_encode       text               R   string
// 22  base64_decode       text               R   string
// 23  hash_text           text               R   string
//                         algorithm          O   string           md5 | sha1 | sha256 | sha512
// 24  generate_uuid       (no params)
// 25  get_env             key                O   string
//                         keys               O   string[]
// 26  which_command       command            R   string           NE, S
// 27  get_system_info     (no params)
// 28  date_now            format             O   string           iso | local | unix | date | time (+)
//                                                                 execDateNow falls back to toString()
//                                                                 for unknown values; the validator keeps
//                                                                 the allowlist (stricter is acceptable)
// 29  calculate           expression         R   string           NE, (+) math character allowlist
// 30  check_url           url                R   string           NE
// 31  download_file       url                R   string           NE
//                         destination        O   string
// 32  dns_lookup          hostname           R   string           NE
// 33  parse_url           url                R   string           NE
// 34  npm_run             script             O   string           (+) ^[A-Za-z0-9:_-]+$ (default: test)
// 35  format_code         path               R   string           NE, D
// 36  get_imports         path               R   string           NE
// 37  path_info           path               R   string           NE
// 38  url_encode          text               R   string
//                         mode               O   string           encode | decode
// 39  hash_file           path               R   string           NE
//                         algorithm          O   string           md5 | sha1 | sha256 | sha512
// 40  notebook_create     title              R   string           NE
//                         content            O   string
//                         tags               O   string[]
// 41  notebook_list       (no params)
// 42  notebook_update     id                 R   string           NE
//                         title, content     O   string
//                         tags               O   string[]
// 43  notebook_delete     id                 R   string           NE
// 44  notebook_view       id                 R   string           NE
// 45  notebook_search     search             R   string           NE
// 46  notebook_addTag     id                 R   string           NE
//                         tags               R   string[]
// 47  notebook_removeTag  id                 R   string           NE
//                         tags               R   string[]
// 48  notebook_tree       (no params)
//
// Optional path-like fields (list_directory.path, git_diff.path,
// download_file.destination) intentionally stay without NE: the schema documents
// defaults for them and tightening would reject previously valid input.

// ── File operations ──────────────────────────────────────────────────────────
export function validateDeleteFileAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'delete_file', errs);
  if (!a) return errs;
  checkString(a, 'path', errs, REQ_NE);
  return errs;
}

export function validateMoveFileAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'move_file', errs);
  if (!a) return errs;
  checkString(a, 'from', errs, REQ_NE);
  checkString(a, 'to', errs, REQ_NE);
  return errs;
}

export function validateCopyFileAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'copy_file', errs);
  if (!a) return errs;
  checkString(a, 'from', errs, REQ_NE);
  checkString(a, 'to', errs, REQ_NE);
  return errs;
}

export function validateCreateDirectoryAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'create_directory', errs);
  if (!a) return errs;
  checkString(a, 'path', errs, REQ_NE);
  return errs;
}

export function validateDeleteDirectoryAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'delete_directory', errs);
  if (!a) return errs;
  checkString(a, 'path', errs, REQ_NE);
  checkBoolean(a, 'force', errs, { required: false });
  return errs;
}

export function validateFileInfoAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'file_info', errs);
  if (!a) return errs;
  checkString(a, 'path', errs, REQ_NE);
  return errs;
}

export function validateListDirectoryAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'list_directory', errs);
  if (!a) return errs;
  checkString(a, 'path', errs, OPT);
  return errs;
}

// ── Git ──────────────────────────────────────────────────────────────────────
export function validateGitStatusAction(action: any): string[] {
  const errs: string[] = [];
  begin(action, 'git_status', errs);
  return errs;
}

export function validateGitDiffAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'git_diff', errs);
  if (!a) return errs;
  checkBoolean(a, 'staged', errs, { required: false });
  checkString(a, 'path', errs, OPT);
  rejectShellMetachars(a, 'path', errs); // bare concatenation
  return errs;
}

export function validateGitLogAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'git_log', errs);
  if (!a) return errs;
  checkNumber(a, 'limit', errs, { required: false, integer: true, min: 1 });
  return errs;
}

export function validateGitAddAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'git_add', errs);
  if (!a) return errs;
  checkStringOrStringArray(a, 'paths', errs, { required: false });
  rejectShellMetachars(a, 'paths', errs); // bare concatenation (string or each element)
  return errs;
}

export function validateGitCommitAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'git_commit', errs);
  if (!a) return errs;
  checkString(a, 'message', errs, REQ_NE);
  rejectDquoteBreakout(a, 'message', errs); // embedded inside "..."
  return errs;
}

export function validateGitBranchAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'git_branch', errs);
  if (!a) return errs;
  checkString(a, 'create', errs, OPT_NE);
  checkString(a, 'checkout', errs, OPT_NE);
  rejectShellMetachars(a, 'create', errs); // bare concatenation
  rejectShellMetachars(a, 'checkout', errs); // bare concatenation
  return errs;
}

// ── Text processing ──────────────────────────────────────────────────────────
export function validateRegexMatchAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'regex_match', errs);
  if (!a) return errs;
  checkString(a, 'text', errs, REQ);
  checkString(a, 'pattern', errs, REQ);
  checkString(a, 'flags', errs, OPT);
  if (errs.length === 0) checkRegexCompiles(a, errs);
  return errs;
}

export function validateJsonQueryAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'json_query', errs);
  if (!a) return errs;
  checkString(a, 'json', errs, REQ);
  checkString(a, 'query', errs, REQ);
  return errs;
}

export function validateFormatJsonAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'format_json', errs);
  if (!a) return errs;
  checkString(a, 'text', errs, REQ);
  checkNumber(a, 'indent', errs, { required: false, integer: true, min: 0, max: 10 });
  return errs;
}

export function validateDiffTextAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'diff_text', errs);
  if (!a) return errs;
  checkString(a, 'original', errs, REQ);
  checkString(a, 'modified', errs, REQ);
  return errs;
}

export function validateSortLinesAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'sort_lines', errs);
  if (!a) return errs;
  checkString(a, 'text', errs, REQ);
  checkString(a, 'direction', errs, { required: false, allowed: SORT_DIRECTIONS });
  return errs;
}

export function validateDedupeLinesAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'dedupe_lines', errs);
  if (!a) return errs;
  checkString(a, 'text', errs, REQ);
  return errs;
}

export function validateCountLinesAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'count_lines', errs);
  if (!a) return errs;
  checkString(a, 'path', errs, REQ_NE);
  return errs;
}

// ── Encoding / Crypto ────────────────────────────────────────────────────────
export function validateBase64EncodeAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'base64_encode', errs);
  if (!a) return errs;
  checkString(a, 'text', errs, REQ);
  return errs;
}

export function validateBase64DecodeAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'base64_decode', errs);
  if (!a) return errs;
  checkString(a, 'text', errs, REQ);
  return errs;
}

export function validateHashTextAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'hash_text', errs);
  if (!a) return errs;
  checkString(a, 'text', errs, REQ);
  checkString(a, 'algorithm', errs, { required: false, allowed: HASH_ALGORITHMS });
  return errs;
}

export function validateGenerateUuidAction(action: any): string[] {
  const errs: string[] = [];
  begin(action, 'generate_uuid', errs);
  return errs;
}

// ── System ───────────────────────────────────────────────────────────────────
export function validateGetEnvAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'get_env', errs);
  if (!a) return errs;
  checkString(a, 'key', errs, OPT);
  checkStringArray(a, 'keys', errs, { required: false });
  return errs;
}

export function validateWhichCommandAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'which_command', errs);
  if (!a) return errs;
  checkString(a, 'command', errs, REQ_NE);
  rejectShellMetachars(a, 'command', errs); // bare concatenation
  return errs;
}

export function validateGetSystemInfoAction(action: any): string[] {
  const errs: string[] = [];
  begin(action, 'get_system_info', errs);
  return errs;
}

export function validateDateNowAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'date_now', errs);
  if (!a) return errs;
  // Stricter than execDateNow (which falls back to toString() for unknown formats).
  checkString(a, 'format', errs, { required: false, allowed: DATE_FORMATS });
  return errs;
}

export function validateCalculateAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'calculate', errs);
  if (!a) return errs;
  checkString(a, 'expression', errs, REQ_NE);
  checkCalcExpression(a, errs); // mirrors the execution-layer allowlist
  return errs;
}

// ── Network ──────────────────────────────────────────────────────────────────
export function validateCheckUrlAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'check_url', errs);
  if (!a) return errs;
  checkString(a, 'url', errs, REQ_NE);
  return errs;
}

export function validateDownloadFileAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'download_file', errs);
  if (!a) return errs;
  checkString(a, 'url', errs, REQ_NE);
  checkString(a, 'destination', errs, OPT);
  return errs;
}

export function validateDnsLookupAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'dns_lookup', errs);
  if (!a) return errs;
  checkString(a, 'hostname', errs, REQ_NE);
  return errs;
}

export function validateParseUrlAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'parse_url', errs);
  if (!a) return errs;
  checkString(a, 'url', errs, REQ_NE);
  return errs;
}

// ── Development ──────────────────────────────────────────────────────────────
export function validateNpmRunAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'npm_run', errs);
  if (!a) return errs;
  checkString(a, 'script', errs, OPT);
  checkNpmScriptName(a, errs); // allowlist
  return errs;
}

export function validateFormatCodeAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'format_code', errs);
  if (!a) return errs;
  checkString(a, 'path', errs, REQ_NE);
  rejectDquoteBreakout(a, 'path', errs); // embedded inside "..."
  return errs;
}

export function validateGetImportsAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'get_imports', errs);
  if (!a) return errs;
  checkString(a, 'path', errs, REQ_NE);
  return errs;
}

export function validatePathInfoAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'path_info', errs);
  if (!a) return errs;
  checkString(a, 'path', errs, REQ_NE);
  return errs;
}

export function validateUrlEncodeAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'url_encode', errs);
  if (!a) return errs;
  checkString(a, 'text', errs, REQ);
  checkString(a, 'mode', errs, { required: false, allowed: URL_ENCODE_MODES });
  return errs;
}

export function validateHashFileAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'hash_file', errs);
  if (!a) return errs;
  checkString(a, 'path', errs, REQ_NE);
  checkString(a, 'algorithm', errs, { required: false, allowed: HASH_ALGORITHMS });
  return errs;
}

// ── Notebook ─────────────────────────────────────────────────────────────────
export function validateNotebookCreateAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'notebook_create', errs);
  if (!a) return errs;
  checkString(a, 'title', errs, REQ_NE);
  checkString(a, 'content', errs, OPT);
  checkStringArray(a, 'tags', errs, { required: false });
  return errs;
}

export function validateNotebookListAction(action: any): string[] {
  const errs: string[] = [];
  begin(action, 'notebook_list', errs);
  return errs;
}

export function validateNotebookUpdateAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'notebook_update', errs);
  if (!a) return errs;
  checkString(a, 'id', errs, REQ_NE);
  checkString(a, 'title', errs, OPT);
  checkString(a, 'content', errs, OPT);
  checkStringArray(a, 'tags', errs, { required: false });
  return errs;
}

export function validateNotebookDeleteAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'notebook_delete', errs);
  if (!a) return errs;
  checkString(a, 'id', errs, REQ_NE);
  return errs;
}

export function validateNotebookViewAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'notebook_view', errs);
  if (!a) return errs;
  checkString(a, 'id', errs, REQ_NE);
  return errs;
}

export function validateNotebookSearchAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'notebook_search', errs);
  if (!a) return errs;
  checkString(a, 'search', errs, REQ_NE);
  return errs;
}

export function validateNotebookAddTagAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'notebook_addTag', errs);
  if (!a) return errs;
  checkString(a, 'id', errs, REQ_NE);
  checkStringArray(a, 'tags', errs, { required: true });
  return errs;
}

export function validateNotebookRemoveTagAction(action: any): string[] {
  const errs: string[] = [];
  const a = begin(action, 'notebook_removeTag', errs);
  if (!a) return errs;
  checkString(a, 'id', errs, REQ_NE);
  checkStringArray(a, 'tags', errs, { required: true });
  return errs;
}

export function validateNotebookTreeAction(action: any): string[] {
  const errs: string[] = [];
  begin(action, 'notebook_tree', errs);
  return errs;
}
