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

const PROFILE_DIR = path.join(os.homedir(), '.artemis', 'browser-data');
const TEMP_PROFILE_PREFIX = path.join(os.tmpdir(), 'artemis-browser-');
const DEFAULT_TIMEOUT_MS = 20_000;

let _context: BrowserContext | null = null;
let _activePage: Page | null = null;
let _initPromise: Promise<BrowserContext> | null = null;
let _ephemeralBrowser: Browser | null = null;

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
