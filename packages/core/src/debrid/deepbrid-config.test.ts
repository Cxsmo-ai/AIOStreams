import assert from 'node:assert/strict';
import test from 'node:test';
import { getDeepbridPreCacheOptions } from './deepbrid-config.js';

test('normalizes Deepbrid pre-cache options from saved service forms', () => {
  assert.deepEqual(getDeepbridPreCacheOptions({ preCache: 'true' }), {
    preCache: true,
    preCacheLimit: 24,
  });
  assert.deepEqual(
    getDeepbridPreCacheOptions({ preCache: true, preCacheLimit: '500' }),
    { preCache: true, preCacheLimit: 100 }
  );
  assert.deepEqual(getDeepbridPreCacheOptions({ preCache: 'false' }), {
    preCache: false,
    preCacheLimit: 24,
  });
});
