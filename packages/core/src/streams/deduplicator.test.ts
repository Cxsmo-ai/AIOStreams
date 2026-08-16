import assert from 'node:assert/strict';
import test from 'node:test';
import type { Addon, ParsedStream, UserData } from '../db/schemas.js';
import StreamDeduplicator from './deduplicator.js';

function addon(id: string): Addon {
  return {
    name: id,
    manifestUrl: `https://example.com/${id}/manifest.json`,
    enabled: true,
    preset: { id, type: 'deepbrid-usenet', options: {} },
    instanceId: id,
  } as Addon;
}

function directUsenet(
  id: string,
  addonId: string,
  filename: string,
  type: 'usenet' | 'stremio-usenet' = 'usenet'
): ParsedStream {
  return {
    id,
    addon: addon(addonId),
    type,
    proxied: false,
    url: `https://storage.example/${id}.mkv`,
    filename,
  } as ParsedStream;
}

function serviceUsenet(
  id: string,
  serviceId: 'deepbrid' | 'torbox' | 'aiostreams',
  filename: string
): ParsedStream {
  return {
    ...directUsenet(id, id, filename),
    type: 'debrid',
    service: { id: serviceId, cached: true },
    nzbUrl: 'https://example.com/release.nzb',
  } as ParsedStream;
}

function deduplicator(
  options: NonNullable<UserData['deduplicator']>
): StreamDeduplicator {
  return new StreamDeduplicator({
    deduplicator: options,
    services: [],
    presets: [],
  } as UserData);
}

test('keeps service-less direct Usenet streams when deduplication is enabled', async () => {
  const streams = [
    directUsenet('one', 'deepbrid', 'Show.S01E01.1080p.mkv'),
    directUsenet('two', 'deepbrid', 'Show.S01E01.720p.mkv'),
  ];

  const result = await deduplicator({ enabled: true }).deduplicate(streams);

  assert.deepEqual(
    result.map((stream) => stream.id),
    ['one', 'two']
  );
});

test('uses per-addon behavior when uncached deduplication is per-service', async () => {
  const filename = 'Show.S01E01.1080p.mkv';
  const streams = [
    directUsenet('deepbrid-one', 'deepbrid', filename),
    directUsenet('deepbrid-two', 'deepbrid', filename),
    directUsenet('other', 'other-addon', filename),
  ];

  const result = await deduplicator({
    enabled: true,
    uncached: 'per_service',
  }).deduplicate(streams);

  assert.equal(result.length, 2);
  assert.deepEqual(
    new Set(result.map((stream) => stream.addon.preset.id)),
    new Set(['deepbrid', 'other-addon'])
  );
});

test('applies the direct Usenet fallback to stremio-usenet streams', async () => {
  const result = await deduplicator({ enabled: true }).deduplicate([
    directUsenet(
      'native-nntp',
      'native-usenet',
      'Movie.2026.1080p.mkv',
      'stremio-usenet'
    ),
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0]?.id, 'native-nntp');
});

test('deduplicates Deepbrid against TorBox but keeps native AIOStreams separate', async () => {
  const filename = 'Show.S01E01.1080p.mkv';
  const result = await deduplicator({
    enabled: true,
    cached: 'single_result',
  }).deduplicate([
    serviceUsenet('torbox', 'torbox', filename),
    serviceUsenet('deepbrid', 'deepbrid', filename),
    serviceUsenet('native', 'aiostreams', filename),
  ]);

  assert.deepEqual(
    result.map((stream) => stream.id).sort(),
    ['deepbrid', 'native']
  );
});
