import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DeepbridFinderResponseCache,
  isDeepbridRateLimitError,
} from './finder-response-cache.js';

test('Finder response cache serves fresh then rate-limit-only stale data', () => {
  let now = 1_000;
  const cache = new DeepbridFinderResponseCache<{ items: string[] }>({
    freshMs: 10,
    staleMs: 50,
    now: () => now,
  });
  const value = { items: ['verified result'] };
  cache.set('profile-key-a', '/search?q=episode&offset=0', value);

  assert.deepEqual(cache.get('profile-key-a', '/search?q=episode&offset=0'), {
    value,
    freshness: 'fresh',
  });
  now += 11;
  assert.equal(
    cache.get('profile-key-a', '/search?q=episode&offset=0'),
    undefined
  );
  assert.deepEqual(
    cache.get('profile-key-a', '/search?q=episode&offset=0', true),
    { value, freshness: 'stale' }
  );
  now += 40;
  assert.equal(
    cache.get('profile-key-a', '/search?q=episode&offset=0', true),
    undefined
  );
});

test('Finder response cache isolates credentials and complete request paths', () => {
  const cache = new DeepbridFinderResponseCache<string>();
  cache.set('profile-key-a', '/search?q=episode&offset=0', 'A');
  cache.set('profile-key-b', '/search?q=episode&offset=0', 'B');
  cache.set('profile-key-a', '/search?q=episode&offset=50', 'next page');

  assert.equal(
    cache.get('profile-key-a', '/search?q=episode&offset=0')?.value,
    'A'
  );
  assert.equal(
    cache.get('profile-key-b', '/search?q=episode&offset=0')?.value,
    'B'
  );
  assert.equal(
    cache.get('profile-key-a', '/search?q=episode&offset=50')?.value,
    'next page'
  );
});

test('Finder response cache is bounded and evicts least recently used entries', () => {
  const cache = new DeepbridFinderResponseCache<string>({ maxEntries: 2 });
  cache.set('key', '/first', 'first');
  cache.set('key', '/second', 'second');
  cache.get('key', '/first');
  cache.set('key', '/third', 'third');

  assert.equal(cache.get('key', '/first')?.value, 'first');
  assert.equal(cache.get('key', '/second'), undefined);
  assert.equal(cache.get('key', '/third')?.value, 'third');
});

test('stale Finder results are permitted only for explicit rate-limit errors', () => {
  assert.equal(isDeepbridRateLimitError({ status: 429 }), true);
  assert.equal(isDeepbridRateLimitError({ code: 'api_429' }), true);
  assert.equal(isDeepbridRateLimitError({ name: 'RateLimitedError' }), true);
  assert.equal(isDeepbridRateLimitError({ status: 401 }), false);
  assert.equal(isDeepbridRateLimitError(new Error('network timeout')), false);
});
