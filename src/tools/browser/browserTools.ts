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
import { getActivePage, closeActivePage, describePlaywrightError } from './browserSession.js';

export interface ToolResult {
  ok: boolean;
  output: string;
  error?: { code: string; message: string };
}

const SCREENSHOT_DIR = path.join(os.homedir(), '.artemis', 'browser-screenshots');
const MAX_TEXT_OUTPUT = 8000;

function pwError(err: unknown): ToolResult {
  const message = describePlaywrightError(err);
  return {
    ok: false,
    output: `浏览器操作失败：${message}`,
    error: { code: 'browser_error', message },
  };
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
    const page = await getActivePage();
    const waitUntil = action.waitFor ?? 'domcontentloaded';
    await page.goto(action.url, { waitUntil, timeout: 30_000 });
    const title = await page.title();
    const finalUrl = page.url();

    let extracted = '';
    if (action.extractText !== false) {
      // Use innerText to get only visible text (skip script/style)
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
  } catch (err) {
    return pwError(err);
  }
}

// ── browser_screenshot ──────────────────────────────────────────────────

export interface BrowserScreenshotAction {
  type: 'browser_screenshot';
  fullPage?: boolean;
}

export async function executeBrowserScreenshot(action: BrowserScreenshotAction): Promise<ToolResult> {
  try {
    const page = await getActivePage();
    await fsp.mkdir(SCREENSHOT_DIR, { recursive: true });
    const filename = `screenshot-${Date.now()}.png`;
    const filepath = path.join(SCREENSHOT_DIR, filename);
    await page.screenshot({ path: filepath, fullPage: action.fullPage === true });
    return {
      ok: true,
      output: `📸 已截图：${filepath}\n   URL: ${page.url()}`,
    };
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
    const page = await getActivePage();
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
  } catch (err) {
    return pwError(err);
  }
}

// ── browser_click ───────────────────────────────────────────────────────

export interface BrowserClickAction {
  type: 'browser_click';
  selector?: string; // CSS selector
  text?: string; // alternatively, clickable text content
}

export async function executeBrowserClick(action: BrowserClickAction): Promise<ToolResult> {
  if (!action.selector && !action.text) {
    return {
      ok: false,
      output: '需要 selector 或 text 至少一个',
      error: { code: 'invalid_input', message: 'selector or text required' },
    };
  }
  try {
    const page = await getActivePage();
    if (action.selector) {
      await page.locator(action.selector).first().click({ timeout: 10_000 });
    } else if (action.text) {
      // Match by visible text (Playwright's getByText)
      await page.getByText(action.text, { exact: false }).first().click({ timeout: 10_000 });
    }
    // Wait briefly for any navigation/reaction
    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined);
    return {
      ok: true,
      output: `🖱  已点击：${action.selector ?? action.text}\n   当前 URL: ${page.url()}`,
    };
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
    const page = await getActivePage();
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
    const page = await getActivePage();
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
