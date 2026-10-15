/**
 * Browser-driven brain tools — Playwright over Chromium.
 *
 * Designed to handle the case where http_request gets blocked by anti-bot
 * (Cloudflare, JS rendering, captcha): brain switches to these tools and
 * drives a real visible browser on the user's home Mac.
 *
 * Pattern: brain calls `browser_navigate` → reads page → calls
 * `browser_extract_text` or `browser_screenshot` → maybe `browser_click`
 * to drill in → repeats until it has the answer.
 *
 * Output shape: each tool returns `{ ok, output }`. For navigate/extract
 * the output is the visible text (truncated). For screenshot the output
 * is a path to the saved PNG, and inside an agent run the image itself is
 * shown to the model on its next step, the way view_image does.
 *
 * Live mode (liveBrowser.ts): the owner can take the browser over from the
 * web app. While they hold it, page tools wait briefly and then report that
 * the user is in control; after they hand it back, the next tool result
 * starts with a short note on where the browser is now.
 * browser_request_handoff asks the owner to take over (sign in, solve a
 * check) and waits until they hand back.
 */

import {
  hasIdentityPlaceholder,
  hasLiveIdentitySecrets,
  hasTypedIdentitySecrets,
  identityFingerprints,
  LIVE_SECRET_REFUSAL,
  onIdentityLiveWindow,
  resolveIdentityPlaceholders,
  SECRET_FIELD_ATTRIBUTE,
} from '../../security/identityCredentials.js';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setBrowserWorkspace } from './fileGuard.js';
import {
  getActivePage,
  closeActivePage,
  describePlaywrightError,
  readConsoleBuffer,
  readNetworkBuffer,
  clearEventBuffers,
  setEventCaptureGate,
  listTabs,
  openTab,
  switchTab,
  closeTab,
  focusTarget,
  isLiveBrowser,
  reportActiveTab,
  takeCrashNote,
  reportSecretState,
  hostSecretState,
  redactShown,
  targetIdOf,
} from './browserSession.js';
import type { Page } from 'playwright';
import { isAlwaysPrivatePath, resolveArtemisHomeDir, resolveInsideRoot } from '../../utils/fs.js';
import type { ToolExecutionContext } from '../types.js';
import {
  browserGate,
  emitHandoff,
  handbackNote,
  liveDir,
  newHandoffId,
  PAUSE_USED_UP,
  readControl,
  userInControlMessage,
  waitForHandback,
} from './liveBrowser.js';

// Sign-up passwords (security/identityCredentials.ts): nothing is recorded in the
// console / request logs while one is live, and both logs are cleared when one goes
// live and when it stops being live, so nothing from around that window is read later.
// In live mode the logs only ever hold this run's own tabs, and while any run on the
// shared browser has a password live, they are refused here too (refusalForScripts).
setEventCaptureGate(() => !hasLiveIdentitySecrets());
onIdentityLiveWindow(() => clearEventBuffers('all'));

export interface ToolResult {
  ok: boolean;
  output: string;
  error?: { code: string; message: string };
}

const SCREENSHOT_DIR = path.join(resolveArtemisHomeDir(), 'browser-screenshots');
const MAX_TEXT_OUTPUT = 8000;

function pwError(err: unknown): ToolResult {
  const message = describePlaywrightError(err);
  return {
    ok: false,
    output: `浏览器操作失败：${message}`,
    error: { code: 'browser_error', message },
  };
}

function isContextClosedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Target page, context or browser has been closed|Target closed|Connection closed|Browser closed/i.test(msg);
}

/**
 * Run a page operation; if it fails because the context/page closed between
 * acquiring the page and calling the op (a known Playwright race in long-lived
 * sessions), close the dead page and retry once with a fresh page.
 */
function restorableUrl(page: Page): string | undefined {
  try {
    const current = page.url();
    if (!current || current === 'about:blank') return undefined;
    return current;
  } catch {
    return undefined;
  }
}

async function withPageRetry<T>(
  op: (page: Page) => Promise<T>,
  options?: { restoreUrlOnRetry?: boolean },
): Promise<T> {
  let restoreUrl: string | undefined;
  try {
    const page = await getActivePage();
    if (options?.restoreUrlOnRetry) restoreUrl = restorableUrl(page);
    return await op(page);
  } catch (err) {
    if (!isContextClosedError(err)) throw err;
    await closeActivePage().catch(() => undefined);
    const page = await getActivePage();
    if (restoreUrl) {
      await page.goto(restoreUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }
    return await op(page);
  }
}

function truncate(s: string, max = MAX_TEXT_OUTPUT): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n...[truncated ${s.length - max} chars]`;
}

// ── browser_navigate ────────────────────────────────────────────────────

export interface BrowserNavigateAction {
  type: 'browser_navigate';
  url?: string;
  /** A page in the workspace, opened directly (file://): no server needed to look at it. */
  path?: string;
  waitFor?: 'load' | 'domcontentloaded' | 'networkidle';
  extractText?: boolean;
}

/**
 * The file:// URL of a workspace page: inside the workspace only, never a
 * protected directory; a folder opens its index.html. The checks are made on
 * the file that will really be opened (after the folder's index.html is
 * added and every symlink followed), and that real path is what opens.
 */
export async function workspacePageUrl(inputPath: string, cwd: string): Promise<string> {
  const absolute = resolveInsideRoot(cwd, inputPath.trim().replace(/^file:\/\//i, ''));
  if (isAlwaysPrivatePath(absolute)) throw new Error(`${inputPath} is in a protected directory`);
  const info = await fsp.stat(absolute);
  const file = info.isDirectory() ? path.join(absolute, 'index.html') : absolute;
  const real = await fsp.realpath(file);
  const root = await fsp.realpath(cwd);
  const relative = path.relative(root, real);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Path escapes working directory: ${inputPath}`);
  if (isAlwaysPrivatePath(real)) throw new Error(`${inputPath} is in a protected directory`);
  if (!(await fsp.stat(real)).isFile()) throw new Error(`${inputPath} is not a page`);
  return pathToFileURL(real).href;
}

/**
 * A `file:` URL (also behind `view-source:`) is held to the same rules as
 * `path`: a page inside the workspace, outside the protected directories,
 * opened as its real path. The scheme is read as the browser reads it (a
 * URL parser, which drops tabs and line breaks anywhere and control
 * characters in front), and a URL holding any of those is refused outright.
 * Other URLs are returned as they are. Pages a page opens itself go through
 * the browser's own guard (fileGuard.ts).
 */
export async function checkedPageUrl(url: string, cwd: string): Promise<string> {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(url)) throw new Error('the URL holds control characters, tabs or line breaks');
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    if (/file:/i.test(trimmed)) throw new Error('not a URL the browser reads the same way');
    return url;
  }
  if (parsed.protocol === 'view-source:') {
    const inner = trimmed.replace(/^view-source:/i, '');
    return `view-source:${await checkedPageUrl(inner, cwd)}`;
  }
  if (parsed.protocol !== 'file:') return url;
  let file: string;
  try {
    file = fileURLToPath(parsed);
  } catch (err) {
    throw new Error(`not a local file URL (${err instanceof Error ? err.message : String(err)})`);
  }
  return workspacePageUrl(file, cwd);
}

function fileUrlRefusal(url: string, err: unknown): ToolResult {
  const message = `Cannot open ${url}: ${err instanceof Error ? err.message : String(err)}`;
  return { ok: false, output: `${message}. A file:// URL opens a page inside the workspace only.`, error: { code: 'invalid_input', message } };
}

async function runBrowserNavigate(action: BrowserNavigateAction, cwd: string = process.cwd()): Promise<ToolResult> {
  const hasPath = typeof action.path === 'string' && action.path.trim().length > 0;
  if (!hasPath && (!action.url || action.url.trim().length === 0)) {
    return {
      ok: false,
      output: 'url 或 path 必填',
      error: { code: 'invalid_input', message: 'url or path required' },
    };
  }
  let target = action.url ?? '';
  if (hasPath) {
    try {
      target = await workspacePageUrl(action.path!, cwd);
    } catch (err) {
      const message = `Cannot open ${action.path} from the workspace: ${err instanceof Error ? err.message : String(err)}`;
      return { ok: false, output: `${message}. path opens a page inside the workspace only; use url for other pages.`, error: { code: 'invalid_input', message } };
    }
  } else {
    try {
      target = await checkedPageUrl(target, cwd);
    } catch (err) {
      return fileUrlRefusal(target, err);
    }
  }
  const scriptUrl = /^\s*(javascript|vbscript):/i.test(target);
  // A script URL is a page script too.
  if (scriptUrl && hasLiveIdentitySecrets()) return liveSecretRefusal();
  try {
    return await withPageRetry(async (page) => {
      if (scriptUrl) {
        const refused = await refusalForScripts(page);
        if (refused) return refused;
      }
      const waitUntil = action.waitFor ?? 'domcontentloaded';
      await page.goto(target, { waitUntil, timeout: 30_000 });
      const title = await page.title();
      const finalUrl = page.url();

      let extracted = '';
      if (action.extractText !== false) {
        try {
          extracted = await page.evaluate(() => document.body?.innerText ?? '');
        } catch {
          /* page might be closed or weird state */
        }
      }
      const head = `🌐 ${title}\n   ${finalUrl}`;
      const body = extracted.trim().length > 0
        ? `\n\n--- page text ---\n${truncate(extracted.trim())}`
        : '';
      return { ok: true, output: head + body };
    });
  } catch (err) {
    return pwError(err);
  }
}

// ── browser_screenshot ──────────────────────────────────────────────────

export interface BrowserScreenshotAction {
  type: 'browser_screenshot';
  fullPage?: boolean;
  width?: number;
  height?: number;
}

function normalizeViewportDimension(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded < min || rounded > max) return undefined;
  return rounded;
}

async function collectLayoutAudit(page: Awaited<ReturnType<typeof getActivePage>>): Promise<string> {
  try {
    const audit = await page.evaluate(() => {
      const root = document.documentElement;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const visibleElements = Array.from(document.body?.querySelectorAll('*') ?? [])
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            rect.bottom >= 0 &&
            rect.top <= viewportHeight;
        });
      const overflowingElements = visibleElements
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.left < -1 || rect.right > viewportWidth + 1;
        })
        .slice(0, 5)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            id: el.id,
            className: String((el as HTMLElement).className ?? '').slice(0, 80),
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
          };
        });
      const clippedTextCount = visibleElements.filter((el) => {
        const node = el as HTMLElement;
        if (!node.innerText || node.innerText.trim().length < 8) return false;
        return node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1;
      }).length;

      return {
        viewportWidth,
        viewportHeight,
        documentWidth: root.scrollWidth,
        documentHeight: root.scrollHeight,
        horizontalOverflow: root.scrollWidth > viewportWidth + 1,
        overflowingElements,
        clippedTextCount,
      };
    });

    const overflow = audit.horizontalOverflow ? 'yes' : 'no';
    const offenders = audit.overflowingElements.length > 0
      ? ` offenders=${audit.overflowingElements.map((el) =>
          `${el.tag}${el.id ? `#${el.id}` : ''}${el.className ? `.${el.className.replace(/\s+/g, '.')}` : ''}[${el.left},${el.right}]`,
        ).join('; ')}`
      : '';
    return `layout audit: viewport=${audit.viewportWidth}x${audit.viewportHeight} document=${audit.documentWidth}x${audit.documentHeight} horizontalOverflow=${overflow} clippedTextElements=${audit.clippedTextCount}${offenders}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `layout audit unavailable: ${message}`;
  }
}

/** What a field is and which page (its own frame) it is on: a sign-up password goes only into a password field of its site. */
async function fieldInfo(el: import('playwright').Locator): Promise<{ inputType: string; frameUrl: string }> {
  return el.evaluate((node) => ({
    inputType: node instanceof HTMLInputElement ? node.type.toLowerCase() : node.tagName.toLowerCase(),
    frameUrl: location.href,
  }), undefined, { timeout: 10_000 });
}

/** Marks a field a sign-up password was typed into (screenshots mask it; a switch to text blocks them). */
async function markSecretField(el: import('playwright').Locator): Promise<void> {
  await el.evaluate((node, attr) => node.setAttribute(attr, '1'), SECRET_FIELD_ATTRIBUTE).catch(() => undefined);
}

/**
 * Once a sign-up password was typed: refuse when a marked field is no longer
 * a password field (switched to text, it would show in the picture); else
 * the fields to mask, in every frame.
 */
async function secretScreenshotGuard(page: import('playwright').Page): Promise<{ ok: true; mask: import('playwright').Locator[] } | { ok: false; message: string }> {
  if (!hasTypedIdentitySecrets()) return { ok: true, mask: [] };
  const mask: import('playwright').Locator[] = [];
  for (const frame of page.frames()) {
    const exposed = await frame
      .evaluate((attr) => [...document.querySelectorAll(`[${attr}]`)].some((n) => !(n instanceof HTMLInputElement) || n.type.toLowerCase() !== 'password'), SECRET_FIELD_ATTRIBUTE)
      .catch(() => false);
    if (exposed) return { ok: false, message: 'A password field on this page shows its text; no screenshot while it does.' };
    mask.push(frame.locator(`[${SECRET_FIELD_ATTRIBUTE}], input[type="password"]`));
  }
  return { ok: true, mask };
}

async function runBrowserScreenshot(action: BrowserScreenshotAction, context?: ToolExecutionContext): Promise<ToolResult> {
  try {
    return await withPageRetry(async (page) => {
      const width = normalizeViewportDimension(action.width, 240, 4096);
      const height = normalizeViewportDimension(action.height, 240, 4096);
      if (width && height) {
        await page.setViewportSize({ width, height });
      }
      await fsp.mkdir(SCREENSHOT_DIR, { recursive: true });
      const filename = `screenshot-${Date.now()}.png`;
      const filepath = path.join(SCREENSHOT_DIR, filename);
      const guard = await secretScreenshotGuard(page);
      if (!guard.ok) return { ok: false, output: guard.message, error: { code: 'secret_visible', message: guard.message } };
      // On a site where a stored credential was typed, a page echoing it is masked in the picture too.
      const unmask = await maskSecretsForScreenshot(page);
      try {
        await page.screenshot({ path: filepath, fullPage: action.fullPage === true, ...(guard.mask.length ? { mask: guard.mask } : {}) });
      } finally {
        await unmask();
      }
      const audit = await collectLayoutAudit(page);
      const seen = await showScreenshotToModel(filepath, context);
      return {
        ok: true,
        output: `📸 已截图：${filepath}\n   URL: ${page.url()}\n   ${audit}${seen ? `\n${seen}` : ''}`,
      };
    }, { restoreUrlOnRetry: true });
  } catch (err) {
    return pwError(err);
  }
}

/**
 * Replaces the stored secrets this run typed (in text and in the values of
 * fields other than password fields, which the browser masks itself) with
 * •••• for the moment of a screenshot, then puts the page back. Only on a
 * site where they were typed: another site never gets them, even to mask.
 */
export async function maskSecretsForScreenshot(page: Awaited<ReturnType<typeof getActivePage>>): Promise<() => Promise<void>> {
  let origin = '';
  try {
    origin = new URL(page.url()).origin.toLowerCase();
  } catch {
    origin = '';
  }
  if (!credentialOrigins.has(origin)) return async () => undefined;
  const secrets = [...(typedSecrets.get(origin) ?? [])].sort((a, b) => b.length - a.length);
  if (!secrets.length) return async () => undefined;
  // A plain script (no compiled helpers in it): every text node and non-password field value.
  const token = await page
    .evaluate(`(() => {
      const list = ${JSON.stringify(secrets)};
      const masked = [], inputs = [];
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.nodeValue || '';
        let out = text;
        for (const s of list) out = out.split(s).join('••••');
        if (out !== text) { masked.push([node, text]); node.nodeValue = out; }
      }
      for (const el of Array.from(document.querySelectorAll('input, textarea'))) {
        if ((el.getAttribute('type') || '').toLowerCase() === 'password') continue;
        let out = el.value;
        for (const s of list) out = out.split(s).join('••••');
        if (out !== el.value) { inputs.push([el, el.value]); el.value = out; }
      }
      window.__artemisMasked = { masked, inputs };
      return true;
    })()`)
    .catch(() => false);
  if (!token) return async () => undefined;
  return async () => {
    await page
      .evaluate(`(() => {
        const m = window.__artemisMasked;
        if (!m) return;
        for (const [node, text] of m.masked) node.nodeValue = text;
        for (const [el, value] of m.inputs) el.value = value;
        delete window.__artemisMasked;
      })()`)
      .catch(() => undefined);
  };
}

// ── browser_extract_text ────────────────────────────────────────────────

export interface BrowserExtractAction {
  type: 'browser_extract_text';
  selector?: string; // CSS selector; default: whole body
}

async function runBrowserExtract(action: BrowserExtractAction): Promise<ToolResult> {
  try {
    return await withPageRetry(async (page) => {
      let text: string;
      if (action.selector && action.selector.trim().length > 0) {
        const el = page.locator(action.selector).first();
        // A password field is never read back (its value is what was typed into it).
        const isPassword = await el.evaluate((node) => node.tagName.toLowerCase() === 'input' && ((node as HTMLInputElement).getAttribute('type') ?? '').toLowerCase() === 'password', undefined, { timeout: 10_000 }).catch(() => false);
        if (isPassword) {
          const message = 'Password fields are not read back.';
          return { ok: false, output: message, error: { code: 'credential_field_locked', message } };
        }
        text = await el.innerText({ timeout: 10_000 });
      } else {
        text = await page.evaluate(() => document.body?.innerText ?? '');
      }
      return {
        ok: true,
        output: truncate(text.trim() || '(empty)'),
      };
    }, { restoreUrlOnRetry: true });
  } catch (err) {
    return pwError(err);
  }
}

// ── browser_click ───────────────────────────────────────────────────────

export interface BrowserClickAction {
  type: 'browser_click';
  selector?: string; // CSS selector
  text?: string; // alternatively, clickable text content
  x?: number; // alternatively, viewport coordinates (e.g. from a screenshot)
  y?: number;
}

async function runBrowserClick(action: BrowserClickAction): Promise<ToolResult> {
  const hasCoords = typeof action.x === 'number' && typeof action.y === 'number';
  if (!action.selector && !action.text && !hasCoords) {
    return {
      ok: false,
      output: '需要 selector、text 或 x+y 坐标至少一种',
      error: { code: 'invalid_input', message: 'selector, text, or x+y required' },
    };
  }
  try {
    return await withPageRetry(async (page) => {
      let target: string;
      if (action.selector) {
        await page.locator(action.selector).first().click({ timeout: 10_000 });
        target = action.selector;
      } else if (action.text) {
        // Match by visible text (Playwright's getByText)
        await page.getByText(action.text, { exact: false }).first().click({ timeout: 10_000 });
        target = action.text;
      } else {
        // Coordinate fallback — pairs with browser_screenshot for elements no
        // selector reaches (canvas, shadow DOM, custom widgets).
        await page.mouse.click(action.x!, action.y!);
        target = `(${action.x}, ${action.y})`;
      }
      // Wait briefly for any navigation/reaction
      await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined);
      return {
        ok: true,
        output: `🖱  已点击：${target}\n   当前 URL: ${page.url()}`,
      };
    }, { restoreUrlOnRetry: true });
  } catch (err) {
    return pwError(err);
  }
}

// ── browser_form_input ──────────────────────────────────────────────────

export interface BrowserFormInputAction {
  type: 'browser_form_input';
  selector: string;
  /** For <select>: option value or visible label. For text inputs: the text. */
  value?: string;
  /** For multi-select: several option values/labels. */
  values?: string[];
  /** For checkbox / radio: desired checked state (default true). */
  checked?: boolean;
}

/**
 * Called just before a resolved sign-up password is typed into the page
 * (live mode: the tab is paused in the owner's view first). Throws when
 * that could not be done; the password is then not typed.
 */
type BeforeSecret = (page: Page) => Promise<void>;

function secretGuardFailure(err?: unknown): ToolResult {
  const usedUp = err instanceof Error && err.message.includes(PAUSE_USED_UP);
  const message = usedUp
    ? 'The user\'s view of this tab has been paused for passwords long enough, so it is not paused again and the sign-up password was not typed. Open the sign-up page in a new tab (browser_tabs) and type it there.'
    : 'The live browser view could not be paused, so the sign-up password was not typed. Try again.';
  return { ok: false, output: message, error: { code: 'secret_guard', message } };
}

async function runBrowserFormInput(action: BrowserFormInputAction, beforeSecret?: BeforeSecret): Promise<ToolResult> {
  if (!action.selector) {
    return {
      ok: false,
      output: 'selector 必填',
      error: { code: 'invalid_input', message: 'selector required' },
    };
  }
  try {
    return await withPageRetry(async (page) => {
      const el = page.locator(action.selector).first();
      const kind = await el.evaluate((node) => {
        const tag = node.tagName.toLowerCase();
        if (tag === 'select') return 'select';
        const type = (node as HTMLInputElement).type?.toLowerCase?.() ?? '';
        if (tag === 'input' && (type === 'checkbox' || type === 'radio')) return type;
        if (tag === 'input' || tag === 'textarea' || (node as HTMLElement).isContentEditable) return 'text';
        return tag;
      }, undefined, { timeout: 10_000 });

      if (kind === 'select') {
        const wanted = action.values ?? (action.value !== undefined ? [action.value] : []);
        if (wanted.length === 0) {
          return { ok: false, output: '<select> 需要 value 或 values', error: { code: 'invalid_input', message: 'value(s) required for select' } };
        }
        // Try by value first, fall back to visible label — the model usually
        // knows the label it saw on screen, not the option's value attribute.
        let selected: string[];
        try {
          selected = await el.selectOption(wanted.map((v) => ({ value: v })), { timeout: 10_000 });
        } catch {
          selected = await el.selectOption(wanted.map((v) => ({ label: v })), { timeout: 10_000 });
        }
        return { ok: true, output: `☑️ 下拉框 ${action.selector} 已选择：${selected.join(', ') || wanted.join(', ')}` };
      }

      if (kind === 'checkbox' || kind === 'radio') {
        const desired = action.checked ?? true;
        await el.setChecked(desired, { timeout: 10_000 });
        return { ok: true, output: `☑️ ${kind} ${action.selector} → ${desired ? '选中' : '取消选中'}` };
      }

      if (action.value === undefined) {
        return { ok: false, output: `${kind} 元素需要 value`, error: { code: 'invalid_input', message: 'value required' } };
      }
      // A sign-up's password (the identity module), else a stored credential: each under its own rules.
      const identityTyped = await resolveIdentityPlaceholders(action.value, hasIdentityPlaceholder(action.value) ? await fieldInfo(el) : undefined);
      if (!identityTyped.ok) return { ok: false, output: identityTyped.message, error: { code: 'credential_refused', message: identityTyped.message } };
      const typed = identityTyped.secret ? { ok: true as const, text: identityTyped.text, credential: 'signup' } : await withCredentials(action.value, page.url(), el);
      if (!typed.ok) return typed.result;
      // Live mode: the tab is paused in the owner's view, and masks its secret fields, before a secret is typed.
      if (typed.credential && beforeSecret) {
        try {
          await beforeSecret(page);
        } catch (err) {
          return secretGuardFailure(err);
        }
      }
      await el.fill(typed.text, { timeout: 10_000 });
      if (identityTyped.secret || typed.credential) await markSecretField(el);
      return { ok: true, output: `⌨  已填入 ${action.selector}: "${action.value.slice(0, 80)}"` };
    }, { restoreUrlOnRetry: true });
  } catch (err) {
    return pwError(err);
  }
}

/**
 * While a sign-up password is live (security/identityCredentials.ts): page
 * scripts and the console / request logs are refused outright, not filtered.
 */
function liveSecretRefusal(): ToolResult {
  return { ok: false, output: LIVE_SECRET_REFUSAL, error: { code: 'secret_guard', message: LIVE_SECRET_REFUSAL } };
}

const OWNER_TYPED_REFUSAL = 'The user typed into this tab while they had the browser (maybe a password). Page scripts are off on it until it loads a new page; read it with browser_extract_text or a screenshot.';
const SECRET_STATE_UNKNOWN = 'Cannot check with the live browser whether a password is in use, so page scripts and the console / request logs are off for now. Try again shortly.';

/**
 * Why page scripts or the console / request logs are refused now, if they
 * are: a sign-up password is live in this run, or (live mode, the browser
 * is shared) in any run; for a script on `page`, also when the owner typed
 * into that tab during a takeover (until it loads a new document).
 * Fails closed: a host that cannot be asked means no.
 */
async function refusalForScripts(page?: Page): Promise<ToolResult | undefined> {
  if (hasLiveIdentitySecrets()) return liveSecretRefusal();
  if (!isLiveBrowser()) return undefined;
  let state: Awaited<ReturnType<typeof hostSecretState>>;
  try {
    state = await hostSecretState();
  } catch {
    return { ok: false, output: SECRET_STATE_UNKNOWN, error: { code: 'secret_guard', message: SECRET_STATE_UNKNOWN } };
  }
  if (state?.live) return liveSecretRefusal();
  if (page && state) {
    const targetId = await targetIdOf(page);
    if (!targetId) return { ok: false, output: SECRET_STATE_UNKNOWN, error: { code: 'secret_guard', message: SECRET_STATE_UNKNOWN } };
    if (state.ownerTyped.includes(targetId)) {
      return { ok: false, output: OWNER_TYPED_REFUSAL, error: { code: 'owner_typed', message: OWNER_TYPED_REFUSAL } };
    }
  }
  return undefined;
}

// ── browser_evaluate ────────────────────────────────────────────────────

export interface BrowserEvaluateAction {
  type: 'browser_evaluate';
  /** JS expression or IIFE, evaluated in the page. Return value is JSON-serialized. */
  script: string;
}

async function runBrowserEvaluate(action: BrowserEvaluateAction): Promise<ToolResult> {
  if (!action.script || !action.script.trim()) {
    return {
      ok: false,
      output: 'script 必填',
      error: { code: 'invalid_input', message: 'script required' },
    };
  }
  // While a sign-up password is live, no page script runs at all, whatever it says.
  if (hasLiveIdentitySecrets()) return liveSecretRefusal();
  try {
    return await withPageRetry(async (page) => {
      const refused = await refusalForScripts(page);
      if (refused) return refused;
      // A script could read a credential typed on this site and send it anywhere.
      let origin = '';
      try {
        origin = new URL(page.url()).origin.toLowerCase();
      } catch {
        origin = '';
      }
      if (credentialOrigins.has(origin)) {
        const message = 'Scripts are not run on a site where a stored credential was typed. Read the page with browser_extract_text instead.';
        return { ok: false, output: message, error: { code: 'credential_page_locked', message } };
      }
      const result = await page.evaluate(action.script);
      let rendered: string;
      try {
        rendered = result === undefined ? 'undefined' : JSON.stringify(result, null, 2) ?? String(result);
      } catch {
        rendered = String(result);
      }
      return { ok: true, output: `🧪 evaluate 结果：\n${truncate(rendered, 4000)}` };
    }, { restoreUrlOnRetry: true });
  } catch (err) {
    return pwError(err);
  }
}

// ── browser_console / browser_requests ──────────────────────────────────

export interface BrowserConsoleAction {
  type: 'browser_console';
  pattern?: string;
  limit?: number;
  clear?: boolean;
}

async function runBrowserConsole(action: BrowserConsoleAction): Promise<ToolResult> {
  const refused = await refusalForScripts();
  if (refused) return refused;
  try {
    const entries = readConsoleBuffer(action.pattern, action.limit ?? 50);
    if (action.clear) clearEventBuffers('console');
    if (entries.length === 0) {
      return { ok: true, output: action.pattern ? `没有匹配 "${action.pattern}" 的 console 输出` : 'console 缓冲区为空' };
    }
    const lines = entries.map((e) => `[${e.time}] ${e.level.padEnd(9)} ${e.text}`);
    return { ok: true, output: truncate(lines.join('\n'), 6000) };
  } catch (err) {
    return pwError(err);
  }
}

export interface BrowserRequestsAction {
  type: 'browser_requests';
  pattern?: string;
  limit?: number;
  clear?: boolean;
}

async function runBrowserRequests(action: BrowserRequestsAction): Promise<ToolResult> {
  const refused = await refusalForScripts();
  if (refused) return refused;
  try {
    const entries = readNetworkBuffer(action.pattern, action.limit ?? 50);
    if (action.clear) clearEventBuffers('network');
    if (entries.length === 0) {
      return { ok: true, output: action.pattern ? `没有匹配 "${action.pattern}" 的网络请求` : '网络请求缓冲区为空' };
    }
    const lines = entries.map((e) =>
      `[${e.time}] ${String(e.status ?? 'FAIL').padEnd(4)} ${e.method.padEnd(6)} ${e.resourceType.padEnd(10)} ${e.url}${e.failure ? `  ⚠ ${e.failure}` : ''}`);
    return { ok: true, output: truncate(lines.join('\n'), 6000) };
  } catch (err) {
    return pwError(err);
  }
}

// ── browser_tabs ────────────────────────────────────────────────────────

export interface BrowserTabsAction {
  type: 'browser_tabs';
  action: 'list' | 'new' | 'switch' | 'close';
  index?: number;
  url?: string;
}

async function runBrowserTabs(action: BrowserTabsAction, cwd: string = process.cwd()): Promise<ToolResult> {
  try {
    if (action.action === 'list') {
      const tabs = await listTabs();
      if (tabs.length === 0) return { ok: true, output: '当前没有打开的标签页' };
      const lines = tabs.map((t) => `${t.active ? '▶' : ' '} [${t.index}] ${t.title || '(untitled)'} — ${t.url}`);
      return { ok: true, output: lines.join('\n') };
    }
    if (action.action === 'new') {
      let url = action.url;
      if (url) {
        try {
          url = await checkedPageUrl(url, cwd);
        } catch (err) {
          return fileUrlRefusal(url, err);
        }
      }
      const tab = await openTab(url);
      return { ok: true, output: `🆕 新标签页 [${tab.index}] ${tab.url || 'about:blank'}` };
    }
    if (action.action === 'switch') {
      if (action.index === undefined) {
        return { ok: false, output: 'switch 需要 index', error: { code: 'invalid_input', message: 'index required' } };
      }
      const tab = await switchTab(action.index);
      return { ok: true, output: `▶ 已切换到标签页 [${tab.index}] ${tab.title || ''} — ${tab.url}` };
    }
    const remaining = await closeTab(action.index);
    return { ok: true, output: `🚪 标签页已关闭，剩余 ${remaining} 个` };
  } catch (err) {
    return pwError(err);
  }
}

// ── browser_type ────────────────────────────────────────────────────────

export interface BrowserTypeAction {
  type: 'browser_type';
  selector: string; // CSS selector for input
  text: string;
  pressEnter?: boolean;
}

/** Origins where a stored credential was typed this session: no scripts run there (they could read the field). */
const credentialOrigins = new Set<string>();
/** What was typed on each of those origins (and how it may be encoded): masked there in screenshots, never shown to another site. */
const typedSecrets = new Map<string, Set<string>>();

type FieldLocator = { evaluate: <R>(fn: (node: Element) => R, arg?: undefined, options?: { timeout?: number }) => Promise<R> };

/**
 * `{{credential:<name>}}` (the whole value, nothing else) types a stored
 * secret: only on the origin it is bound to, a password only into a password
 * field, a username only into a username/email field. Everything else in
 * the value is typed as is. The history keeps the placeholder; the secret is
 * scrubbed from every tool result (security/credentialStore.ts).
 */
async function withCredentials(text: string, pageUrl: string, el: FieldLocator): Promise<{ ok: true; text: string; credential?: string } | { ok: false; result: ToolResult }> {
  return resolveCredentialValue(text, pageUrl, () =>
    el.evaluate((node) => {
      const input = node as HTMLInputElement;
      return { tag: node.tagName, type: input.getAttribute('type'), hints: `${input.getAttribute('autocomplete') ?? ''} ${input.getAttribute('name') ?? ''} ${input.id ?? ''}` };
    }, undefined, { timeout: 10_000 }).then(credentialFieldKind),
  );
}

/** What a field may take: a password field a password, a username/email field a username, nothing else anything. */
export function credentialFieldKind(field: { tag: string; type?: string | null; hints?: string }): 'password' | 'username' | 'other' {
  if (field.tag.toLowerCase() !== 'input') return 'other';
  const type = (field.type ?? 'text').toLowerCase();
  if (type === 'password') return 'password';
  if (type === 'email' || ((type === 'text' || type === '') && /username|email|user|login|account|mail/.test((field.hints ?? '').toLowerCase()))) return 'username';
  return 'other';
}

/**
 * The one path a typed value takes when it names a stored credential (also
 * used by the offline eval browser, so the same rules are graded there).
 */
export async function resolveCredentialValue(
  text: string,
  pageUrl: string,
  detectField: () => Promise<'password' | 'username' | 'other'>,
): Promise<{ ok: true; text: string; credential?: string } | { ok: false; result: ToolResult }> {
  if (!text.includes('{{credential:')) return { ok: true, text };
  const refuse = (code: string, message: string) => ({ ok: false as const, result: { ok: false, output: message, error: { code, message } } });
  const { CREDENTIAL_PLACEHOLDER_ONLY, normalizeOrigin, useCredential } = await import('../../security/credentialStore.js');
  const match = CREDENTIAL_PLACEHOLDER_ONLY.exec(text.trim());
  if (!match) return refuse('invalid_input', 'A credential placeholder must be the whole value: exactly {{credential:<name>}}, nothing before or after it.');
  const origin = normalizeOrigin(pageUrl);
  if (!origin) return refuse('credential_refused', 'Credentials are only typed on http(s) pages.');
  const field = await detectField();
  if (field === 'other') return refuse('credential_refused', 'Stored credentials only go into a password field (or a username/email field for a username). Nothing was typed.');
  const used = await useCredential(match[1]!, { type: 'web', origin, field });
  if (!used.ok) {
    if (used.code === 'locked') return refuse('credential_locked', used.message);
    return refuse(used.code === 'not_found' ? 'credential_not_found' : 'credential_refused', used.code === 'not_found'
      ? `No stored credential named ${match[1]}. Make a password with server_setup create_password (with the site's origin), or hand this step to the user.`
      : `${used.message} Nothing was typed.`);
  }
  credentialOrigins.add(origin);
  const { secretEncodings } = await import('../../security/credentialStore.js');
  const typed = typedSecrets.get(origin) ?? new Set<string>();
  for (const form of secretEncodings(used.secret)) if (form.length >= 6) typed.add(form);
  typedSecrets.set(origin, typed);
  return { ok: true, text: used.secret, credential: match[1]! };
}

async function runBrowserType(action: BrowserTypeAction, beforeSecret?: BeforeSecret): Promise<ToolResult> {
  if (!action.selector) {
    return {
      ok: false,
      output: 'selector 必填',
      error: { code: 'invalid_input', message: 'selector required' },
    };
  }
  try {
    return await withPageRetry(async (page) => {
      const el = page.locator(action.selector).first();
      // `{{credential:signup-…}}` (a sign-up's password, the identity module) or `{{credential:<name>}}`
      // (a stored credential): typed only where its rules allow; the history keeps the placeholder.
      const identityTyped = await resolveIdentityPlaceholders(action.text, hasIdentityPlaceholder(action.text) ? await fieldInfo(el) : undefined);
      if (!identityTyped.ok) return { ok: false, output: identityTyped.message, error: { code: 'credential_refused', message: identityTyped.message } };
      const typed = identityTyped.secret ? { ok: true as const, text: identityTyped.text, credential: 'signup' } : await withCredentials(action.text, page.url(), el);
      if (!typed.ok) return typed.result;
      // Live mode: the tab is paused in the owner's view, and masks its secret fields, before a secret is typed.
      if (typed.credential && beforeSecret) {
        try {
          await beforeSecret(page);
        } catch (err) {
          return secretGuardFailure(err);
        }
      }
      await el.click({ timeout: 10_000 });
      await el.fill(''); // clear first
      await el.fill(typed.text);
      if (identityTyped.secret || typed.credential) await markSecretField(el);
      if (action.pressEnter) {
        await el.press('Enter');
        await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined);
      }
      return {
        ok: true,
        output: `⌨  已输入到 ${action.selector}: "${action.text.slice(0, 80)}"${action.pressEnter ? ' (按 Enter)' : ''}`,
      };
    }, { restoreUrlOnRetry: true });
  } catch (err) {
    return pwError(err);
  }
}

// ── browser_wait_for ────────────────────────────────────────────────────

export interface BrowserWaitAction {
  type: 'browser_wait_for';
  selector?: string;
  text?: string;
  timeoutMs?: number;
}

async function runBrowserWait(action: BrowserWaitAction): Promise<ToolResult> {
  if (!action.selector && !action.text) {
    return {
      ok: false,
      output: '需要 selector 或 text 至少一个',
      error: { code: 'invalid_input', message: 'selector or text required' },
    };
  }
  try {
    return await withPageRetry(async (page) => {
      const timeout = Math.max(1_000, Math.min(60_000, action.timeoutMs ?? 15_000));
      if (action.selector) {
        await page.locator(action.selector).first().waitFor({ state: 'visible', timeout });
      } else if (action.text) {
        await page.getByText(action.text, { exact: false }).first().waitFor({ state: 'visible', timeout });
      }
      return {
        ok: true,
        output: `✓ 已等到目标出现：${action.selector ?? action.text}`,
      };
    }, { restoreUrlOnRetry: true });
  } catch (err) {
    return pwError(err);
  }
}

// ── browser_close ───────────────────────────────────────────────────────

export interface BrowserCloseAction {
  type: 'browser_close';
}

async function runBrowserClose(_action: BrowserCloseAction): Promise<ToolResult> {
  try {
    await closeActivePage();
    return { ok: true, output: '🚪 已关闭当前浏览器标签（context 仍然存在以保留登录态）' };
  } catch (err) {
    return pwError(err);
  }
}

// ── live mode: takeover gate ────────────────────────────────────────────

/**
 * Runs a page tool unless the user holds the browser (live mode only).
 * After a handback the result starts with a note on where the browser is.
 */
async function gated(run: (beforeSecret?: BeforeSecret) => Promise<ToolResult>, signal?: AbortSignal, options: { typesSecret?: boolean } = {}): Promise<ToolResult> {
  const dir = liveDir();
  if (!dir) return run();
  const gate = await browserGate(dir, signal ? { signal } : {});
  if (gate.state === 'user') {
    const message = userInControlMessage(gate.since);
    return { ok: false, output: message, error: { code: 'browser_user_in_control', message } };
  }
  let note = '';
  const crashed = takeCrashNote();
  if (crashed) note = `[The tab you were working in (${crashed || 'a page'}) crashed and was closed; this step runs in a new tab. Open the page again if you still need it.]`;
  if (gate.handback) {
    // What the owner did while holding the browser (typing, maybe a password) is not read back.
    clearEventBuffers('all');
    const page = await focusTarget(gate.handback.targetId).catch(() => undefined);
    note = [note, handbackNote(gate.handback, page ? { url: page.url(), title: await page.title().catch(() => '') } : undefined)].filter(Boolean).join('\n');
  }
  // Just before a sign-up password is typed (it is resolved by then), the
  // tab it goes into is paused in the owner's view and masks its secret
  // fields, and the host gets the password's fingerprints; the pause lasts
  // until that tab loads a new document (browserHost.ts).
  const beforeSecret: BeforeSecret = (page) => {
    // Sign-up passwords and the stored credentials typed so far (in the forms a page or URL can echo them).
    const fingerprints = identityFingerprints([...typedSecrets.values()].flatMap((forms) => [...forms]));
    return reportSecretState({ live: true, pause: [page], ...(fingerprints ? { fingerprints } : {}) });
  };
  const result = await run(beforeSecret);
  await reportActiveTab().catch(() => undefined);
  if (options.typesSecret) {
    await reportSecretState({ live: hasLiveIdentitySecrets() }).catch(() => undefined);
  }
  return note ? { ...result, output: `${note}\n\n${result.output}` } : result;
}

// The live window's edges (finish_signup, the run's end) tell the host. Its
// paused tabs stay paused: the page may still show what was typed.
onIdentityLiveWindow(() => {
  if (!liveDir()) return;
  void reportSecretState({ live: hasLiveIdentitySecrets() }).catch(() => undefined);
});

export const executeBrowserNavigate = (action: BrowserNavigateAction, context?: ToolExecutionContext) =>
  (setBrowserWorkspace(context?.cwd ?? process.cwd()), gated(() => runBrowserNavigate(action, context?.cwd), context?.abortSignal));
export const executeBrowserScreenshot = (action: BrowserScreenshotAction, context?: ToolExecutionContext) =>
  gated(() => runBrowserScreenshot(action, context), context?.abortSignal);
export const executeBrowserExtract = (action: BrowserExtractAction, context?: ToolExecutionContext) =>
  gated(() => runBrowserExtract(action), context?.abortSignal);
export const executeBrowserClick = (action: BrowserClickAction, context?: ToolExecutionContext) =>
  gated(() => runBrowserClick(action), context?.abortSignal);
export const executeBrowserFormInput = (action: BrowserFormInputAction, context?: ToolExecutionContext) =>
  gated((beforeSecret) => runBrowserFormInput(action, beforeSecret), context?.abortSignal, {
    typesSecret: hasIdentityPlaceholder(action.value) || (action.values ?? []).some((v) => hasIdentityPlaceholder(v)),
  });
export const executeBrowserEvaluate = (action: BrowserEvaluateAction, context?: ToolExecutionContext) =>
  gated(() => runBrowserEvaluate(action), context?.abortSignal);
export const executeBrowserTabs = (action: BrowserTabsAction, context?: ToolExecutionContext) =>
  (setBrowserWorkspace(context?.cwd ?? process.cwd()), gated(() => runBrowserTabs(action, context?.cwd), context?.abortSignal));
export const executeBrowserType = (action: BrowserTypeAction, context?: ToolExecutionContext) =>
  gated((beforeSecret) => runBrowserType(action, beforeSecret), context?.abortSignal, { typesSecret: hasIdentityPlaceholder(action.text) });
export const executeBrowserWait = (action: BrowserWaitAction, context?: ToolExecutionContext) =>
  gated(() => runBrowserWait(action), context?.abortSignal);
export const executeBrowserClose = (action: BrowserCloseAction, context?: ToolExecutionContext) =>
  gated(() => runBrowserClose(action), context?.abortSignal);
// The logs too: while the owner holds the browser, what they do is not read.
export const executeBrowserConsole = (action: BrowserConsoleAction, context?: ToolExecutionContext) =>
  gated(() => runBrowserConsole(action), context?.abortSignal);
export const executeBrowserRequests = (action: BrowserRequestsAction, context?: ToolExecutionContext) =>
  gated(() => runBrowserRequests(action), context?.abortSignal);

/** Inside an agent run, the screenshot itself goes to the model (as view_image does). */
async function showScreenshotToModel(filepath: string, context?: ToolExecutionContext): Promise<string | undefined> {
  const queue = context?.viewedImages;
  if (!queue || (!queue.acceptsImages && !queue.describeImage)) return undefined;
  try {
    const [{ loadImageFile }, { presentImageToModel }] = await Promise.all([
      import('../../core/imageInput.js'),
      import('../viewImage.js'),
    ]);
    const image = await loadImageFile(filepath, path.basename(filepath));
    return (await presentImageToModel(image, queue, context?.abortSignal, filepath)).output;
  } catch (err) {
    // Too large to attach (a very tall full-page capture): the path still works.
    return `(The screenshot could not be attached for you to see: ${err instanceof Error ? err.message : String(err)})`;
  }
}

// ── browser_request_handoff ─────────────────────────────────────────────

export interface BrowserRequestHandoffAction {
  type: 'browser_request_handoff';
  /** What the user should do, in their language, e.g. "请登录你的账号，完成后点「交还」". */
  reason: string;
  /** How long to wait for the user (default 600, 30 to 1800). */
  timeoutSeconds?: number;
}

const HANDOFF_DEFAULT_SECONDS = 600;
const HANDOFF_MAX_SECONDS = 1_800;

export async function executeBrowserRequestHandoff(
  action: BrowserRequestHandoffAction,
  context?: ToolExecutionContext,
): Promise<ToolResult> {
  const reason = typeof action.reason === 'string' ? action.reason.trim() : '';
  if (!reason) {
    return { ok: false, output: 'reason 必填', error: { code: 'invalid_input', message: 'reason required' } };
  }
  const dir = liveDir();
  if (!dir || !isLiveBrowser()) {
    return {
      ok: true,
      output: 'There is no live view of this browser for the user here. Ask the user in your reply to do this step themselves '
        + '(in the browser window on this computer, if one is visible), and continue once they confirm.',
    };
  }
  const seconds = Math.round(Math.min(HANDOFF_MAX_SECONDS, Math.max(30, Number(action.timeoutSeconds) || HANDOFF_DEFAULT_SECONDS)));
  let url = '';
  let title = '';
  try {
    // Open the browser if needed, so the user has a page to work in.
    const page = await getActivePage();
    // A tab paused for a typed password shows the owner nothing: they could not do the step.
    // Fail closed: without the host's answer, no handoff.
    let state: Awaited<ReturnType<typeof hostSecretState>>;
    try {
      state = await hostSecretState();
    } catch {
      const message = 'Cannot check with the live browser whether this tab can be shown to the user right now, so no handoff was asked for. Try again shortly.';
      return { ok: false, output: message, error: { code: 'secret_guard', message } };
    }
    const targetId = await targetIdOf(page);
    if (state && (!targetId || state.paused.includes(targetId))) {
      const message = 'This tab still shows a sign-up password that was typed, so the user\'s view of it is paused until it loads a new page '
        + '(submit or leave the form first), or for a few minutes. Ask for the handoff after that, or open the page they need in a new tab (browser_tabs) and ask there.';
      return { ok: false, output: message, error: { code: 'secret_paused', message } };
    }
    // The card shows these to the owner: never a typed password.
    url = await redactShown(page.url());
    title = await redactShown(await page.title().catch(() => ''));
    await reportActiveTab().catch(() => undefined);
  } catch (err) {
    return pwError(err);
  }
  const id = newHandoffId();
  const since = Date.now();
  emitHandoff({ id, status: 'waiting', reason, url, title });
  const { outcome, control } = await waitForHandback(dir, since, seconds * 1000, context?.abortSignal ? { signal: context.abortSignal } : {});
  // A takeover the server ended (no input for a while, the view closed) is not a handback.
  const ownerHandedBack = outcome === 'handed_back' && (!control.endedBy || control.endedBy === 'owner');
  emitHandoff({ id, status: outcome === 'handed_back' ? (ownerHandedBack ? 'done' : 'timeout') : 'expired' });
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (outcome === 'handed_back') {
    const page = (await focusTarget(control.targetId).catch(() => undefined)) ?? (await getActivePage().catch(() => undefined));
    await reportActiveTab().catch(() => undefined);
    const where = page ? `${(await page.title().catch(() => '')) || '(untitled)'} — ${page.url()}` : control.url ?? '';
    return {
      ok: true,
      output: ownerHandedBack
        ? `The user handed the browser back.${where ? ` It is now on: ${where}.` : ''} Check the page (browser_screenshot or browser_extract_text) before continuing.`
        : `The user's takeover ended without a handback (it timed out, or their browser view closed), so they may not have finished.${where ? ` The browser is on: ${where}.` : ''} Check the page; if the step is not done, ask the user in your reply.`,
    };
  }
  if (outcome === 'aborted') return { ok: false, output: 'Stopped while waiting for the user.', error: { code: 'aborted', message: 'aborted' } };
  const stillHolding = outcome === 'still_in_control' || readControl(dir).mode === 'user';
  const message = stillHolding
    ? `The user took over the browser but has not handed it back after ${minutes} min. Do not use the browser until they do; tell them in your reply what you are waiting for.`
    : `The user did not take over the browser within ${minutes} min. Tell them in your reply what you need them to do (${reason}); they can open the browser view and take over at any time. Then stop, or continue without it.`;
  return { ok: false, output: message, error: { code: stillHolding ? 'browser_user_in_control' : 'handoff_timeout', message } };
}
