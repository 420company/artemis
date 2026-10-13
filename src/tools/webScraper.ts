/**
 * `web_scraper` — fetch a URL and return its readable text content.
 *
 * WP-2: this tool was declared as a stub (no `execute`) and removed in the
 * engine cleanup. This file provides the real executor.
 *
 * Implementation: reuses the hardened fetch pipeline from httpRequest.ts
 * (SSRF protection with DNS pinning, redirect limits, timeout + inactivity
 * watchdog, body cap) via the structured `executeHttpRequestRaw` API, then
 * strips HTML to readable text. Non-HTML content types are returned with a
 * short note instead of being parsed.
 */
import { executeHttpRequestRaw, httpToolErrorResult } from './httpRequest.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';

const MAX_TEXT_CHARS = 100_000;

/** Very small HTML-to-text: removes scripts/styles, converts block tags to newlines. */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  // Block-level tags -> newline so paragraphs don't merge.
  text = text.replace(/<\/?(p|div|br|li|tr|h[1-6]|section|article|header|footer|blockquote|pre)[^>]*>/gi, '\n');
  // Remaining tags -> space.
  text = text.replace(/<[^>]+>/g, ' ');
  // Decode common entities (order matters: &amp; last).
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
  // Collapse whitespace, drop empty lines.
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
  return text;
}

export interface WebScraperAction {
  type: 'web_scraper';
  url: string;
  timeoutMs?: number;
  maxChars?: number;
}

export async function executeWebScraper(
  action: WebScraperAction,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  if (action?.maxChars !== undefined && !Number.isInteger(action.maxChars)) {
    return {
      action: action as unknown as ToolExecutionResult['action'],
      ok: false,
      output: '`maxChars` must be an integer.',
      error: { code: 'invalid_maxChars', message: '`maxChars` must be an integer.', retryable: false },
    };
  }
  let raw;
  try {
    raw = await executeHttpRequestRaw(
      { type: 'http_request', url: action?.url, method: 'GET', timeoutMs: action?.timeoutMs },
      context,
    );
  } catch (error) {
    // Pass through failures (SSRF blocks, timeouts, DNS failures) as-is.
    return httpToolErrorResult(action, error);
  }
  if (raw.status < 200 || raw.status >= 300) {
    return {
      action: action as unknown as ToolExecutionResult['action'],
      ok: false,
      output: `web_scraper: HTTP ${raw.status} for ${action.url}`,
      error: {
        code: 'http_error',
        message: `HTTP ${raw.status}`,
        retryable: raw.status >= 500 || raw.status === 429,
      },
    };
  }

  const contentType = (raw.headers['content-type'] ?? '').toLowerCase();
  const body = raw.bodyText;

  const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml');
  if (!isHtml) {
    const kind = contentType.includes('application/json')
      ? 'JSON'
      : contentType.includes('text/')
        ? 'plain text'
        : contentType || 'unknown type';
    return {
      action: action as unknown as ToolExecutionResult['action'],
      ok: true,
      output: [
        `URL: ${raw.finalUrl}`,
        `Content-Type: ${contentType || '(none)'} — not HTML, returning raw ${kind} (first ${MAX_TEXT_CHARS} chars):`,
        '',
        body.slice(0, MAX_TEXT_CHARS),
      ].join('\n'),
    };
  }

  const maxChars = Math.min(Math.max(action.maxChars ?? MAX_TEXT_CHARS, 1000), MAX_TEXT_CHARS);
  const text = htmlToText(body).slice(0, maxChars);
  return {
    action: action as unknown as ToolExecutionResult['action'],
    ok: true,
    output: [`URL: ${raw.finalUrl}`, `Extracted text (${text.length} chars):`, '', text].join('\n'),
  };
}
