/**
 * Local files in the agent's browser: only the workspace's.
 *
 * browser_navigate checks the page it is asked to open (`path`, a `file:`
 * URL), but a page can load other local files itself: an iframe, a meta
 * refresh, a script setting `location` (also run through browser_evaluate
 * or a click). So every `file:` request of every frame of a context the
 * engine drives goes through this guard (Playwright routes it through CDP
 * Fetch, navigations and subresources alike): it opens only when the file,
 * resolved through every link, is inside a workspace this run works in and
 * outside the protected directories, and a subresource only for a page that
 * is itself a local file (an http(s) page never loads local files). Anything
 * that cannot be decided is refused.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Route } from 'playwright';
import { isAlwaysPrivatePath } from '../../utils/fs.js';

/** The workspaces whose files the browser may open: the engine's own directory, and each one a browser tool ran in. */
const roots = new Set<string>([process.cwd()]);

export function allowBrowserWorkspace(cwd: string | undefined): void {
  if (cwd) roots.add(path.resolve(cwd));
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Whether a `file:` request may be answered (false for anything it cannot decide). */
export async function localFileAllowed(url: string, request: { navigation: boolean; frameUrl?: string | undefined }): Promise<boolean> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return true;
    // A local file for a page that is not itself local (an http(s) page, a blank frame): never.
    if (!request.navigation && !/^file:/i.test(request.frameUrl ?? '')) return false;
    const real = await fsp.realpath(fileURLToPath(parsed));
    if (isAlwaysPrivatePath(real)) return false;
    for (const root of roots) {
      const realRoot = await fsp.realpath(root).catch(() => undefined);
      if (realRoot && isWithin(realRoot, real)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

const guarded = new WeakSet<BrowserContext>();

async function decide(route: Route): Promise<void> {
  let allowed = false;
  try {
    const request = route.request();
    let frameUrl: string | undefined;
    try {
      frameUrl = request.frame().url();
    } catch {
      // A service worker's request: no frame, so no local page asked for it.
    }
    allowed = await localFileAllowed(request.url(), { navigation: request.isNavigationRequest(), frameUrl });
  } catch {
    allowed = false;
  }
  await (allowed ? route.continue() : route.abort('accessdenied')).catch(() => undefined);
}

/** Routes every `file:` request of the context through the guard (once per context), before any page of it is used. */
export async function guardLocalFiles(ctx: BrowserContext): Promise<void> {
  if (guarded.has(ctx)) return;
  guarded.add(ctx);
  await ctx.route((url) => url.protocol === 'file:', decide);
}
