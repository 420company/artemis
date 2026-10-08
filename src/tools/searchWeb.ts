import { SearchToolManager } from '../core/searchToolManager.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';

// Shown when no backend could answer, so the model can tell the user what is
// missing instead of retrying: the keyless backends (DuckDuckGo, Wikipedia)
// can be blocked from datacenter IPs, and the keyed ones need credentials.
const SEARCH_SETUP_HINT =
  'Web search is not configured on this host: no keyed search backend is set up (GOOGLE_API_KEY with GOOGLE_CX, or BING_API_KEY), and the keyless backends returned nothing.';

// Shown when the hosted platform's search was tried and failed: the host is
// set up, the service is not answering. Nothing to configure; no made-up results.
const PLATFORM_SEARCH_HINT =
  'Web search through the platform did not work just now (see the reason above), and the keyless backends returned nothing. Tell the user web search is temporarily unavailable (or what the reason says, e.g. the balance needs a top-up); do not invent search results.';

const FRESHNESS = new Set(['day', 'week', 'month', 'year']);

export async function executeSearchWeb(action: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
  const { query, limit = 5, backend, freshness } = action;

  try {
    const result = await SearchToolManager.search(query, limit, backend, {
      ...(typeof freshness === 'string' && FRESHNESS.has(freshness) ? { freshness: freshness as 'day' | 'week' | 'month' | 'year' } : {}),
      ...(context?.abortSignal ? { signal: context.abortSignal } : {}),
    });

    if (!result.success) {
      const message = `search_web failed: ${result.error ?? 'unknown error'}`;
      const hint = result.backend === 'platform' ? PLATFORM_SEARCH_HINT : SEARCH_SETUP_HINT;
      return {
        action,
        ok: false,
        output: `${message}\n${hint}`,
        error: {
          code: 'search_backend_unavailable',
          message,
          retryable: false,
        },
      };
    }

    if (result.data.web.length === 0) {
      return {
        action,
        ok: true,
        output: 'No results found.',
      };
    }

    const formattedResults = result.data.web.map((item: any, index: number) => {
      const published = typeof item.publishedAt === 'string' && item.publishedAt ? `\n   Published: ${item.publishedAt.slice(0, 10)}` : '';
      return `${index + 1}. ${item.title}\n   URL: ${item.url}${published}${item.description ? `\n   ${item.description}` : ''}`;
    }).join('\n\n');

    return {
      action,
      ok: true,
      output: result.notice ? `Note: ${result.notice}\n\n${formattedResults}` : formattedResults,
    };
  } catch (error) {
    const message = `search_web failed: ${error instanceof Error ? error.message : String(error)}`;
    return {
      action,
      ok: false,
      output: `${message}\n${SEARCH_SETUP_HINT}`,
      error: {
        code: 'search_backend_unavailable',
        message,
        retryable: false,
      },
    };
  }
}
