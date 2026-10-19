import assert from 'node:assert/strict';
import test from 'node:test';
import type { Addon, ParsedStream, UserData } from '../db/schemas.js';
import { orderTorrentClawStreams } from './sorter.js';

function torrentClaw(
  id: string,
  resolution: string,
  size: number,
  cached: boolean,
  wrapped = false
): ParsedStream {
  return {
    id,
    addon: {
      name: wrapped ? 'TorrentClaw Usenet' : 'TorrentClaw',
      manifestUrl: 'https://example.com/manifest.json',
      enabled: true,
      preset: {
        id: 'tc',
        type: wrapped ? 'deepbrid-usenet' : 'torrentclaw',
        options: {},
      },
      instanceId: 'tc',
    } as Addon,
    type: 'debrid',
    service: { id: 'torbox', cached },
    size,
    parsedFile: { resolution } as ParsedStream['parsedFile'],
  } as ParsedStream;
}

test('orders TorrentClaw globally by resolution then descending size across cache states', () => {
  const input = [
    torrentClaw('720-cached', '720p', 5_000_000_000, true),
    {
      id: 'other-addon',
      addon: {
        name: 'Other addon',
        manifestUrl: 'https://example.com/other/manifest.json',
        enabled: true,
        preset: { id: 'other', type: 'custom', options: {} },
      } as Addon,
    } as ParsedStream,
    torrentClaw('1080-small-cached', '1080p', 700_000_000, true),
    torrentClaw('1080-large-uncached', '1080p', 4_500_000_000, false, true),
    torrentClaw('2160-small-uncached', '2160p', 1_000_000_000, false),
  ];

  const result = orderTorrentClawStreams(
    input,
    { preferredResolutions: ['2160p', '1080p', '720p'] } as UserData,
    'desc'
  );

  assert.deepEqual(
    result
      .filter((stream) => stream.addon.name.includes('TorrentClaw'))
      .map((stream) => stream.id),
    [
      '2160-small-uncached',
      '1080-large-uncached',
      '1080-small-cached',
      '720-cached',
    ]
  );
  assert.equal(result[1]?.id, 'other-addon');
});
