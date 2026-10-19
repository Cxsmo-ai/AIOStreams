import assert from 'node:assert/strict';
import test from 'node:test';
import { torboxSearchCacheDiscriminator } from './cache-key.js';

test('TorBox Search cache discriminator is stable and does not contain the API key', () => {
  const apiKey = '4this-is-a-test-torbox-api-key-ending-in-f';
  const first = torboxSearchCacheDiscriminator(apiKey);

  assert.equal(first, torboxSearchCacheDiscriminator(apiKey));
  assert.notEqual(first, torboxSearchCacheDiscriminator(`${apiKey}-other`));
  assert.equal(first.includes(apiKey), false);
  assert.match(first, /^[a-f0-9]{64}$/);
});
