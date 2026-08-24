import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resetTorboxNzbHashEnrichmentsForTests,
  scheduleTorboxNzbHashEnrichment,
  waitForTorboxNzbHashEnrichmentsForTests,
} from './torbox.js';

test.beforeEach(() => resetTorboxNzbHashEnrichmentsForTests());

test('TorBox NZB enrichment coalesces repeated protected URLs', async () => {
  let calls = 0;
  const fetchHashes = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return ['0123456789abcdef0123456789abcdef'];
  };

  const url = 'https://indexer.example/download/release.nzb';
  assert.equal(
    scheduleTorboxNzbHashEnrichment(url, 'release', fetchHashes),
    true
  );
  assert.equal(
    scheduleTorboxNzbHashEnrichment(url, 'release', fetchHashes),
    false
  );
  await waitForTorboxNzbHashEnrichmentsForTests();
  assert.equal(calls, 1);
  assert.equal(
    scheduleTorboxNzbHashEnrichment(url, 'release', fetchHashes),
    false
  );
});

test('TorBox NZB enrichment queue is bounded without affecting source handling', async () => {
  let releaseFirst: (() => void) | undefined;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const fetchHashes = async () => {
    await first;
    return ['0123456789abcdef0123456789abcdef'];
  };

  const scheduled = Array.from({ length: 16 }, (_, index) =>
    scheduleTorboxNzbHashEnrichment(
      `https://indexer.example/download/${index}.nzb`,
      `release-${index}`,
      fetchHashes
    )
  );
  assert.equal(scheduled.filter(Boolean).length, 8);
  releaseFirst?.();
  await waitForTorboxNzbHashEnrichmentsForTests();
});
