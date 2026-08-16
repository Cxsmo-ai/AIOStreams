import assert from 'node:assert/strict';
import test from 'node:test';
import { selectDeepbridUploadFile } from './deepbrid.js';

test('Deepbrid upload selection prefers the requested video over archives', () => {
  const selected = selectDeepbridUploadFile(
    [
      { name: 'release.rar', link: 'https://cdn.deepbrid.com/release.rar', size: 2_000 },
      { name: 'release.nfo', link: 'https://cdn.deepbrid.com/release.nfo', size: 500 },
      { name: 'Show.S01E01.720p.mkv', link: 'https://cdn.deepbrid.com/episode.mkv', size: 700 },
    ],
    'Show.S01E01.720p.mkv'
  );
  assert.equal(selected?.name, 'Show.S01E01.720p.mkv');
});

test('Deepbrid upload selection falls back to the largest playable video', () => {
  const selected = selectDeepbridUploadFile(
    [
      { name: 'readme.txt', link: 'https://cdn.deepbrid.com/readme.txt', size: 1 },
      { name: 'small.mp4', link: 'https://cdn.deepbrid.com/small.mp4', size: 10 },
      { name: 'large.mkv', link: 'https://cdn.deepbrid.com/large.mkv', size: 100 },
    ],
    'missing.mkv'
  );
  assert.equal(selected?.name, 'large.mkv');
});

test('Deepbrid upload selection returns no file when an upload has no video', () => {
  assert.equal(
    selectDeepbridUploadFile(
      [{ name: 'release.rar', link: 'https://cdn.deepbrid.com/release.rar' }],
      'release.mkv'
    ),
    undefined
  );
});
