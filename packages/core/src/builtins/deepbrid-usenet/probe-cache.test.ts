import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearDeepbridProbeCacheForTests,
  hasSuccessfulDeepbridProbe,
  rememberSuccessfulDeepbridProbe,
} from './probe-cache.js';

test('Deepbrid probe cache admits successful probes and refreshes recency', () => {
  clearDeepbridProbeCacheForTests();
  const key = 'https://cdn.example/video.mkv\u0000mkv';
  assert.equal(hasSuccessfulDeepbridProbe(key), false);
  rememberSuccessfulDeepbridProbe(key);
  assert.equal(hasSuccessfulDeepbridProbe(key), true);
  clearDeepbridProbeCacheForTests();
  assert.equal(hasSuccessfulDeepbridProbe(key), false);
});
