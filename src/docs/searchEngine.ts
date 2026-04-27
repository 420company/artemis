export type DocsSearchEngine = 'bing' | 'google';

export function isDocsSearchEngine(value: string): value is DocsSearchEngine {
  return value === 'bing' || value === 'google';
}

export function formatDocsSearchEngineLabel(
  engine: DocsSearchEngine,
): string {
  return engine === 'google' ? 'Google' : 'Bing';
}
