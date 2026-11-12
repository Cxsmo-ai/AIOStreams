import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DeepbridFinderRequestReport } from '@aiostreams/core';
import { projectDeepbridFinderMetrics } from './deepbrid-metrics.js';

describe('projectDeepbridFinderMetrics', () => {
  it('exposes only bounded aggregate timing and failure counters', () => {
    const report = {
      attempts: 7,
      attemptsByKind: { search: 4, content: 2, other: 1 },
      responses: {
        success: 5,
        rateLimited: 1,
        clientError: 0,
        serverError: 0,
        other: 0,
        transportFailure: 1,
      },
      transportFailuresByKind: { search: 1, content: 0, other: 0 },
      transportFailureClasses: {
        aborted: 0,
        timeout: 1,
        connection: 0,
        other: 0,
      },
      transportRetryAttemptsByKind: { search: 1, content: 0, other: 0 },
      transportRetryRecoveriesByKind: { search: 1, content: 0, other: 0 },
      queueWait: { samples: 4, p50Ms: 8, p95Ms: 40, maxMs: 60 },
      responseHeaders: { samples: 4, p50Ms: 80, p95Ms: 180, maxMs: 220 },
      searchCache: {
        freshHits: 2,
        coalescedRequests: 1,
        staleRateLimitFallbacks: 0,
        coldFetches: 3,
        coldFetchFailures: 1,
        freshLookup: { samples: 2, p50Ms: 1, p95Ms: 2, maxMs: 2 },
        coldFetch: { samples: 3, p50Ms: 300, p95Ms: 900, maxMs: 1100 },
      },
      currentFinderRequestsInRollingMinute: 3,
      currentFinderCountIsLowerBound: false,
      maxFinderRequestsInRollingMinute: 3,
      maxFinderCountIsLowerBound: false,
      rateLimit: { observations: 1, latestLimit: 100, minimumRemaining: 20 },
      advertisedRetryAfter: { observations: 1, totalMs: 1000, maxMs: 1000 },
      actualRetryWait: { observations: 1, totalMs: 900, maxMs: 900 },
      sharedAccountGate: {
        currentRequestsInRollingMinute: 3,
        currentCountIsLowerBound: false,
        maxRequestsInRollingMinute: 3,
        maxCountIsLowerBound: false,
        requestsStarted: 3,
        quotaHeaderObservations: 0,
        latestQuotaLimit: undefined,
        minimumQuotaRemaining: undefined,
        retryAfterObservations: 0,
        retryAfterTotalMs: 0,
        retryAfterMaxMs: 0,
        actualCooldownWaitObservations: 0,
        actualCooldownWaitTotalMs: 0,
        actualCooldownWaitMaxMs: 0,
        queueWait: { samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
      },
      requestPath: 'must-not-be-present',
      apiKey: 'must-not-be-present',
    } as unknown as DeepbridFinderRequestReport;

    const projected = projectDeepbridFinderMetrics(report);
    assert.deepEqual(projected.search, {
      coldFetches: 3,
      failedColdFetches: 1,
      freshCacheHits: 2,
      coalescedRequests: 1,
      p50Ms: 300,
      p95Ms: 900,
      samples: 3,
      warmP50Ms: 1,
      warmP95Ms: 2,
      warmSamples: 2,
    });
    assert.equal(projected.queue.p95Ms, 40);
    assert.equal(projected.rateLimitedResponses, 1);
    assert.doesNotMatch(
      JSON.stringify(projected),
      /must-not-be-present|path|apiKey/i
    );
  });
});
