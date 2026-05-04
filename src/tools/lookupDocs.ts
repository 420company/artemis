import type { AgentAction } from '../core/types.js';
import {
  formatDocsLookupReport,
  lookupDocs,
} from '../docs/lookup.js';
import { CliSettingsStore } from '../cli/settings.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';

export async function executeLookupDocs(
  action: Extract<AgentAction, { type: 'lookup_docs' }>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  try {
    const settingsStore = new CliSettingsStore(context.cwd);
    const settings = await settingsStore.load();
    const searchEngine = settings.docsSearchEngine === 'google' &&
      (!process.env.GOOGLE_CSE_ID || !process.env.GOOGLE_API_KEY)
      ? 'bing'
      : settings.docsSearchEngine;
    const result = await lookupDocs({
      query: action.query,
      library: action.library,
      version: action.version,
      maxResults: action.maxResults,
      searchEngine,
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
