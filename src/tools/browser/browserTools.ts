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

import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import {
  getActivePage,
  closeActivePage,
  describePlaywrightError,
  readConsoleBuffer,
  readNetworkBuffer,
  clearEventBuffers,
  listTabs,
  openTab,
  switchTab,
  closeTab,
  focusTarget,
  isLiveBrowser,
  reportActiveTab,
} from './browserSession.js';
import type { Page } from 'playwright';
import { resolveArtemisHomeDir } from '../../utils/fs.js';
import type { ToolExecutionContext } from '../types.js';
import {
  browserGate,
  emitHandoff,
  handbackNote,
  liveDir,
  newHandoffId,
  readControl,
  userInControlMessage,
  waitForHandback,
} from './liveBrowser.js';

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
  url: string;
  waitFor?: 'load' | 'domcontentloaded' | 'networkidle';
  extractText?: boolean;
}

async function runBrowserNavigate(action: BrowserNavigateAction): Promise<ToolResult> {
  if (!action.url || action.url.trim().length === 0) {
    return {
      ok: false,
      output: 'url 必填',
      error: { code: 'invalid_input', message: 'url required' },
    };
  }
  try {
    return await withPageRetry(async (page) => {
      const waitUntil = action.waitFor ?? 'domcontentloaded';
      await page.goto(action.url, { waitUntil, timeout: 30_000 });
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
      await page.screenshot({ path: filepath, fullPage: action.fullPage === true });
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

async function runBrowserFormInput(action: BrowserFormInputAction): Promise<ToolResult> {
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
      await el.fill(action.value, { timeout: 10_000 });
      return { ok: true, output: `⌨  已填入 ${action.selector}: "${action.value.slice(0, 80)}"` };
    }, { restoreUrlOnRetry: true });
  } catch (err) {
    return pwError(err);
  }
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
  try {
    return await withPageRetry(async (page) => {
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

export async function executeBrowserConsole(action: BrowserConsoleAction): Promise<ToolResult> {
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

export async function executeBrowserRequests(action: BrowserRequestsAction): Promise<ToolResult> {
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

async function runBrowserTabs(action: BrowserTabsAction): Promise<ToolResult> {
  try {
    if (action.action === 'list') {
      const tabs = await listTabs();
      if (tabs.length === 0) return { ok: true, output: '当前没有打开的标签页' };
      const lines = tabs.map((t) => `${t.active ? '▶' : ' '} [${t.index}] ${t.title || '(untitled)'} — ${t.url}`);
      return { ok: true, output: lines.join('\n') };
    }
    if (action.action === 'new') {
      const tab = await openTab(action.url);
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

async function runBrowserType(action: BrowserTypeAction): Promise<ToolResult> {
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
      await el.click({ timeout: 10_000 });
      await el.fill(''); // clear first
      await el.fill(action.text);
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
async function gated(run: () => Promise<ToolResult>, signal?: AbortSignal): Promise<ToolResult> {
  const dir = liveDir();
  if (!dir) return run();
  const gate = await browserGate(dir, signal ? { signal } : {});
  if (gate.state === 'user') {
    const message = userInControlMessage(gate.since);
    return { ok: false, output: message, error: { code: 'browser_user_in_control', message } };
  }
  let note = '';
  if (gate.handback) {
    const page = await focusTarget(gate.handback.targetId).catch(() => undefined);
    note = handbackNote(gate.handback, page ? { url: page.url(), title: await page.title().catch(() => '') } : undefined);
  }
  const result = await run();
  await reportActiveTab().catch(() => undefined);
  return note ? { ...result, output: `${note}\n\n${result.output}` } : result;
}

export const executeBrowserNavigate = (action: BrowserNavigateAction, context?: ToolExecutionContext) =>
  gated(() => runBrowserNavigate(action), context?.abortSignal);
export const executeBrowserScreenshot = (action: BrowserScreenshotAction, context?: ToolExecutionContext) =>
  gated(() => runBrowserScreenshot(action, context), context?.abortSignal);
export const executeBrowserExtract = (action: BrowserExtractAction, context?: ToolExecutionContext) =>
  gated(() => runBrowserExtract(action), context?.abortSignal);
export const executeBrowserClick = (action: BrowserClickAction, context?: ToolExecutionContext) =>
  gated(() => runBrowserClick(action), context?.abortSignal);
export const executeBrowserFormInput = (action: BrowserFormInputAction, context?: ToolExecutionContext) =>
  gated(() => runBrowserFormInput(action), context?.abortSignal);
export const executeBrowserEvaluate = (action: BrowserEvaluateAction, context?: ToolExecutionContext) =>
  gated(() => runBrowserEvaluate(action), context?.abortSignal);
export const executeBrowserTabs = (action: BrowserTabsAction, context?: ToolExecutionContext) =>
  gated(() => runBrowserTabs(action), context?.abortSignal);
export const executeBrowserType = (action: BrowserTypeAction, context?: ToolExecutionContext) =>
  gated(() => runBrowserType(action), context?.abortSignal);
export const executeBrowserWait = (action: BrowserWaitAction, context?: ToolExecutionContext) =>
  gated(() => runBrowserWait(action), context?.abortSignal);
export const executeBrowserClose = (action: BrowserCloseAction, context?: ToolExecutionContext) =>
  gated(() => runBrowserClose(action), context?.abortSignal);

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
    url = page.url();
    title = await page.title().catch(() => '');
    await reportActiveTab().catch(() => undefined);
  } catch (err) {
    return pwError(err);
  }
  const id = newHandoffId();
  const since = Date.now();
  emitHandoff({ id, status: 'waiting', reason, url, title });
  const { outcome, control } = await waitForHandback(dir, since, seconds * 1000, context?.abortSignal ? { signal: context.abortSignal } : {});
  emitHandoff({ id, status: outcome === 'handed_back' ? 'done' : 'expired' });
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (outcome === 'handed_back') {
    const page = (await focusTarget(control.targetId).catch(() => undefined)) ?? (await getActivePage().catch(() => undefined));
    await reportActiveTab().catch(() => undefined);
    const where = page ? `${(await page.title().catch(() => '')) || '(untitled)'} — ${page.url()}` : control.url ?? '';
    return {
      ok: true,
      output: `The user handed the browser back.${where ? ` It is now on: ${where}.` : ''} Check the page (browser_screenshot or browser_extract_text) before continuing.`,
    };
  }
  if (outcome === 'aborted') return { ok: false, output: 'Stopped while waiting for the user.', error: { code: 'aborted', message: 'aborted' } };
  const stillHolding = outcome === 'still_in_control' || readControl(dir).mode === 'user';
  const message = stillHolding
    ? `The user took over the browser but has not handed it back after ${minutes} min. Do not use the browser until they do; tell them in your reply what you are waiting for.`
    : `The user did not take over the browser within ${minutes} min. Tell them in your reply what you need them to do (${reason}); they can open the browser view and take over at any time. Then stop, or continue without it.`;
  return { ok: false, output: message, error: { code: stillHolding ? 'browser_user_in_control' : 'handoff_timeout', message } };
}
