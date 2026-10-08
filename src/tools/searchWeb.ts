import { SearchToolManager } from '../core/searchToolManager.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';

// Shown when no backend could answer, so the model can tell the user what is
// missing instead of retrying: the keyless backends (DuckDuckGo, Wikipedia)
// can be blocked from datacenter IPs, and the keyed ones need credentials.
const SEARCH_SETUP_HINT =
  'Web search is not configured on this host: no keyed search backend is set up (GOOGLE_API_KEY with GOOGLE_CX, or BING_API_KEY), and the keyless backends returned nothing.';

export async function executeSearchWeb(action: any, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
  const { query, limit = 5, backend } = action;

  try {
    const result = await SearchToolManager.search(query, limit, backend);

    if (!result.success) {
      const message = `search_web failed: ${result.error ?? 'unknown error'}`;
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

    if (result.data.web.length === 0) {
      return {
        action,
        ok: true,
        output: 'No results found.',
      };
    }

    const formattedResults = result.data.web.map((item: any, index: number) => {
      return `${index + 1}. ${item.title}\n   URL: ${item.url}${item.description ? `\n   ${item.description}` : ''}`;
    }).join('\n\n');

    return {
      action,
      ok: true,
      output: formattedResults,
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
