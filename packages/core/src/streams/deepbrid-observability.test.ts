import assert from 'node:assert/strict';
import test from 'node:test';
import { countDeepbridFinderStreams } from './deepbrid-observability.js';

test('counts only native Finder streams, not external indexer Deepbrid copies', () => {
  const streams = [
    { addon: { identifier: 'deepbrid-usenet' } },
    { addon: { identifier: 'newznab' } },
    { addon: { identifier: 'easynews-search' } },
    { addon: { identifier: 'deepbrid-usenet' } },
  ];

  assert.equal(countDeepbridFinderStreams(streams), 2);
});

test('returns zero when the final pipeline contains no native Finder streams', () => {
  assert.equal(
    countDeepbridFinderStreams([
      { addon: { identifier: 'newznab' } },
      { addon: { identifier: 'newshosting-indexer' } },
    ]),
    0
  );
});
