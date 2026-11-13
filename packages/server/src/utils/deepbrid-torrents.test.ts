import assert from 'node:assert/strict';
import test from 'node:test';
import type { DeepbridTorrent } from '@aiostreams/core';
import { projectDeepbridTorrentStatus } from './deepbrid-torrents.js';

test('Deepbrid torrent projection returns bounded fields and omits links, hashes, and files', () => {
  const torrent = {
    id: '42',
    hash: 'private-infohash',
    title: 'Example release',
    status: 'downloading',
    progress: 42.5,
    size: 1024,
    seeders: 7,
    speed: '3.2 MB/s',
    files: [
      {
        name: 'episode.mkv',
        link: 'https://provider.example/private/signed-link',
        size: 1024,
        sizeHuman: '1 KB',
      },
    ],
  } as unknown as DeepbridTorrent;

  const projected = projectDeepbridTorrentStatus([torrent]);
  assert.deepEqual(projected, [
    {
      id: '42',
      title: 'Example release',
      status: 'downloading',
      progress: 42.5,
      size: 1024,
      seeders: 7,
      speed: '3.2 MB/s',
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(projected),
    /private-infohash|signed-link/
  );
  assert.equal('files' in projected[0]!, false);
});

test('Deepbrid torrent projection normalizes unknown status and bounds provider values', () => {
  const projected = projectDeepbridTorrentStatus([
    {
      id: '1',
      title: 'unsafe\u0000 title',
      status: 'provider-internal-detail',
      progress: 500,
      size: -1,
      seeders: -2,
      speed: 'fast\nprivate',
      files: [],
    },
  ] as unknown as DeepbridTorrent[]);

  assert.deepEqual(projected[0], {
    id: '1',
    title: 'unsafe title',
    status: 'unknown',
    progress: 100,
    speed: 'fastprivate',
  });
});

test('Deepbrid torrent projection caps provider list size', () => {
  const torrents = Array.from({ length: 502 }, (_, index) => ({
    id: String(index),
    title: `torrent ${index}`,
    status: 'queued',
    files: [],
  })) as DeepbridTorrent[];
  assert.equal(projectDeepbridTorrentStatus(torrents).length, 500);
});
