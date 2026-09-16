import test from 'node:test';
import assert from 'node:assert/strict';
import { getAniListMetadata } from './anilist.js';

test('rejects invalid public IDs without a network call', async () => {
  assert.equal(await getAniListMetadata(0), undefined);
  assert.equal(await getAniListMetadata(-1), undefined);
  assert.equal(await getAniListMetadata(Number.NaN), undefined);
});
