import assert from 'node:assert/strict';
import test from 'node:test';
import {
  constants,
  type Meta,
  type TorrentClawSeason,
  type UserData,
} from '@aiostreams/core';
import {
  enrichEnhancedCinemetaMeta,
  filterEnhancedCinemetaResources,
  mergeTorrentClawEpisodeMetadata,
} from './enhancedCinemetaMetadata.js';

test('enhanced Cinemeta keeps all standard resources and drops unsupported ones', () => {
  const catalogResource = { name: 'catalog', types: ['movie', 'series'] };
  const metaResource = { name: 'meta', types: ['movie', 'series'] };
  const addonCatalogResource = {
    name: 'addon_catalog',
    types: ['movie', 'series'],
  };

  assert.deepEqual(
    filterEnhancedCinemetaResources([
      catalogResource,
      metaResource,
      addonCatalogResource,
      { name: 'stream', types: ['movie'] },
    ]),
    [catalogResource, metaResource, addonCatalogResource]
  );
});

test('enhanced metadata fills missing episode fields without replacing Cinemeta data', () => {
  const cinemeta = {
    id: 'tt1196946',
    type: 'series',
    name: 'The Mentalist',
    videos: [
      {
        id: 'tt1196946:2:1',
        season: 2,
        episode: 1,
        title: 'Cinemeta title',
        overview: null,
        thumbnail: null,
      },
      { id: 'tt1196946:2:2', season: 2, episode: 2, title: null },
    ],
  } as Meta;
  const torrentClaw: TorrentClawSeason[] = [
    {
      season: 2,
      episodeCount: 23,
      posterUrl: 'https://images.example/season2.jpg',
      episodes: [
        {
          episode: 1,
          name: 'Alternate title',
          overview: 'Episode summary',
          stillUrl: 'https://images.example/episode1.jpg',
          airDate: '2009-10-01',
          runtime: 43,
          voteAverage: 7.9,
        },
      ],
    },
  ];

  const result = mergeTorrentClawEpisodeMetadata(cinemeta, torrentClaw);
  assert.equal(result.id, cinemeta.id);
  assert.equal(result.videos?.[0]?.title, 'Cinemeta title');
  assert.equal(result.videos?.[0]?.overview, 'Episode summary');
  assert.equal(
    result.videos?.[0]?.thumbnail,
    'https://images.example/episode1.jpg'
  );
  assert.equal(result.videos?.[0]?.released, '2009-10-01');
  assert.equal(result.videos?.[1]?.title, null);
  assert.deepEqual((result as Record<string, unknown>).seasons, [
    {
      season: 2,
      episodeCount: 23,
      posterUrl: 'https://images.example/season2.jpg',
    },
  ]);
});

test('enhanced metadata leaves the Cinemeta response unchanged when TorrentClaw has no season data', () => {
  const cinemeta = { id: 'tt1196946', type: 'series', videos: [] } as Meta;
  assert.equal(mergeTorrentClawEpisodeMetadata(cinemeta, undefined), cinemeta);
});

test('Enhanced Cinemeta forwards the enabled profile TorrentClaw Pro key', async () => {
  const meta = { id: 'tt1196946', type: 'series', videos: [] } as Meta;
  const userData = {
    services: [
      {
        id: constants.TORRENTCLAW_SERVICE,
        enabled: true,
        credentials: { apiKey: 'tc-test-pro-key' },
      },
    ],
  } as unknown as UserData;
  let request: { id: string; apiKey: string; timeout?: number } | undefined;

  const result = await enrichEnhancedCinemetaMeta(
    meta,
    'series',
    'tt1196946',
    userData,
    async (options) => {
      request = options;
      return [{ season: 1, episodeCount: 23 }];
    }
  );

  assert.deepEqual(request, {
    id: 'tt1196946',
    apiKey: 'tc-test-pro-key',
    timeout: 2_500,
  });
  assert.equal(
    (result as Record<string, unknown>).seasons instanceof Array,
    true
  );
});

test('Enhanced Cinemeta skips disabled TorrentClaw auth and preserves Cinemeta metadata', async () => {
  const meta = { id: 'tt1196946', type: 'series', videos: [] } as Meta;
  const userData = {
    services: [
      {
        id: constants.TORRENTCLAW_SERVICE,
        enabled: false,
        credentials: { apiKey: 'tc-disabled-key' },
      },
    ],
  } as unknown as UserData;
  let called = false;

  const result = await enrichEnhancedCinemetaMeta(
    meta,
    'series',
    'tt1196946',
    userData,
    async () => {
      called = true;
      return [];
    }
  );

  assert.equal(called, false);
  assert.equal(result, meta);
});

test('Enhanced Cinemeta falls back to upstream metadata if TorrentClaw enrichment throws', async () => {
  const meta = { id: 'tt1196946', type: 'series', videos: [] } as Meta;
  const userData = {
    services: [
      {
        id: constants.TORRENTCLAW_SERVICE,
        enabled: true,
        credentials: { apiKey: 'tc-test-pro-key' },
      },
    ],
  } as unknown as UserData;

  const result = await enrichEnhancedCinemetaMeta(
    meta,
    'series',
    'tt1196946',
    userData,
    async () => {
      throw new Error('simulated TorrentClaw authorization failure');
    }
  );

  assert.equal(result, meta);
});
