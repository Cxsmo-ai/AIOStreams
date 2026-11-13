import { describe, expect, it } from 'vitest';
import { createDeepbridDiagnosticExport } from './deepbrid-diagnostics';
import type {
  DeepbridProfileMetrics,
  DeepbridProfileSelfTestResult,
} from '@/lib/api';

const metrics: DeepbridProfileMetrics = {
  scope: 'since-process-start',
  search: {
    coldFetches: 4,
    failedColdFetches: 1,
    freshCacheHits: 2,
    coalescedRequests: 3,
    p50Ms: 120,
    p95Ms: 380,
    samples: 4,
    warmP50Ms: 2,
    warmP95Ms: 5,
    warmSamples: 2,
    // A future API extension must not leak through the diagnostic projection.
    privateUrl: 'https://private.example/path?token=do-not-export',
  } as DeepbridProfileMetrics['search'],
  queue: { p50Ms: 10, p95Ms: 20, samples: 5 },
  rateLimitedResponses: 1,
  transportFailures: 2,
  apiKey: 'never-export-this',
} as DeepbridProfileMetrics;

const selfTest: DeepbridProfileSelfTestResult = {
  overall: 'passed',
  account: { status: 'connected', durationMs: 42 },
  checks: [
    { id: 'rate-limit-retry', status: 'passed', durationMs: 3 },
    { id: 'release-parser', status: 'passed', durationMs: 1 },
    { id: 'archive-gap-parser', status: 'passed', durationMs: 1 },
  ],
  accountUrl: 'https://private.example/account?token=do-not-export',
} as DeepbridProfileSelfTestResult;

describe('Deepbrid diagnostic export', () => {
  it('uses a strict allow-list and redacts future sensitive response fields', () => {
    const serialized = JSON.stringify(
      createDeepbridDiagnosticExport({
        generatedAt: new Date('2026-11-12T12:00:00.000Z'),
        metrics,
        selfTest,
      })
    );

    expect(serialized).toContain('aiostreams.deepbrid-diagnostics.v1');
    expect(serialized).toContain('rate-limit-retry');
    expect(serialized).not.toContain('private.example');
    expect(serialized).not.toContain('do-not-export');
    expect(serialized).not.toContain('never-export-this');
    expect(serialized).not.toContain('apiKey');
  });

  it('supports diagnostics without a prior account self-test', () => {
    const result = createDeepbridDiagnosticExport({ metrics });
    expect(result.selfTest).toBeNull();
  });

  it('sanitizes malformed values inside allow-listed self-test fields', () => {
    const malformed = {
      ...selfTest,
      overall: 'https://private.example/token=secret',
      account: {
        ...selfTest.account,
        failureKind: 'Bearer private-secret',
      },
      checks: [
        {
          id: 'https://private.example/signed-url',
          status: 'private-secret',
          durationMs: 1,
        },
      ],
    } as unknown as DeepbridProfileSelfTestResult;
    const serialized = JSON.stringify(
      createDeepbridDiagnosticExport({ metrics, selfTest: malformed })
    );

    expect(serialized).not.toContain('private.example');
    expect(serialized).not.toContain('private-secret');
    expect(serialized).not.toContain('signed-url');
    expect(serialized).toContain('"overall":"unknown"');
    expect(serialized).toContain('"id":"unknown"');
  });

  it('normalizes malformed numeric metrics without serializing injected strings', () => {
    const malformedMetrics = {
      ...metrics,
      rateLimitedResponses: 'https://private.example/token=secret',
      search: {
        ...metrics.search,
        p95Ms: Number.POSITIVE_INFINITY,
        coldFetches: -1,
      },
    } as unknown as DeepbridProfileMetrics;
    const serialized = JSON.stringify(
      createDeepbridDiagnosticExport({ metrics: malformedMetrics })
    );

    expect(serialized).not.toContain('private.example');
    expect(serialized).not.toContain('secret');
    expect(serialized).toContain('"rateLimitedResponses":0');
    expect(serialized).toContain('"p95Ms":0');
    expect(serialized).toContain('"coldFetches":0');
  });
});
