/**
 * Local files in the agent's browser: only the workspace's.
 *
 * browser_navigate checks the page it is asked to open (`path`, a `file:`
 * URL), but a page can load other local files itself: an iframe, a meta
 * refresh, a script setting `location` (also run through browser_evaluate
 * or a click). So every `file:` request of every frame of a context the
 * engine drives goes through this guard (Playwright routes it through CDP
 * Fetch, navigations and subresources alike): it opens only when the file,
 * resolved through every link, is inside the workspace this run works in and
 * outside the protected directories, and a subresource only for a page that
 * is itself a local file (an http(s) page never loads local files). Anything
 * that cannot be decided is refused.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Route } from 'playwright';
import { isAlwaysPrivatePath } from '../../utils/fs.js';

/**
 * The workspace whose files the browser may open: the one the current run's
 * browser tools work in (set by browser_navigate and browser_tabs, from the
 * tool's own cwd), and nothing once the run lets the browser go
 * (releaseBrowser, closeBrowser). It is replaced, never added to, so a page
 * left from another run (one engine process serving several runs, the shared
 * live browser) never reaches that run's workspace through this guard. No
 * workspace set: no local file opens.
 */
let current: string | undefined;
/** The guard of each context this process drives, kept in step with `current`. */
const states = new Set<{ root: string | undefined }>();

export function setBrowserWorkspace(cwd: string): void {
  current = path.resolve(cwd);
  for (const state of states) state.root = current;
}

/** The run is over (or the browser closes): no local file opens until a browser tool names a workspace again. */
export function releaseBrowserWorkspace(): void {
  current = undefined;
  for (const state of states) state.root = undefined;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Whether a `file:` request may be answered (false for anything it cannot decide, and with no workspace set). */
export async function localFileAllowed(url: string, request: { navigation: boolean; frameUrl?: string | undefined }, root: string | undefined = current): Promise<boolean> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return true;
    if (!root) return false;
    // A local file for a page that is not itself local (an http(s) page, a blank frame): never.
    if (!request.navigation && !/^file:/i.test(request.frameUrl ?? '')) return false;
    const real = await fsp.realpath(fileURLToPath(parsed));
    if (isAlwaysPrivatePath(real)) return false;
    return isWithin(await fsp.realpath(root), real);
  } catch {
    return false;
  }
}

const guarded = new WeakSet<BrowserContext>();

async function decide(route: Route, root: string | undefined): Promise<void> {
  let allowed = false;
  try {
    const request = route.request();
    let frameUrl: string | undefined;
    try {
      frameUrl = request.frame().url();
    } catch {
      // A service worker's request: no frame, so no local page asked for it.
    }
    allowed = await localFileAllowed(request.url(), { navigation: request.isNavigationRequest(), frameUrl }, root);
  } catch {
    allowed = false;
  }
  await (allowed ? route.continue() : route.abort('accessdenied')).catch(() => undefined);
}

/**
 * Routes every `file:` request of the context through the guard (once per
 * context), before any page of it is used. The route is the context's, so
 * it covers pages the context opens later too: popups (`window.open`,
 * `target=_blank`) and every frame. A download of a local file is a request
 * like any other and is refused the same way outside the workspace.
 */
export async function guardLocalFiles(ctx: BrowserContext): Promise<void> {
  if (guarded.has(ctx)) return;
  guarded.add(ctx);
  const state = { root: current };
  states.add(state);
  ctx.on('close', () => states.delete(state));
  await ctx.route((url) => url.protocol === 'file:', (route) => decide(route, state.root));
}
