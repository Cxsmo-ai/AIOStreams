import assert from 'node:assert/strict';
import test from 'node:test';
import { exportRedactedDeepbridDiagnostics } from './deepbrid-diagnostic-export.mjs';

test('exports only allowlisted timing, resolution, and failure fields', () => {
  const secretLine = JSON.stringify({
    time: 1_794_500_000_000,
    msg: 'Deepbrid Finder content resolution incomplete',
    requestTraceId: 'trace-safe-to-omit',
    candidates: 10,
    attempted: 8,
    contentRequests: 9,
    resolutionFailures: 2,
    stopReason: 'deadline',
    deadlineReached: true,
    resolutionFailureClasses: {
      timeout: 1,
      connection: 1,
      raw: 'https://private.example/path?token=secret',
    },
    apiFailureKinds: { api_12: 2, unknown: 'secret-value' },
    filename: 'private-release.mkv',
    url: 'https://signed.example/download?token=secret',
    password: 'profile-secret',
    err: 'provider error includes credentials',
    api: {
      attempts: 14,
      attemptsByKind: { search: 4, content: 10, token: 'secret' },
      responses: { success: 10, rateLimited: 1, serverError: 1 },
      queueWait: { samples: 14, p50Ms: 20, p95Ms: 400, raw: 'private' },
      responseHeaders: { samples: 10, p50Ms: 90, p95Ms: 900, url: 'private' },
      searchCache: {
        freshHits: 3,
        coldFetches: 4,
        coldFetch: { samples: 4, p50Ms: 120, p95Ms: 600 },
      },
      sharedAccountGate: {
        currentRequestsInRollingMinute: 20,
        requestStartLimitPerMinute: 75,
        apiKey: 'secret',
      },
    },
  });
  const output = exportRedactedDeepbridDiagnostics([secretLine], new Date(0));
  const serialized = JSON.stringify(output);

  assert.equal(output.events.length, 1);
  assert.equal(output.events[0].status, 'incomplete');
  assert.equal(output.events[0].resolution.stopReason, 'deadline');
  assert.equal(output.events[0].api.queueWait.p95Ms, 400);
  assert.equal(output.events[0].api.searchCache.coldFetch.p50Ms, 120);
  assert.equal(
    output.events[0].api.sharedAccountGate.requestStartLimitPerMinute,
    75
  );
  assert.doesNotMatch(
    serialized,
    /private\.example|signed\.example|secret|private-release|trace-safe-to-omit|credentials/
  );
  assert.deepEqual(output.privacy, {
    containsProfileCredentials: false,
    containsProviderUrls: false,
    containsFilenames: false,
    containsRawErrors: false,
  });
});

test('ignores unknown event shapes, counts malformed lines, and skips oversized lines', () => {
  const known = JSON.stringify({
    msg: 'Deepbrid Finder content resolution accounting',
    candidates: 1,
    stopReason: 'complete',
  });
  const oversized = ' '.repeat(1_048_577);
  const output = exportRedactedDeepbridDiagnostics(
    [
      'not-json',
      JSON.stringify({ msg: 'unrelated message', token: 'private' }),
      known,
      oversized,
    ],
    new Date(0)
  );

  assert.equal(output.input.acceptedEvents, 1);
  assert.equal(output.input.malformedLines, 1);
  assert.equal(output.input.ignoredLines, 1);
  assert.equal(output.input.oversizedLines, 1);
  assert.equal(output.events[0].status, 'complete');
});
