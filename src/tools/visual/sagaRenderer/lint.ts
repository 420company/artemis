import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SagaCompositionSpec, SagaLintFinding, SagaLintReport, SagaSegmentInput } from './types.js';

// Saga lint — runs WITHOUT a real DOM. We parse with regexes scoped to the
// well-known data-* attributes our writer emits. The goal is to surface the
// authoring mistakes we actually see in production:
//
//  - missing data-composition-id on the root
//  - timed elements without class="clip"
//  - timeline attribute that isn't a finite number
//  - track index collisions (same time + same track, different element)
//  - non-determinism leakage (Date.now, Math.random, fetch, setTimeout)
//  - iframes (capture cannot scrub them)
//  - GSAP from() inside a clip scene without an explicit fromTo backstop
//  - segment files missing on disk
//
// We don't try to be a full HTML parser — when something is too weird to
// parse we emit a `warning` rather than failing.

const TIMED_ATTR_RE = /data-(?:start|duration|track-index)/;

function compactAttribute(attrs: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`);
  const match = attrs.match(re);
  return match ? match[1]! : null;
}

function safeReadJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export type SagaLintInput = {
  composition: SagaCompositionSpec;
  segments: SagaSegmentInput[];
  htmlPath: string;
  manifestPath?: string;
  segmentsExist: (segmentMediaPath: string) => Promise<boolean>;
};

export async function lintSagaComposition(input: SagaLintInput): Promise<SagaLintReport> {
  const findings: SagaLintFinding[] = [];

  let html = '';
  try {
    html = await readFile(input.htmlPath, 'utf8');
  } catch (error) {
    findings.push({
      level: 'error',
      code: 'composition.unreadable',
      message: `Cannot read composition html at ${input.htmlPath}: ${error instanceof Error ? error.message : String(error)}`,
    });
    return summarize(findings);
  }

  if (!/data-composition-id\s*=\s*"[^"]+"/i.test(html)) {
    findings.push({
      level: 'error',
      code: 'composition.missing-id',
      message: 'Root element must have a data-composition-id attribute.',
    });
  }

  // Find every element that has any of the timed data-* attributes; verify
  // class="clip" is present so the runtime can manage visibility.
  const tagRe = /<([a-z][a-z0-9-]*)\b([^>]*)>/gi;
  const seenSlots = new Map<string, string>();
  for (const match of html.matchAll(tagRe)) {
    const tag = match[1]!.toLowerCase();
    const attrs = match[2] ?? '';
    if (!TIMED_ATTR_RE.test(attrs)) continue;
    if (tag === 'div' && /data-composition-id/i.test(attrs)) continue;

    const cls = compactAttribute(attrs, 'class') ?? '';
    if (!/\bclip\b/.test(cls)) {
      findings.push({
        level: 'warning',
        code: 'clip.missing-class',
        message: `<${tag}> with timed data attributes is missing class="clip"; runtime cannot manage its visibility.`,
      });
    }

    const start = Number(compactAttribute(attrs, 'data-start') ?? '');
    const duration = Number(compactAttribute(attrs, 'data-duration') ?? '');
    const trackRaw = compactAttribute(attrs, 'data-track-index');
    const track = Number(trackRaw ?? '0');
    if (!Number.isFinite(start)) {
      findings.push({
        level: 'error',
        code: 'clip.bad-start',
        message: `<${tag}> has invalid data-start="${compactAttribute(attrs, 'data-start')}".`,
      });
    }
    if (!Number.isFinite(duration) || duration <= 0) {
      findings.push({
        level: 'error',
        code: 'clip.bad-duration',
        message: `<${tag}> has invalid data-duration="${compactAttribute(attrs, 'data-duration')}".`,
      });
    }
    if (!Number.isFinite(track)) {
      findings.push({
        level: 'warning',
        code: 'clip.bad-track',
        message: `<${tag}> has non-numeric data-track-index="${trackRaw}".`,
      });
    }
    const id = compactAttribute(attrs, 'id');
    if (id && Number.isFinite(start) && Number.isFinite(duration) && Number.isFinite(track)) {
      const slot = `${track}:${start.toFixed(2)}`;
      const existing = seenSlots.get(slot);
      if (existing && existing !== id) {
        findings.push({
          level: 'warning',
          code: 'clip.track-collision',
          message: `Track ${track} has overlapping clips at t=${start.toFixed(2)}: "${existing}" vs "${id}".`,
        });
      }
      seenSlots.set(slot, id);
    }
  }

  if (/<iframe\b/i.test(html)) {
    findings.push({
      level: 'error',
      code: 'composition.iframe',
      message: 'Iframes are forbidden — capture engine cannot scrub inside them.',
    });
  }

  if (/\bDate\.now\(/.test(html)) {
    findings.push({
      level: 'warning',
      code: 'composition.non-deterministic',
      message: 'Composition contains Date.now(); rendered output will not be reproducible.',
    });
  }
  if (/\bMath\.random\(/.test(html)) {
    findings.push({
      level: 'warning',
      code: 'composition.non-deterministic',
      message: 'Composition contains Math.random(); rendered output will not be reproducible.',
    });
  }
  if (/\bfetch\(/.test(html)) {
    findings.push({
      level: 'warning',
      code: 'composition.network',
      message: 'Composition contains fetch(); rendered output may depend on network state.',
    });
  }
  if (/\bsetTimeout\(|\bsetInterval\(/.test(html)) {
    findings.push({
      level: 'warning',
      code: 'composition.async-motion',
      message: 'setTimeout/setInterval do not scrub deterministically with the timeline.',
    });
  }

  if (/\.from\(/.test(html) && !/\.fromTo\(/.test(html)) {
    findings.push({
      level: 'info',
      code: 'composition.prefer-fromto',
      message: 'Prefer tl.fromTo() over tl.from() inside .clip scenes (immediateRender hazard).',
    });
  }

  if (input.manifestPath) {
    try {
      const manifestText = await readFile(input.manifestPath, 'utf8');
      const manifest = safeReadJson<{ duration?: number; segments?: Array<{ duration?: number }> }>(manifestText);
      if (manifest) {
        const sum = (manifest.segments ?? []).reduce((acc, seg) => acc + (seg.duration ?? 0), 0);
        if (manifest.duration && Math.abs(manifest.duration - sum) > 0.05) {
          findings.push({
            level: 'warning',
            code: 'manifest.duration-mismatch',
            message: `Manifest duration ${manifest.duration} does not equal sum of segment durations ${sum.toFixed(2)}.`,
          });
        }
      }
    } catch {
      // manifest absence is not an error here.
    }
  }

  for (const segment of input.segments) {
    const exists = await input.segmentsExist(segment.mediaPath);
    if (!exists) {
      findings.push({
        level: 'error',
        code: 'segment.missing',
        message: `Segment ${segment.index} media not found: ${segment.mediaPath}`,
        segmentIndex: segment.index,
      });
    }
  }

  return summarize(findings);
}

export function formatLintReport(report: SagaLintReport): string {
  if (report.findings.length === 0) {
    return 'saga lint: 0 errors, 0 warnings';
  }
  const lines: string[] = [];
  for (const finding of report.findings) {
    const prefix = finding.level === 'error' ? 'ERROR' : finding.level === 'warning' ? 'WARN' : 'INFO';
    lines.push(`[${prefix}] ${finding.code}: ${finding.message}`);
  }
  lines.push(`saga lint summary: ${report.errors} errors, ${report.warnings} warnings, ${report.infos} infos`);
  return lines.join('\n');
}

function summarize(findings: SagaLintFinding[]): SagaLintReport {
  const errors = findings.filter((f) => f.level === 'error').length;
  const warnings = findings.filter((f) => f.level === 'warning').length;
  const infos = findings.filter((f) => f.level === 'info').length;
  return { errors, warnings, infos, findings };
}

// Convenience helper used by render orchestrator: lift the manifest path
// from the same directory as the html (we always co-locate them).
export function manifestPathFor(htmlPath: string): string {
  return path.join(path.dirname(htmlPath), 'saga.json');
}
