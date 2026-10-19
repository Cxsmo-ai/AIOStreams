import assert from 'node:assert/strict';
import test from 'node:test';
import type { Addon, Stream, UserData } from '../db/index.js';
import { constants } from '../utils/index.js';
import StreamSorter from '../streams/sorter.js';
import {
  applyForcedServiceEntries,
  applyMigrations,
  hasAllRequiredServiceCredentialsForced,
} from '../utils/config.js';
import {
  buildTorrentClawHeaders,
  createTorrentClawApiStreams,
  getTorrentClawServiceWrapEntries,
  getTorrentClawServiceConfig,
  isTorrentClawP2PDisabledManifest,
  isTrustedTorrentClawUrl,
  isUnsafeTorrentClawStream,
  matchTorrentClawTorrent,
  type TorrentClawApiTorrent,
} from './torrentclaw-api.js';
import {
  collectAllTorrentClawSearchPages,
  TORRENTCLAW_SUPPORTED_SERVICES,
  mergeTorrentClawStreams,
  TorrentClawStreamParser,
} from './torrentclaw.js';

const addon = {
  name: 'TorrentClaw',
  instanceId: 'torrentclaw-test',
  manifestUrl: 'https://torrentclaw.com/api/stremio/manifest.json',
  enabled: true,
  timeout: 10_000,
  preset: {
    id: '',
    type: 'torrentclaw',
    options: { formatting: {} },
  },
} as Addon;

const enrichedMetadata: TorrentClawApiTorrent = {
  rawTitle:
    'Inception 2010 UHD BluRay 2160p HDR10 DV HEVC DTS-HD MA 5.1 x265-E',
  quality: '2160p',
  codec: 'hevc',
  sizeBytes: '21000000000',
  seeders: 75,
  leechers: 9,
  source: 'torrentio:1337x',
  sourceType: 'torrent',
  qualityScore: 88,
  languages: ['en', 'fr'],
  audioCodec: 'dts-hd',
  audioChannels: 6,
  subtitleLanguages: ['en', 'es-419'],
  videoInfo: { codec: 'hevc', height: 2160, hdr: 'HDR10 DV' },
  scanStatus: 'success',
  threatLevel: 'clean',
  hdrType: 'HDR10 DV',
  releaseGroup: 'E',
  isProper: true,
  isRepack: true,
  isRemastered: true,
};

function enrichedStream(): Stream {
  return {
    infoHash: '0123456789abcdef0123456789abcdef01234567',
    name: 'TorrentClaw 2160p',
    title: '🟢 88/100 · 👤 75\n✅ TrueSpec Verified',
    behaviorHints: {
      filename: enrichedMetadata.rawTitle!,
      videoSize: 21_000_000_000,
      tcMetadata: enrichedMetadata,
    },
  } as Stream;
}

test('additive ID remapping preserves existing streams and appends new unique sources', () => {
  const original = [
    { infoHash: 'original-hash', name: 'Existing provider' },
  ] as Stream[];
  const merged = mergeTorrentClawStreams(original, [
    [
      { infoHash: 'original-hash', name: 'Duplicate provider result' },
      { infoHash: 'additional-hash', name: 'TorrentClaw alternate ID' },
    ] as Stream[],
  ]);

  assert.equal(merged[0], original[0]);
  assert.deepEqual(merged.slice(1), [
    { infoHash: 'additional-hash', name: 'TorrentClaw alternate ID' },
  ]);
});

test('TorrentClaw ID discovery consumes every API page instead of capping results', async () => {
  const requestedPages: number[] = [];
  const results = await collectAllTorrentClawSearchPages(
    { total: 9, pageSize: 5, results: [1, 2, 3, 4, 5] },
    async (page) => {
      requestedPages.push(page);
      return { total: 9, pageSize: 5, results: [6, 7, 8, 9] };
    }
  );

  assert.deepEqual(requestedPages, [2]);
  assert.deepEqual(results, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('retries a failed page without discarding successful pages', async () => {
  const attempts = new Map<number, number>();
  const results = await collectAllTorrentClawSearchPages(
    { total: 20, pageSize: 5, results: [1, 2, 3, 4, 5] },
    async (page) => {
      const attempt = (attempts.get(page) || 0) + 1;
      attempts.set(page, attempt);
      if (page === 2 && attempt === 1) throw new Error('temporary failure');
      if (page === 3) throw new Error('page unavailable');
      return { total: 20, pageSize: 5, results: [page * 5] };
    }
  );

  assert.equal(attempts.get(2), 2);
  assert.equal(attempts.get(3), 2);
  assert.deepEqual(results, [1, 2, 3, 4, 5, 10, 20]);
});

test('follows TorrentClaw through its documented final page', async () => {
  const requestedPages: number[] = [];
  const results = await collectAllTorrentClawSearchPages(
    { total: 50_001, pageSize: 50, results: [1] },
    async (page) => {
      requestedPages.push(page);
      return { total: 50_001, pageSize: 50, results: [page] };
    }
  );

  assert.equal(requestedPages.length, 999);
  assert.equal(Math.max(...requestedPages), 1_000);
  assert.equal(results.length, 1_000);
});

test('matches API enrichment by unique score and live seeder pair', () => {
  const stream = {
    title: '🟢 88/100 · 👤 75',
    behaviorHints: { filename: 'Short display filename' },
  } as Stream;
  const match = matchTorrentClawTorrent(stream, [
    enrichedMetadata,
    { ...enrichedMetadata, rawTitle: 'Other', seeders: 74 },
  ]);
  assert.equal(match?.rawTitle, enrichedMetadata.rawTitle);
});

test('refuses ambiguous enrichment instead of attaching wrong metadata', () => {
  const stream = { title: '🟢 88/100 · 👤 75' } as Stream;
  assert.equal(
    matchTorrentClawTorrent(stream, [
      enrichedMetadata,
      { ...enrichedMetadata, rawTitle: 'Different release' },
    ]),
    undefined
  );
});

test('turns only authenticated, valid TorrentClaw hashes into P2P candidates', () => {
  const torrent = {
    ...enrichedMetadata,
    infoHash: '0123456789abcdef0123456789abcdef01234567',
  };
  const streams = createTorrentClawApiStreams([
    torrent,
    { ...torrent, infoHash: 'not-a-hash' },
    { ...torrent, infoHash: null },
  ]);

  assert.equal(streams.length, 1);
  assert.equal(streams[0].infoHash, torrent.infoHash);
  assert.match(streams[0].name || '', /^TorrentClaw 2160p$/);
  assert.equal(streams[0].behaviorHints?.filename, torrent.rawTitle);
  assert.equal(streams[0].behaviorHints?.videoSize, 21_000_000_000);
  assert.equal(
    (streams[0].behaviorHints as Record<string, unknown>).tcMetadata,
    torrent
  );
});

test('converts every valid TorrentClaw candidate without a local source-count cap', () => {
  const torrents = Array.from({ length: 75 }, (_, index) => ({
    ...enrichedMetadata,
    infoHash: index.toString(16).padStart(40, '0'),
    rawTitle: `Release ${index}`,
  }));

  assert.equal(createTorrentClawApiStreams(torrents).length, torrents.length);
});

test('does not duplicate API torrent candidates already returned by the add-on', () => {
  const torrent = {
    ...enrichedMetadata,
    infoHash: '0123456789abcdef0123456789abcdef01234567',
  };
  assert.deepEqual(
    createTorrentClawApiStreams(
      [torrent],
      [{ infoHash: torrent.infoHash } as Stream]
    ),
    []
  );
});

test('preserves season packs even when coverage does not include the requested episode', () => {
  const partialPack: TorrentClawApiTorrent = {
    ...enrichedMetadata,
    season: 2,
    episode: null,
    packEpisodes: [1, 2, 3, 4],
    infoHash: '0123456789abcdef0123456789abcdef01234567',
  };

  const [stream] = createTorrentClawApiStreams([partialPack]);
  assert.ok(stream);
  assert.equal(stream.infoHash, partialPack.infoHash);
  assert.deepEqual(
    (stream.behaviorHints as Record<string, unknown>).tcMetadata,
    partialPack
  );
});

test('parses TorrentClaw TrueSpec, safety, provenance, and peers natively', () => {
  const parsed = new TorrentClawStreamParser(addon).parse(enrichedStream());
  assert.ok(!('skip' in parsed));
  if ('skip' in parsed) return;
  assert.equal(parsed.torrent?.seeders, 75);
  assert.equal(parsed.indexer, 'TorrentClaw · torrentio / 1337x');
  assert.equal(parsed.parsedFile?.resolution, '2160p');
  assert.equal(parsed.parsedFile?.encode, 'HEVC');
  assert.ok(parsed.parsedFile?.visualTags.includes('HDR10'));
  assert.ok(parsed.parsedFile?.visualTags.includes('DV'));
  assert.ok(parsed.parsedFile?.audioTags.includes('DTS-HD'));
  assert.ok(parsed.parsedFile?.audioChannels.includes('5.1'));
  assert.ok(parsed.parsedFile?.languages.includes('English'));
  assert.ok(parsed.parsedFile?.subtitles?.includes('Spanish (Latin America)'));
  assert.equal(parsed.parsedFile?.proper, true);
  assert.equal(parsed.parsedFile?.repack, true);
  assert.ok(parsed.parsedFile?.editions?.includes('Remastered'));
  assert.equal(parsed.extra?.torrentClaw?.safe, true);
  assert.equal(parsed.extra?.torrentClaw?.source, 'torrentio:1337x');
});

test('uses TorrentClaw structured byte size when the stream omits a size hint', () => {
  const stream = enrichedStream();
  const { videoSize: _videoSize, ...behaviorHints } =
    stream.behaviorHints || {};
  const parsed = new TorrentClawStreamParser(addon).parse({
    ...stream,
    title: 'A release with no displayed size',
    behaviorHints,
  } as Stream);

  assert.ok(!('skip' in parsed));
  if (!('skip' in parsed)) assert.equal(parsed.size, 21_000_000_000);
});

test('sorts TorrentClaw releases by their structured sizes when size is primary', async () => {
  const parseWithoutSizeHint = (sizeBytes: string, hash: string) => {
    const source = enrichedStream();
    const { videoSize: _videoSize, ...behaviorHints } =
      source.behaviorHints || {};
    const parsed = new TorrentClawStreamParser(addon).parse({
      ...source,
      infoHash: hash,
      title: 'TorrentClaw release',
      behaviorHints: {
        ...behaviorHints,
        tcMetadata: { ...enrichedMetadata, sizeBytes },
      },
    } as Stream);
    assert.ok(!('skip' in parsed));
    if ('skip' in parsed) throw new Error('TorrentClaw stream was skipped');
    return parsed;
  };
  const sorter = new StreamSorter({
    sortCriteria: {
      global: [{ key: 'size', direction: 'desc' }],
      cached: [],
      uncached: [],
    },
    presets: [],
  } as unknown as UserData);

  const sorted = await sorter.sort(
    [
      parseWithoutSizeHint('700000000', 'small-release'),
      parseWithoutSizeHint('4200000000', 'large-release'),
    ],
    { type: 'movie', isAnime: false } as any
  );

  assert.deepEqual(
    sorted.map((stream) => stream.size),
    [4_200_000_000, 700_000_000]
  );
});

test('orders TorrentClaw by preferred resolution, then size descending', async () => {
  const parse = (resolution: '2160p' | '1080p', size: number, hash: string) => {
    const height = resolution === '2160p' ? 2160 : 1080;
    const source = {
      ...enrichedStream(),
      infoHash: hash,
      title: `A release ${resolution}`,
      description: '',
      behaviorHints: {
        filename: `A release ${resolution}`,
        videoSize: size,
        tcMetadata: {
          ...enrichedMetadata,
          quality: resolution,
          sizeBytes: size,
          videoInfo: { height },
        },
      },
    } as Stream;
    assert.equal(
      (source.behaviorHints?.tcMetadata as TorrentClawApiTorrent).videoInfo
        ?.height,
      height
    );
    const parser = new TorrentClawStreamParser(addon);
    const parsed = parser.parse(source);
    assert.ok(!('skip' in parsed));
    if ('skip' in parsed) throw new Error('TorrentClaw stream was skipped');
    assert.equal(parsed.parsedFile?.resolution, resolution);
    return parsed;
  };
  const sorter = new StreamSorter({
    preferredResolutions: ['2160p', '1080p'],
    sortCriteria: {
      global: [
        { key: 'resolution', direction: 'desc' },
        { key: 'size', direction: 'asc' },
      ],
      cached: [],
      uncached: [],
    },
    presets: [],
  } as unknown as UserData);

  const sorted = await sorter.sort(
    [
      parse('2160p', 2_000_000_000, '2160-small'),
      parse('1080p', 9_000_000_000, '1080-large'),
      parse('2160p', 8_000_000_000, '2160-large'),
    ],
    { type: 'series', isAnime: false } as any
  );

  assert.deepEqual(
    sorted.map((stream) => [stream.parsedFile?.resolution, stream.size]),
    [
      ['2160p', 8_000_000_000],
      ['2160p', 2_000_000_000],
      ['1080p', 9_000_000_000],
    ]
  );
});

test('keeps API pack coverage available as descriptive metadata', () => {
  const coverage = [1, 2, 3, 4];
  const seasons = [{ season: 2, episodeCount: 23, posterUrl: null }];
  const stream = {
    ...enrichedStream(),
    behaviorHints: {
      ...enrichedStream().behaviorHints,
      tcMetadata: { ...enrichedMetadata, packEpisodes: coverage, seasons },
    },
  } as Stream;

  const parsed = new TorrentClawStreamParser(addon).parse(stream);
  assert.ok(!('skip' in parsed));
  if ('skip' in parsed) return;
  assert.deepEqual(parsed.extra?.torrentClaw?.packEpisodes, coverage);
  assert.deepEqual(parsed.extra?.torrentClaw?.seasons, seasons);
});

test('advertises every native torrent-capable provider and maps TorrentClaw source badges', () => {
  const supported = TORRENTCLAW_SUPPORTED_SERVICES;
  const expected = [
    constants.DEBRIDLINK_SERVICE,
    constants.EASYDEBRID_SERVICE,
    constants.DEBRIDER_SERVICE,
    constants.OFFCLOUD_SERVICE,
    constants.PIKPAK_SERVICE,
    constants.TORRIN_SERVICE,
    constants.DEEPBRID_SERVICE,
  ];
  for (const serviceId of expected) assert.ok(supported.includes(serviceId));

  for (const [source, serviceId] of [
    ['DebridLink', constants.DEBRIDLINK_SERVICE],
    ['EasyDebrid', constants.EASYDEBRID_SERVICE],
    ['Debrider', constants.DEBRIDER_SERVICE],
    ['Offcloud', constants.OFFCLOUD_SERVICE],
    ['PikPak', constants.PIKPAK_SERVICE],
    ['Torrin', constants.TORRIN_SERVICE],
    ['Deepbrid DB', constants.DEEPBRID_SERVICE],
  ] as const) {
    const stream = {
      ...enrichedStream(),
      behaviorHints: {
        ...enrichedStream().behaviorHints,
        tcSource: source,
      },
    } as Stream;
    const parsed = new TorrentClawStreamParser(addon).parse(stream);
    assert.ok(!('skip' in parsed));
    if (!('skip' in parsed))
      assert.equal(parsed.service?.id, serviceId, source);
  }
});

test('only explicit unsafe statuses are treated as unsafe', () => {
  const stream = enrichedStream();
  assert.equal(isUnsafeTorrentClawStream(stream), false);
  const unsafe = {
    ...stream,
    behaviorHints: {
      ...stream.behaviorHints,
      tcMetadata: { ...enrichedMetadata, threatLevel: 'malicious' },
    },
  } as Stream;
  assert.equal(isUnsafeTorrentClawStream(unsafe), true);
  const unknown = {
    ...unsafe,
    behaviorHints: {
      ...unsafe.behaviorHints,
      tcMetadata: { ...enrichedMetadata, threatLevel: 'unknown' },
    },
  } as Stream;
  assert.equal(isUnsafeTorrentClawStream(unknown), false);
});

test('reads one shared TorrentClaw service credential', () => {
  const userData = {
    services: [
      {
        id: constants.TORRENTCLAW_SERVICE,
        enabled: true,
        credentials: {
          apiKey: 'tc_test-key',
          unarrUrl: 'https://unarr.app',
        },
      },
    ],
  } as UserData;
  assert.deepEqual(getTorrentClawServiceConfig(userData), {
    apiKey: 'tc_test-key',
    unarrUrl: 'https://unarr.app',
  });
});

test('preserves only TorrentClaw credentials in its internal service-wrap addon', () => {
  const torrentClawService = {
    id: constants.TORRENTCLAW_SERVICE,
    enabled: true,
    credentials: { apiKey: 'private-test-key' },
  };
  const debridService = {
    id: constants.TORBOX_SERVICE,
    enabled: true,
    credentials: { apiKey: 'private-test-debrid-key' },
  };
  const userData = {
    services: [torrentClawService, debridService],
  } as unknown as UserData;
  const internalServices = getTorrentClawServiceWrapEntries(
    userData,
    'torrentclaw'
  );

  assert.deepEqual(internalServices, [torrentClawService]);
  assert.deepEqual(getTorrentClawServiceWrapEntries(userData, 'comet'), []);
  assert.equal(
    getTorrentClawServiceConfig({ ...userData, services: internalServices })
      ?.apiKey,
    'private-test-key'
  );
});

test('forced required keys inject missing services into legacy profiles', () => {
  const userData = { services: [] } as UserData;
  const serviceDetails = {
    [constants.TORBOX_SERVICE]: {
      credentials: [{ required: true, forced: 'encrypted-torbox-key' }],
    },
    [constants.TORRENTCLAW_SERVICE]: {
      credentials: [
        { required: true, forced: 'encrypted-torrentclaw-key' },
        { required: false, forced: null },
      ],
    },
  } as unknown as ReturnType<
    typeof import('../utils/config.js').getEnvironmentServiceDetails
  >;

  applyForcedServiceEntries(userData, serviceDetails);

  assert.deepEqual(
    userData.services?.map(({ id, enabled }) => ({ id, enabled })),
    [
      { id: constants.TORBOX_SERVICE, enabled: true },
      { id: constants.TORRENTCLAW_SERVICE, enabled: true },
    ]
  );
  assert.deepEqual(userData.services?.[0].credentials, {});
  assert.deepEqual(userData.services?.[1].credentials, {});
});

test('does not inject services without every required credential forced', () => {
  const userData = { services: [] } as UserData;
  const serviceDetails = {
    [constants.TORRENTCLAW_SERVICE]: {
      credentials: [
        { required: true, forced: null },
        { required: false, forced: 'encrypted-optional-value' },
      ],
    },
  } as unknown as ReturnType<
    typeof import('../utils/config.js').getEnvironmentServiceDetails
  >;

  applyForcedServiceEntries(userData, serviceDetails);

  assert.deepEqual(userData.services, []);
  assert.equal(
    hasAllRequiredServiceCredentialsForced([
      { required: true, forced: 'encrypted-api-key' },
      { required: false, forced: null },
    ]),
    true
  );
  assert.equal(
    hasAllRequiredServiceCredentialsForced([
      { required: true, forced: null },
      { required: false, forced: 'encrypted-optional-value' },
    ]),
    false
  );
});

test('migrates legacy Unarr credentials into the TorrentClaw service', () => {
  const migrated = applyMigrations({
    presets: [
      {
        type: 'unarr-indexer',
        instanceId: 'unarr-test',
        enabled: true,
        options: {
          unarrAuth: {
            apiKey: 'tc_legacy-test-key',
            apiUrl: 'https://unarr.app',
          },
          maxResults: 30,
        },
      },
    ],
    services: [],
  });
  const service = migrated.services?.find(
    (candidate) => candidate.id === constants.TORRENTCLAW_SERVICE
  );
  assert.equal(service?.credentials.apiKey, 'tc_legacy-test-key');
  assert.equal(service?.credentials.unarrUrl, 'https://unarr.app');
  const options = migrated.presets?.[0]?.options || {};
  assert.equal('unarrAuth' in options, false);
  assert.equal('apiKey' in options, false);
  assert.equal('apiUrl' in options, false);
});

test('sends service auth only to trusted TorrentClaw HTTPS manifests', () => {
  const official = buildTorrentClawHeaders({
    manifestUrl: 'https://torrentclaw.com/api/stremio/manifest.json',
    userAgent: 'test',
    apiKey: 'tc_test-key',
  });
  assert.equal(official.Authorization, 'Bearer tc_test-key');
  const custom = buildTorrentClawHeaders({
    manifestUrl: 'https://example.test/torrentclaw/manifest.json',
    userAgent: 'test',
    apiKey: 'tc_test-key',
  });
  assert.equal(custom.Authorization, undefined);
  assert.equal(isTrustedTorrentClawUrl('https://torrentclaw.com/api'), true);
  assert.equal(isTrustedTorrentClawUrl('http://torrentclaw.com/api'), false);
  assert.equal(
    isTrustedTorrentClawUrl('https://torrentclaw.com.evil.test'),
    false
  );
});

test('respects account-linked TorrentClaw manifests that explicitly disable P2P', () => {
  assert.equal(
    isTorrentClawP2PDisabledManifest(
      'https://addon.torrentclaw.com/api/stremio/d/token/eyJub1AyUCI6dHJ1ZSwibm9VbmFyciI6dHJ1ZX0/manifest.json'
    ),
    true
  );
  assert.equal(
    isTorrentClawP2PDisabledManifest(
      'https://torrentclaw.com/api/stremio/manifest.json'
    ),
    false
  );
  assert.equal(
    isTorrentClawP2PDisabledManifest(
      'https://example.test/eyJub1AyUCI6dHJ1ZX0/manifest.json'
    ),
    false
  );
});
