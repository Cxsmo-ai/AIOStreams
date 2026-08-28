import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isNonFatalDeepbridUsenetError,
  isTransientRateLimitError,
  reconcileAddonStatisticCount,
} from './fetcher.js';

test('reports unique post-dedup streams while retaining the resolved count', () => {
  const result = reconcileAddonStatisticCount(
    {
      title: '[Deepbrid Usenet] Scrape Summary',
      description:
        'Status      : SUCCESS\nStreams    : 11\nDetails    : Successfully fetched streams.',
      manifestUrl: 'http://127.0.0.1/deepbrid/manifest.json',
      rawCount: 11,
    },
    4
  );

  assert.match(result.description, /Streams\s+: 4 unique/);
  assert.match(result.description, /11 resolved; 7 duplicates merged/);
});

test('keeps a simple count when deduplication removes nothing', () => {
  const result = reconcileAddonStatisticCount(
    {
      title: 'Scrape Summary',
      description: 'Streams    : 4',
      rawCount: 4,
    },
    4
  );

  assert.match(result.description, /Streams\s+: 4$/);
});

test('identifies only transient provider rate-limit errors', () => {
  assert.equal(
    isTransientRateLimitError({
      title: '[TB] TorBox',
      description: 'Request failed with HTTP 429',
    }),
    true
  );
  assert.equal(
    isTransientRateLimitError({
      title: 'Indexer',
      description: 'No matching releases found',
    }),
    false
  );
});

test('identifies non-auth Deepbrid Usenet partial failures', () => {
  assert.equal(
    isNonFatalDeepbridUsenetError({
      title: '[❌] Deepbrid Usenet DB',
      description: 'Upstream content failure',
    }),
    true
  );
  assert.equal(
    isNonFatalDeepbridUsenetError({
      title: '[❌] Deepbrid Usenet DB',
      description: 'Invalid API key',
    }),
    false
  );
  assert.equal(
    isNonFatalDeepbridUsenetError({
      title: '[TB⚡] Debridio Scraper',
      description: 'A release title contains the word failed',
    }),
    false
  );
});
