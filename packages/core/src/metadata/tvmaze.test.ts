import test from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedMeta } from '../db/schemas.js';
import { supplementSeriesMetaWithTvMaze } from './tvmaze.js';

test('TVMaze supplement is a no-op for opaque or non-series ids', async () => {
  const meta = {
    id: 'fp:video:1',
    type: 'series',
    name: 'Video',
  } as ParsedMeta;
  assert.equal(await supplementSeriesMetaWithTvMaze('fp:video:1', meta), meta);

  const movie = { id: 'tt1234567', type: 'movie', name: 'Movie' } as ParsedMeta;
  assert.equal(await supplementSeriesMetaWithTvMaze('tt1234567', movie), movie);
});
