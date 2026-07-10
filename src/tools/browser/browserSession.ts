/**
 * Singleton Playwright browser session for the Artemis process lifetime.
 *
 * Why singleton: launching Chromium takes 1-2s. Long-running ambient agent
 * conversations from Telegram bridges issue many sequential browser tool
 * calls — paying that cost per call would make the experience sluggish.
 *
 * Persistent context: stored at ~/.artemis/browser-data/. Cookies + login
 * state survive Artemis restarts, so once user logs into Booking.com etc.
 * once via the visible browser, brain can return without re-auth.
 *
 * Visibility: by default we run *headed* (visible window) so the user can
 * see what brain is doing on their home Mac. This matches the ambient agent
 * mental model: "I'm in Bangkok, I can see my home Mac mirror in my mind."
 * Set ARTEMIS_BROWSER_HEADLESS=1 to override.
 */

import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import type { Browser, BrowserContext, Page } from 'playwright';
import { resolveArtemisHomeDir } from '../../utils/fs.js';

const PROFILE_DIR = path.join(resolveArtemisHomeDir(), 'browser-data');
const TEMP_PROFILE_PREFIX = path.join(os.tmpdir(), 'artemis-browser-');
const DEFAULT_TIMEOUT_MS = 20_000;

let _context: BrowserContext | null = null;
let _activePage: Page | null = null;
let _initPromise: Promise<BrowserContext> | null = null;
let _ephemeralBrowser: Browser | null = null;

// ── console / network event buffers ────────────────────────────────────────
// Ring buffers so the brain can debug pages ("what did the console say?",
// "which request 404'd?") without us re-running anything.

export interface ConsoleEntry {
  time: string;
  level: string;
  text: string;
  pageUrl: string;
}

export interface NetworkEntry {
  time: string;
  method: string;
  url: string;
  status: number | null;
  resourceType: string;
  failure?: string;
}

const EVENT_BUFFER_MAX = 300;
const _consoleBuffer: ConsoleEntry[] = [];
const _networkBuffer: NetworkEntry[] = [];

function pushRing<T>(buffer: T[], entry: T): void {
  buffer.push(entry);
  if (buffer.length > EVENT_BUFFER_MAX) buffer.splice(0, buffer.length - EVENT_BUFFER_MAX);
}

function attachPageListeners(page: Page): void {
  page.on('console', (msg) => {
    pushRing(_consoleBuffer, {
      time: new Date().toISOString().slice(11, 19),
      level: msg.type(),
      text: msg.text().slice(0, 500),
      pageUrl: page.url(),
    });
  });
  page.on('pageerror', (err) => {
    pushRing(_consoleBuffer, {
      time: new Date().toISOString().slice(11, 19),
      level: 'pageerror',
      text: String(err?.message ?? err).slice(0, 500),
      pageUrl: page.url(),
    });
  });
}

function attachContextListeners(ctx: BrowserContext): void {
  for (const page of ctx.pages()) attachPageListeners(page);
  ctx.on('page', (page) => attachPageListeners(page));
  ctx.on('response', (response) => {
    const req = response.request();
    pushRing(_networkBuffer, {
      time: new Date().toISOString().slice(11, 19),
      method: req.method(),
      url: response.url().slice(0, 300),
      status: response.status(),
      resourceType: req.resourceType(),
    });
  });
  ctx.on('requestfailed', (req) => {
    pushRing(_networkBuffer, {
      time: new Date().toISOString().slice(11, 19),
      method: req.method(),
      url: req.url().slice(0, 300),
      status: null,
      resourceType: req.resourceType(),
      failure: req.failure()?.errorText ?? 'failed',
    });
  });
}

export function readConsoleBuffer(pattern?: string, limit = 50): ConsoleEntry[] {
  let entries = _consoleBuffer;
  if (pattern) {
    try {
      const re = new RegExp(pattern, 'i');
      entries = entries.filter((e) => re.test(e.text) || re.test(e.level));
    } catch {
      const needle = pattern.toLowerCase();
      entries = entries.filter((e) => e.text.toLowerCase().includes(needle));
    }
  }
  return entries.slice(-Math.max(1, Math.min(200, limit)));
}

export function readNetworkBuffer(pattern?: string, limit = 50): NetworkEntry[] {
  let entries = _networkBuffer;
  if (pattern) {
    try {
      const re = new RegExp(pattern, 'i');
      entries = entries.filter((e) => re.test(e.url) || re.test(String(e.status ?? '')));
    } catch {
      const needle = pattern.toLowerCase();
      entries = entries.filter((e) => e.url.toLowerCase().includes(needle));
    }
  }
  return entries.slice(-Math.max(1, Math.min(200, limit)));
}

export function clearEventBuffers(kind: 'console' | 'network' | 'all' = 'all'): void {
  if (kind !== 'network') _consoleBuffer.length = 0;
  if (kind !== 'console') _networkBuffer.length = 0;
}

function isPersistentProfileLockError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ProcessSingleton|profile directory|SingletonLock|already in use|user data directory is already in use/i.test(msg);
}

function isContextAlive(ctx: BrowserContext | null): ctx is BrowserContext {
  if (!ctx) return false;
  // Playwright doesn't expose isClosed() on BrowserContext in all versions,
  // so use cheap operations that throw once the context/browser is gone.
  try {
    const browser = ctx.browser();
    if (browser && !browser.isConnected()) return false;
    ctx.pages();
    return true;
  } catch {
    return false;
  }
}

async function initContext(): Promise<BrowserContext> {
  if (isContextAlive(_context)) return _context;
  // Stale context — clear so we relaunch
  if (_context) {
    _context = null;
    _activePage = null;
    _initPromise = null;
  }
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const { chromium } = await import('playwright');
    const headless = process.env.ARTEMIS_BROWSER_HEADLESS === '1';
    const contextOptions = {
      viewport: { width: 1280, height: 800 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Bangkok',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    } as const;
    const launchArgs = ['--disable-blink-features=AutomationControlled'];

    const launch = (profileDir: string): Promise<BrowserContext> => chromium.launchPersistentContext(profileDir, {
      headless,
      ...contextOptions,
      // Realistic UA — avoids some bot fingerprinting
      args: launchArgs,
    });

    const launchEphemeral = async (): Promise<BrowserContext> => {
      const browser = await chromium.launch({
        headless,
        args: launchArgs,
      });
      _ephemeralBrowser = browser;
      return browser.newContext(contextOptions);
    };

    let ctx: BrowserContext;
    try {
      // launchPersistentContext gives us cookies + localStorage + login state
      // surviving across Artemis restarts. Persistent profile = single browser
      // connection, no separate Browser instance.
      ctx = await launch(PROFILE_DIR);
    } catch (err) {
      if (!isPersistentProfileLockError(err)) {
        try {
          ctx = await launchEphemeral();
        } catch {
          throw err;
        }
      } else {
        // A stale or concurrently open Chromium profile should not make visual QA
        // fall back to "HTTP 200 only". Use an isolated temporary profile for this
        // Artemis process; it won't preserve logins, but screenshots still work.
        const tempProfileDir = await fsp.mkdtemp(TEMP_PROFILE_PREFIX);
        try {
          ctx = await launch(tempProfileDir);
        } catch {
          ctx = await launchEphemeral();
        }
      }
    }
    ctx.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
    attachContextListeners(ctx);
    _context = ctx;
    return ctx;
  })().catch((err) => {
    _initPromise = null;
    throw err;
  });

  return _initPromise;
}

export async function getBrowserContext(): Promise<BrowserContext> {
  return initContext();
}

/**
 * Get or create the active page. Reuses the most recent page when the user's
 * brain runs multi-step browser actions like navigate → click → extract.
 */
export async function getActivePage(): Promise<Page> {
  let ctx = await initContext();

  if (_activePage && !_activePage.isClosed() && isContextAlive(ctx)) {
    return _activePage;
  }
  _activePage = null;

  // If context died between calls, relaunch and try again once.
  if (!isContextAlive(ctx)) {
    _context = null;
    _initPromise = null;
    ctx = await initContext();
  }

  const pages = ctx.pages().filter(p => !p.isClosed());
  if (pages.length > 0) {
    _activePage = pages[pages.length - 1]!;
    return _activePage;
  }
  _activePage = await ctx.newPage();
  return _activePage;
}

/** Replace the active page reference (e.g. after explicit new tab open). */
export function setActivePage(page: Page): void {
  _activePage = page;
}

// ── tab management ──────────────────────────────────────────────────────────

export interface TabInfo {
  index: number;
  url: string;
  title: string;
  active: boolean;
}

export async function listTabs(): Promise<TabInfo[]> {
  const ctx = await initContext();
  const pages = ctx.pages().filter((p) => !p.isClosed());
  const out: TabInfo[] = [];
  for (let i = 0; i < pages.length; i++) {
    let title = '';
    try {
      title = await pages[i].title();
    } catch { /* page navigating */ }
    out.push({ index: i, url: pages[i].url(), title, active: pages[i] === _activePage });
  }
  return out;
}

export async function openTab(url?: string): Promise<TabInfo> {
  const ctx = await initContext();
  const page = await ctx.newPage();
  _activePage = page;
  if (url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }
  const pages = ctx.pages().filter((p) => !p.isClosed());
  return { index: pages.indexOf(page), url: page.url(), title: await page.title().catch(() => ''), active: true };
}

export async function switchTab(index: number): Promise<TabInfo> {
  const ctx = await initContext();
  const pages = ctx.pages().filter((p) => !p.isClosed());
  if (index < 0 || index >= pages.length) {
    throw new Error(`tab index ${index} out of range (0-${pages.length - 1})`);
  }
  const page = pages[index];
  _activePage = page;
  await page.bringToFront().catch(() => undefined);
  return { index, url: page.url(), title: await page.title().catch(() => ''), active: true };
}

export async function closeTab(index?: number): Promise<number> {
  const ctx = await initContext();
  const pages = ctx.pages().filter((p) => !p.isClosed());
  const target = index === undefined
    ? (_activePage && !_activePage.isClosed() ? _activePage : pages[pages.length - 1])
    : pages[index];
  if (!target) throw new Error(`tab index ${index ?? '(active)'} not found`);
  const wasActive = target === _activePage;
  await target.close().catch(() => undefined);
  if (wasActive) _activePage = null;
  return ctx.pages().filter((p) => !p.isClosed()).length;
}

/**
 * Close the active page. Browser context stays alive for next call.
 * Use closeBrowser() to fully shut down.
 */
export async function closeActivePage(): Promise<void> {
  if (_activePage && !_activePage.isClosed()) {
    await _activePage.close().catch(() => undefined);
  }
  _activePage = null;
}

/** Hard shutdown — only call on Artemis exit. */
export async function closeBrowser(): Promise<void> {
  if (_context) {
    await _context.close().catch(() => undefined);
    _context = null;
    _activePage = null;
    _initPromise = null;
  }
  if (_ephemeralBrowser) {
    await _ephemeralBrowser.close().catch(() => undefined);
    _ephemeralBrowser = null;
  }
}

/**
 * Friendly error wrapper so callers can return tool errors instead of
 * crashing. Detects the common "browser binary missing" case.
 */
export function describePlaywrightError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/Executable doesn't exist|browser was not found|Please install/i.test(msg)) {
    return [
      'Playwright Chromium 浏览器二进制未安装。',
      '在 Artemis 项目目录跑一次：',
      '  npx playwright install chromium',
      '装完（~300MB）就能用了。',
    ].join('\n');
  }
  if (isPersistentProfileLockError(err)) {
    return [
      'Playwright Chromium profile 被其他进程占用。',
      'Artemis 已尝试自动切换临时 profile；如果仍看到这条错误，请关闭旧 Chromium/Artemis 浏览器进程后重试。',
      msg,
    ].join('\n');
  }
  return msg;
}
