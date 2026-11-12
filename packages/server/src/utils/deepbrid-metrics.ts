import type { DeepbridFinderRequestReport } from '@aiostreams/core';

export function projectDeepbridFinderMetrics(
  report: DeepbridFinderRequestReport
) {
  return {
    scope: 'since-process-start' as const,
    search: {
      coldFetches: report.searchCache.coldFetches,
      failedColdFetches: report.searchCache.coldFetchFailures,
      freshCacheHits: report.searchCache.freshHits,
      coalescedRequests: report.searchCache.coalescedRequests,
      p50Ms: report.searchCache.coldFetch.p50Ms,
      p95Ms: report.searchCache.coldFetch.p95Ms,
      samples: report.searchCache.coldFetch.samples,
      warmP50Ms: report.searchCache.freshLookup.p50Ms,
      warmP95Ms: report.searchCache.freshLookup.p95Ms,
      warmSamples: report.searchCache.freshLookup.samples,
    },
    queue: {
      p50Ms: report.queueWait.p50Ms,
      p95Ms: report.queueWait.p95Ms,
      samples: report.queueWait.samples,
    },
    rateLimitedResponses: report.responses.rateLimited,
    transportFailures: report.responses.transportFailure,
  };
}
