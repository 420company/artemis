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
 * is a path to the saved PNG — brain can describe but not see it (image
 * input not piped through tool results yet).
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
} from './browserSession.js';
import type { Page } from 'playwright';
import { resolveArtemisHomeDir } from '../../utils/fs.js';

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

export async function executeBrowserNavigate(action: BrowserNavigateAction): Promise<ToolResult> {
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

export async function executeBrowserScreenshot(action: BrowserScreenshotAction): Promise<ToolResult> {
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
      return {
        ok: true,
        output: `📸 已截图：${filepath}\n   URL: ${page.url()}\n   ${audit}`,
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

export async function executeBrowserExtract(action: BrowserExtractAction): Promise<ToolResult> {
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

export async function executeBrowserClick(action: BrowserClickAction): Promise<ToolResult> {
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

export async function executeBrowserFormInput(action: BrowserFormInputAction): Promise<ToolResult> {
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

export async function executeBrowserEvaluate(action: BrowserEvaluateAction): Promise<ToolResult> {
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

export async function executeBrowserTabs(action: BrowserTabsAction): Promise<ToolResult> {
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

export async function executeBrowserType(action: BrowserTypeAction): Promise<ToolResult> {
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

export async function executeBrowserWait(action: BrowserWaitAction): Promise<ToolResult> {
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

export async function executeBrowserClose(_action: BrowserCloseAction): Promise<ToolResult> {
  try {
    await closeActivePage();
    return { ok: true, output: '🚪 已关闭当前浏览器标签（context 仍然存在以保留登录态）' };
  } catch (err) {
    return pwError(err);
  }
}
