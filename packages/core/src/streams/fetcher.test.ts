import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileAddonStatisticCount } from './fetcher.js';

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
