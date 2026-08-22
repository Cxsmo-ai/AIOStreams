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
  options: NonNullable<UserData['deduplicator']>,
  services: UserData['services'] = []
): StreamDeduplicator {
  return new StreamDeduplicator({
    deduplicator: options,
    services,
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

test('deduplicates Deepbrid against TorBox by Services order but keeps native AIOStreams separate', async () => {
  const filename = 'Show.S01E01.1080p.mkv';
  const services: UserData['services'] = [
    { id: 'torbox', enabled: true, credentials: {} },
    { id: 'deepbrid', enabled: true, credentials: {} },
    { id: 'aiostreams', enabled: true, credentials: {} },
  ];
  const result = await deduplicator(
    { enabled: true, cached: 'single_result' },
    services
  ).deduplicate([
    serviceUsenet('deepbrid', 'deepbrid', filename),
    serviceUsenet('torbox', 'torbox', filename),
    serviceUsenet('native', 'aiostreams', filename),
  ]);

  assert.deepEqual(result.map((stream) => stream.id).sort(), [
    'native',
    'torbox',
  ]);
});

test('allows Deepbrid to win equivalent external Usenet results when ordered first', async () => {
  const filename = 'Show.S01E01.1080p.mkv';
  const result = await deduplicator(
    { enabled: true, cached: 'single_result' },
    [
      { id: 'deepbrid', enabled: true, credentials: {} },
      { id: 'torbox', enabled: true, credentials: {} },
      { id: 'aiostreams', enabled: true, credentials: {} },
    ]
  ).deduplicate([
    serviceUsenet('torbox', 'torbox', filename),
    serviceUsenet('deepbrid', 'deepbrid', filename),
    serviceUsenet('native', 'aiostreams', filename),
  ]);

  assert.deepEqual(result.map((stream) => stream.id).sort(), [
    'deepbrid',
    'native',
  ]);
});

test('Services order remains authoritative for TB/DB even when the lower service owns the NZB', async () => {
  const filename = 'Show.S01E01.1080p.mkv';
  const deepbrid = serviceUsenet('deepbrid', 'deepbrid', filename);
  deepbrid.service!.library = true;
  const result = await deduplicator(
    { enabled: true, cached: 'single_result' },
    [
      { id: 'torbox', enabled: true, credentials: {} },
      { id: 'deepbrid', enabled: true, credentials: {} },
    ]
  ).deduplicate([deepbrid, serviceUsenet('torbox', 'torbox', filename)]);

  assert.deepEqual(
    result.map((stream) => stream.id),
    ['torbox']
  );
});

test('Smart Detect never joins native AIOStreams to the TorBox/Deepbrid domain', async () => {
  const filename = 'Show.S01E01.1080p.mkv';
  const streams = [
    serviceUsenet('torbox', 'torbox', filename),
    serviceUsenet('deepbrid', 'deepbrid', filename),
    serviceUsenet('native', 'aiostreams', filename),
  ];
  for (const stream of streams) {
    stream.size = 8_000_000_000;
    stream.parsedFile = {
      title: 'Show',
      seasons: [1],
      episodes: [1],
      resolution: '1080p',
    } as ParsedStream['parsedFile'];
  }

  const result = await deduplicator(
    {
      enabled: true,
      cached: 'single_result',
      keys: ['smartDetect'],
    },
    [
      { id: 'torbox', enabled: true, credentials: {} },
      { id: 'deepbrid', enabled: true, credentials: {} },
      { id: 'aiostreams', enabled: true, credentials: {} },
    ]
  ).deduplicate(streams);

  assert.deepEqual(result.map((stream) => stream.id).sort(), [
    'native',
    'torbox',
  ]);
});
