import type {
  DeepbridProfileMetrics,
  DeepbridProfileSelfTestResult,
} from '@/lib/api';

function safeEnum<T extends string>(
  value: unknown,
  allowed: readonly T[]
): T | 'unknown' {
  return typeof value === 'string' && allowed.includes(value as T)
    ? (value as T)
    : 'unknown';
}

function safeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Math.round(value), Number.MAX_SAFE_INTEGER)
    : 0;
}

/**
 * Build a deliberately small, allow-listed diagnostic payload.
 * Never serialize whole API objects here: future response fields may contain
 * account identifiers, URLs, or provider-issued capabilities.
 */
export function createDeepbridDiagnosticExport(input: {
  generatedAt?: Date;
  metrics: DeepbridProfileMetrics;
  selfTest?: DeepbridProfileSelfTestResult | null;
}): Record<string, unknown> {
  const { metrics } = input;
  return {
    schema: 'aiostreams.deepbrid-diagnostics.v1',
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    scope: 'process-aggregate',
    finder: {
      search: {
        coldFetches: safeNumber(metrics.search.coldFetches),
        failedColdFetches: safeNumber(metrics.search.failedColdFetches),
        freshCacheHits: safeNumber(metrics.search.freshCacheHits),
        coalescedRequests: safeNumber(metrics.search.coalescedRequests),
        p50Ms: safeNumber(metrics.search.p50Ms),
        p95Ms: safeNumber(metrics.search.p95Ms),
        samples: safeNumber(metrics.search.samples),
        warmP50Ms: safeNumber(metrics.search.warmP50Ms),
        warmP95Ms: safeNumber(metrics.search.warmP95Ms),
        warmSamples: safeNumber(metrics.search.warmSamples),
      },
      queue: {
        p50Ms: safeNumber(metrics.queue.p50Ms),
        p95Ms: safeNumber(metrics.queue.p95Ms),
        samples: safeNumber(metrics.queue.samples),
      },
      rateLimitedResponses: safeNumber(metrics.rateLimitedResponses),
      transportFailures: safeNumber(metrics.transportFailures),
    },
    selfTest: input.selfTest
      ? {
          overall: safeEnum(input.selfTest.overall, ['passed', 'failed']),
          account: {
            status: safeEnum(input.selfTest.account.status, [
              'connected',
              'failed',
            ]),
            failureKind: input.selfTest.account.failureKind
              ? safeEnum(input.selfTest.account.failureKind, [
                  'authentication',
                  'rate-limited',
                  'provider-error',
                  'network-error',
                ])
              : undefined,
            durationMs: safeNumber(input.selfTest.account.durationMs),
          },
          checks: input.selfTest.checks.map((check) => ({
            id: safeEnum(check.id, [
              'rate-limit-retry',
              'release-parser',
              'archive-gap-parser',
            ]),
            status: safeEnum(check.status, ['passed', 'failed']),
            durationMs: safeNumber(check.durationMs),
          })),
        }
      : null,
    redaction: {
      accountIdentifiers: 'omitted',
      credentials: 'omitted',
      urls: 'omitted',
      searchTerms: 'omitted',
      filenames: 'omitted',
      providerResponses: 'omitted',
    },
  };
}

export function downloadDeepbridDiagnosticExport(payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = `aiostreams-deepbrid-diagnostics-${new Date()
    .toISOString()
    .replace(/[:.]/g, '-')}.json`;
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}
