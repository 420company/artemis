import { homedir } from 'node:os';
import { createProviderFromConfig } from './factory.js';
import { ProviderStore } from './store.js';
import type {
  ChatProvider,
  ProviderConfig,
  ProviderProfileTelemetry,
  ProviderResponse,
} from './types.js';

export type ProviderTelemetryContext = {
  cwd?: string;
  profileId?: string;
  profileLabel?: string;
};

export type ProviderTelemetrySample = {
  ok: boolean;
  recordedAt: string;
  durationMs?: number;
  firstResponseMs?: number;
  errorMessage?: string;
};

function sanitizeMs(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.round(value);
}

function sanitizeMessage(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const singleLine = value.replace(/\s+/g, ' ').trim();
  if (!singleLine) return undefined;
  return singleLine.slice(0, 240);
}

function rollAverage(
  previous: number | undefined,
  count: number,
  nextValue: number | undefined,
): number | undefined {
  if (typeof nextValue !== 'number') {
    return previous;
  }
  if (count <= 0 || typeof previous !== 'number' || !Number.isFinite(previous)) {
    return nextValue;
  }
  return Math.round(((previous * count) + nextValue) / (count + 1));
}

function updateMin(
  previous: number | undefined,
  nextValue: number | undefined,
): number | undefined {
  if (typeof nextValue !== 'number') return previous;
  if (typeof previous !== 'number') return nextValue;
  return Math.min(previous, nextValue);
}

function updateMax(
  previous: number | undefined,
  nextValue: number | undefined,
): number | undefined {
  if (typeof nextValue !== 'number') return previous;
  if (typeof previous !== 'number') return nextValue;
  return Math.max(previous, nextValue);
}

export function normalizeProviderProfileTelemetry(
  input: unknown,
): ProviderProfileTelemetry | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }

  const telemetry = input as Record<string, unknown>;
  const sampleCount =
    typeof telemetry.sampleCount === 'number' && telemetry.sampleCount >= 0
      ? Math.round(telemetry.sampleCount)
      : 0;
  const successCount =
    typeof telemetry.successCount === 'number' && telemetry.successCount >= 0
      ? Math.round(telemetry.successCount)
      : 0;
  const errorCount =
    typeof telemetry.errorCount === 'number' && telemetry.errorCount >= 0
      ? Math.round(telemetry.errorCount)
      : 0;

  return {
    sampleCount,
    successCount,
    errorCount,
    lastStatus:
      telemetry.lastStatus === 'ok' || telemetry.lastStatus === 'error'
        ? telemetry.lastStatus
        : undefined,
    lastRecordedAt:
      typeof telemetry.lastRecordedAt === 'string'
        ? telemetry.lastRecordedAt
        : undefined,
    lastDurationMs: sanitizeMs(telemetry.lastDurationMs as number | undefined),
    avgDurationMs: sanitizeMs(telemetry.avgDurationMs as number | undefined),
    minDurationMs: sanitizeMs(telemetry.minDurationMs as number | undefined),
    maxDurationMs: sanitizeMs(telemetry.maxDurationMs as number | undefined),
    lastFirstResponseMs: sanitizeMs(
      telemetry.lastFirstResponseMs as number | undefined,
    ),
    avgFirstResponseMs: sanitizeMs(
      telemetry.avgFirstResponseMs as number | undefined,
    ),
    minFirstResponseMs: sanitizeMs(
      telemetry.minFirstResponseMs as number | undefined,
    ),
    maxFirstResponseMs: sanitizeMs(
      telemetry.maxFirstResponseMs as number | undefined,
    ),
    lastError:
      typeof telemetry.lastError === 'string' ? telemetry.lastError : undefined,
  };
}

function applyTelemetrySample(
  current: ProviderProfileTelemetry | undefined,
  sample: ProviderTelemetrySample,
): ProviderProfileTelemetry {
  const previous = normalizeProviderProfileTelemetry(current) ?? {
    sampleCount: 0,
    successCount: 0,
    errorCount: 0,
  };

  const nextSampleCount = previous.sampleCount + 1;
  const nextSuccessCount = previous.successCount + (sample.ok ? 1 : 0);
  const nextErrorCount = previous.errorCount + (sample.ok ? 0 : 1);

  return {
    sampleCount: nextSampleCount,
    successCount: nextSuccessCount,
    errorCount: nextErrorCount,
    lastStatus: sample.ok ? 'ok' : 'error',
    lastRecordedAt: sample.recordedAt,
    lastDurationMs: sample.durationMs,
    avgDurationMs: rollAverage(
      previous.avgDurationMs,
      previous.sampleCount,
      sample.durationMs,
    ),
    minDurationMs: updateMin(previous.minDurationMs, sample.durationMs),
    maxDurationMs: updateMax(previous.maxDurationMs, sample.durationMs),
    lastFirstResponseMs: sample.firstResponseMs,
    avgFirstResponseMs: rollAverage(
      previous.avgFirstResponseMs,
      previous.sampleCount,
      sample.firstResponseMs,
    ),
    minFirstResponseMs: updateMin(
      previous.minFirstResponseMs,
      sample.firstResponseMs,
    ),
    maxFirstResponseMs: updateMax(
      previous.maxFirstResponseMs,
      sample.firstResponseMs,
    ),
    lastError: sample.ok ? undefined : sample.errorMessage,
  };
}

export async function recordProviderProfileTelemetry(
  context: ProviderTelemetryContext,
  sample: ProviderTelemetrySample,
): Promise<void> {
  if (!context.cwd || !context.profileId) {
    return;
  }

  const candidateRoots = [context.cwd];
  const home = homedir();
  if (home !== context.cwd) {
    candidateRoots.push(home);
  }

  for (const root of candidateRoots) {
    const store = new ProviderStore(root);
    const data = await store.load();
    const index = data.profiles.findIndex(
      (profile) => profile.id === context.profileId,
    );
    if (index < 0) {
      continue;
    }

    const current = data.profiles[index]!;
    data.profiles[index] = {
      ...current,
      telemetry: applyTelemetrySample(current.telemetry, sample),
    };
    await store.save(data);
    return;
  }
}

export function annotateProviderResponse(
  result: ProviderResponse,
  config: ProviderConfig,
  context: ProviderTelemetryContext,
): ProviderResponse {
  const durationMs = sanitizeMs(result.usage?.durationMs);
  const firstResponseMs = sanitizeMs(
    result.usage?.firstResponseMs ?? result.usage?.durationMs,
  );

  return {
    ...result,
    usage: {
      ...result.usage,
      durationMs,
      firstResponseMs,
      profileId: context.profileId,
      profileLabel: context.profileLabel ?? context.profileId,
      protocol: config.protocol,
    },
  };
}

export function formatLatencyMs(value: number | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  if (value >= 10_000) {
    return `${(value / 1000).toFixed(1)}s`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(2)}s`;
  }
  return `${Math.round(value)}ms`;
}

export function formatProviderUsageTelemetry(
  usage: ProviderResponse['usage'] | undefined,
  options: { includeProfile?: boolean } = {},
): string | undefined {
  if (!usage) {
    return undefined;
  }

  const bits: string[] = [];
  if (options.includeProfile !== false) {
    const label = usage.profileLabel ?? usage.profileId;
    if (label) {
      bits.push(`profile=${label}`);
    }
  }

  const first = formatLatencyMs(usage.firstResponseMs);
  if (first) {
    bits.push(`first=${first}`);
  }

  const total = formatLatencyMs(usage.durationMs);
  if (total) {
    bits.push(`total=${total}`);
  }

  return bits.length > 0 ? bits.join(' ') : undefined;
}

export function formatProviderProfileTelemetry(
  telemetry: ProviderProfileTelemetry | undefined,
): string {
  const normalized = normalizeProviderProfileTelemetry(telemetry);
  if (!normalized || normalized.sampleCount <= 0) {
    return 'telemetry: no calls yet';
  }

  const bits = [
    `calls=${normalized.sampleCount}`,
    `ok=${normalized.successCount}`,
    `err=${normalized.errorCount}`,
  ];

  const firstLast = formatLatencyMs(normalized.lastFirstResponseMs);
  const firstAvg = formatLatencyMs(normalized.avgFirstResponseMs);
  if (firstLast || firstAvg) {
    bits.push(
      `first=${firstLast ?? 'n/a'}${firstAvg ? ` avg ${firstAvg}` : ''}`,
    );
  }

  const totalLast = formatLatencyMs(normalized.lastDurationMs);
  const totalAvg = formatLatencyMs(normalized.avgDurationMs);
  if (totalLast || totalAvg) {
    bits.push(
      `total=${totalLast ?? 'n/a'}${totalAvg ? ` avg ${totalAvg}` : ''}`,
    );
  }

  if (normalized.lastStatus) {
    bits.push(`last=${normalized.lastStatus}`);
  }
  if (normalized.lastStatus === 'error' && normalized.lastError) {
    bits.push(`error=${normalized.lastError}`);
  }

  return bits.join('  ·  ');
}

export function createTrackedProviderFromConfig(
  config: ProviderConfig,
  context: ProviderTelemetryContext = {},
): ChatProvider {
  const provider = createProviderFromConfig(config);
  if (!context.cwd || !context.profileId) {
    return provider;
  }

  const wrapResult = async (result: ProviderResponse): Promise<ProviderResponse> => {
    const annotated = annotateProviderResponse(result, config, context);
    const sample: ProviderTelemetrySample = {
      ok: true,
      recordedAt: new Date().toISOString(),
      durationMs: sanitizeMs(annotated.usage?.durationMs),
      firstResponseMs: sanitizeMs(annotated.usage?.firstResponseMs),
    };
    await recordProviderProfileTelemetry(context, sample);
    return annotated;
  };

  const wrapError = async (startedAt: number, error: unknown): Promise<never> => {
    const message = error instanceof Error ? error.message : String(error);
    await recordProviderProfileTelemetry(context, {
      ok: false,
      recordedAt: new Date().toISOString(),
      durationMs: Math.max(Date.now() - startedAt, 0),
      errorMessage: sanitizeMessage(message),
    });
    throw error;
  };

  const wrapped: ChatProvider = {
    supportsImages: provider.supportsImages,
    supportsNativeToolCalls: provider.supportsNativeToolCalls,
    async complete(messages, options) {
      const startedAt = Date.now();
      try {
        return await wrapResult(await provider.complete(messages, options));
      } catch (error) {
        return wrapError(startedAt, error);
      }
    },
  };

  if (typeof provider.completeStream === 'function') {
    wrapped.completeStream = async (messages, onChunk, options) => {
      const startedAt = Date.now();
      try {
        return await wrapResult(
          await provider.completeStream!(messages, onChunk, options),
        );
      } catch (error) {
        return wrapError(startedAt, error);
      }
    };
  }

  return wrapped;
}
