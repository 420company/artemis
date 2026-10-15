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
 * browser tools work in (set by browser_navigate and browser_tabs from the
 * tool's own cwd, once the call has passed the live browser's gate), and
 * nothing once the run's turn ends (runAgent, endBrowserTurn) or the run lets
 * the browser go (releaseBrowser, closeBrowser). It is replaced, never added
 * to, so a page left from another run never reaches that run's workspace
 * through this guard; the local pages a turn leaves open are taken back to
 * about:blank as it ends. There is one per engine process: browser tools of
 * one process that run at the same time share it (the last call's wins). No
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

/** Whether a workspace is set (a browser tool ran in this turn). */
export function browserWorkspaceSet(): boolean {
  return current !== undefined;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  // `..` as a whole first segment (a name such as `..x` is inside).
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Whether a `file:` request may be answered, and the real path that was
 * checked (the file is then served from it, not from the path asked for).
 * Refused for anything it cannot decide, and with no workspace set.
 */
export async function checkLocalFile(url: string, request: { navigation: boolean; frameUrl?: string | undefined }, root: string | undefined = current): Promise<{ ok: boolean; real?: string; file?: boolean }> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return { ok: true };
    if (!root) return { ok: false };
    // A local file for a page that is not itself local (an http(s) page, a blank frame, a worker): never.
    if (!request.navigation && !/^file:/i.test(request.frameUrl ?? '')) return { ok: false };
    const real = await fsp.realpath(fileURLToPath(parsed));
    if (isAlwaysPrivatePath(real)) return { ok: false };
    if (!isWithin(await fsp.realpath(root), real)) return { ok: false };
    return { ok: true, real, file: (await fsp.stat(real)).isFile() };
  } catch {
    return { ok: false };
  }
}

export async function localFileAllowed(url: string, request: { navigation: boolean; frameUrl?: string | undefined }, root: string | undefined = current): Promise<boolean> {
  return (await checkLocalFile(url, request, root)).ok;
}

const guarded = new WeakSet<BrowserContext>();

async function decide(route: Route, root: string | undefined): Promise<void> {
  let verdict: { ok: boolean; real?: string; file?: boolean } = { ok: false };
  try {
    const request = route.request();
    let frameUrl: string | undefined;
    try {
      frameUrl = request.frame().url();
    } catch {
      // A service worker's request: no frame, so no local page asked for it.
    }
    verdict = await checkLocalFile(request.url(), { navigation: request.isNavigationRequest(), frameUrl }, root);
  } catch {
    verdict = { ok: false };
  }
  if (!verdict.ok) {
    await route.abort('accessdenied').catch(() => undefined);
    return;
  }
  // A file is served from the real path that was checked, so a link swapped in after the check is
  // not followed; a folder (its listing) goes on as asked.
  await (verdict.real && verdict.file ? route.fulfill({ path: verdict.real }) : route.continue()).catch(() => route.abort('accessdenied').catch(() => undefined));
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
  const state = { root: current };
  // Marked only once the route is in place (a failure leaves the context to be guarded on the next try).
  await ctx.route((url) => url.protocol === 'file:', (route) => decide(route, state.root));
  guarded.add(ctx);
  states.add(state);
  ctx.on('close', () => states.delete(state));
}
