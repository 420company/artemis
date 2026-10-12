import type { AgentAction } from '../core/types.js';
import {
  formatDocsLookupReport,
  lookupDocs,
} from '../docs/lookup.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';

// The library's own index first (llms.txt, sitemap, crawl), then web search
// through search_web's backends (auto: the platform search on hosted agents).
export async function executeLookupDocs(
  action: Extract<AgentAction, { type: 'lookup_docs' }>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  try {
    const result = await lookupDocs({
      query: action.query,
      library: action.library,
      version: action.version,
      maxResults: action.maxResults,
      ...(context?.abortSignal ? { signal: context.abortSignal } : {}),
    });
    return {
      action,
      ok: true,
      output: formatDocsLookupReport(result),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      action,
      ok: false,
      output: `Docs lookup failed: ${message}`,
    };
  }
}
