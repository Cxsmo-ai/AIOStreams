import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDeepbridQueries,
  classifyDeepbridArchiveIntegrity,
  chooseDeepbridVideoFiles,
  DeepbridProgressiveResolutionQueue,
  createDeepbridPlaybackToken,
  decodeDeepbridPlaybackToken,
  DeepbridUsenetConfigSchema,
  classifyDeepbridResolutionFailure,
  deepbridCoverageStatus,
  DeepbridResolutionIncompleteError,
  filterDeepbridProbeResults,
  prioritizeDeepbridSeasonPacks,
  resolveDeepbridFiles,
  requireDeepbridApiKey,
  runQueuedDeepbridRequest,
  runWithinDeepbridRequestBudget,
  searchDeepbridFinderPages,
  scoreDeepbridSpec,
  summarizeDeepbridPagination,
} from './addon.js';
import {
  ValidatedFinderResolutionQueue,
  ValidatedProgressiveStreamCollector,
} from './merge-progressive.js';
import {
  deepbridPlayerEndpoint,
  deepbridPlaybackModes,
  createDeepbridSubtitleConversionToken,
  decodeDeepbridSubtitleConversionToken,
  type DeepbridPlaybackPayload,
} from './playback.js';
import type { DeepbridFinderPaginationOutcome } from './addon.js';
import {
  DeepbridApiError,
  DeepbridRequestSigner,
  assessDeepbridArchiveVolumes,
  isDeepbridArchiveName,
  isDeepbridStorageHost,
  isTrustedDeepbridDownloadHost,
  isDeepbridVideoName,
  isLikelyDeepbridVideoName,
  classifyDeepbridUploadFile,
  validateDeepbridDownloadUrl,
} from './client.js';
import {
  DEEPBRID_USENET_FORMATTING_OPTION,
  deepbridUsenetServiceIds,
  DeepbridUsenetStreamParser,
  deepbridUsenetFormatPassthrough,
} from '../../presets/deepbridUsenet.js';
import type { Addon, ParsedStream, Stream } from '../../db/index.js';
import type { DeepbridFinderClient, DeepbridFinderResult } from './client.js';
import {
  DEEPBRID_PROGRESSIVE_OUTER_TIMEOUT_MARGIN_MS,
  DEEPBRID_PROGRESSIVE_RESOLUTION_TIMEOUT_MS,
  deepbridProgressiveOuterTimeout,
  deepbridResolutionTimeout,
} from '../../utils/deepbrid-progressive-timeout.js';

const fixtureCredential = 'unit-test-placeholder-value';

test('extends only progressive Finder resolution and keeps a bounded caller margin', () => {
  assert.equal(deepbridResolutionTimeout(30_000, false), 30_000);
  assert.equal(
    deepbridResolutionTimeout(30_000, true),
    DEEPBRID_PROGRESSIVE_RESOLUTION_TIMEOUT_MS
  );
  assert.equal(deepbridResolutionTimeout(180_000, true), 3_600_000);
  assert.equal(deepbridResolutionTimeout(700_000, true), 3_600_000);
  assert.equal(deepbridProgressiveOuterTimeout(50_000), 3_660_000);
  assert.equal(deepbridProgressiveOuterTimeout(750_000), 3_660_000);
  assert.equal(deepbridProgressiveOuterTimeout(4_500_000), 4_560_000);
});

test('all Deepbrid Finder modes classify failed queries, pagination, resolution, and aborts as partial', () => {
  for (const mode of ['direct', 'both', 'indexer']) {
    assert.equal(deepbridCoverageStatus({}), 'complete', `${mode}: complete`);
    assert.equal(
      deepbridCoverageStatus({ failedSearches: 1 }),
      'partial',
      `${mode}: failed query`
    );
    assert.equal(
      deepbridCoverageStatus({ incompleteQueries: 1 }),
      'partial',
      `${mode}: incomplete paging`
    );
    assert.equal(
      deepbridCoverageStatus({ resolutionFailures: 1 }),
      'partial',
      `${mode}: resolution failure`
    );
    assert.equal(
      deepbridCoverageStatus({ aborted: true }),
      'partial',
      `${mode}: aborted`
    );
  }
});

class TestDeepbridParser extends DeepbridUsenetStreamParser {
  indexer() {
    return this.getIndexer();
  }

  indexerFor(stream: Stream, parsed: ParsedStream) {
    return this.getIndexer(stream, parsed);
  }

  service(stream: Stream, parsed: ParsedStream) {
    return this.getService(stream, parsed);
  }

  filename(stream: Stream, parsed: ParsedStream) {
    return this.getFilename(stream, parsed);
  }

  size(stream: Stream, parsed: ParsedStream) {
    return this.getSize(stream, parsed);
  }

  extras(stream: Stream, parsed: ParsedStream) {
    return this.getExtras(stream, parsed);
  }

  streamType(stream: Stream, parsed: ParsedStream) {
    return this.getStreamType(stream, undefined, parsed);
  }
}

test('Deepbrid addon requires the global service credential', () => {
  assert.throws(
    () => requireDeepbridApiKey({ services: [] }),
    /Services > Deepbrid/
  );
  assert.equal(
    requireDeepbridApiKey({ services: [], apiKey: 'x'.repeat(32) }),
    'x'.repeat(32)
  );
});

test('Deepbrid mode accepts direct, indexer, and combined operation', () => {
  const base = { services: [], apiKey: 'x'.repeat(32) };
  assert.equal(DeepbridUsenetConfigSchema.parse(base).mode, 'direct');
  for (const mode of ['direct', 'indexer', 'both'] as const) {
    assert.equal(
      DeepbridUsenetConfigSchema.parse({ ...base, mode }).mode,
      mode
    );
  }
  assert.throws(() =>
    DeepbridUsenetConfigSchema.parse({ ...base, mode: 'direct-and-indexer' })
  );
});

test('legacy Deepbrid configs get a bounded progressive concurrency default', () => {
  const base = DeepbridUsenetConfigSchema.parse({
    services: [],
    apiKey: 'x'.repeat(32),
  });
  assert.equal(base.resolveConcurrency, 5);
  assert.equal(base.progressiveResolveConcurrency, 10);
  assert.equal(
    DeepbridUsenetConfigSchema.parse({
      services: [],
      apiKey: 'x'.repeat(32),
      progressiveResolveConcurrency: 3,
    }).progressiveResolveConcurrency,
    3
  );
});

test('Deepbrid player delivery stays independent from Finder routing', () => {
  const base = { services: [], apiKey: 'x'.repeat(32) };
  assert.equal(DeepbridUsenetConfigSchema.parse(base).mode, 'direct');
  assert.equal(DeepbridUsenetConfigSchema.parse(base).playbackMode, 'direct');
  for (const playbackMode of ['direct', 'remux', 'hls', 'all'] as const) {
    assert.equal(
      DeepbridUsenetConfigSchema.parse({ ...base, playbackMode }).playbackMode,
      playbackMode
    );
  }
  assert.throws(() =>
    DeepbridUsenetConfigSchema.parse({ ...base, playbackMode: 'indexer' })
  );
});

test('Deepbrid player delivery modes provide Direct, Remux, and HLS choices', () => {
  assert.deepEqual(deepbridPlaybackModes(undefined), ['direct']);
  assert.deepEqual(deepbridPlaybackModes('direct'), ['direct']);
  assert.deepEqual(deepbridPlaybackModes('remux'), ['remux']);
  assert.deepEqual(deepbridPlaybackModes('hls'), ['hls']);
  assert.deepEqual(deepbridPlaybackModes('all'), ['direct', 'remux', 'hls']);
});

test('Deepbrid player endpoints preserve source URL and mode parameters', () => {
  const base: DeepbridPlaybackPayload = {
    apiKey: 'x'.repeat(32),
    url: 'https://usenet-2.myfast.link/media/example.mkv?sig=opaque',
    filename: 'example.mkv',
  };
  assert.equal(deepbridPlayerEndpoint(base).toString(), base.url);
  const remux = deepbridPlayerEndpoint({ ...base, mode: 'remux' });
  assert.equal(remux.pathname, '/cast_remux');
  assert.equal(remux.searchParams.get('url'), base.url);
  assert.equal(remux.searchParams.get('audio'), '0');
  assert.equal(remux.searchParams.get('start'), '0');
  const hls = deepbridPlayerEndpoint({ ...base, mode: 'hls' });
  assert.equal(hls.pathname, '/cast_hls');
  assert.equal(hls.searchParams.get('url'), base.url);
  assert.equal(hls.searchParams.get('audio'), '0');
  assert.equal(hls.searchParams.get('t'), '0');
});

test('Deepbrid player subtitle capability encrypts credentials and round-trips source URL', () => {
  const payload = {
    apiKey: fixtureCredential,
    subtitleUrl: 'https://subtitles.example/captions.ass?download=1',
  };
  const token = createDeepbridSubtitleConversionToken(payload);
  assert.equal(token.includes(payload.apiKey), false);
  assert.equal(token.includes(payload.subtitleUrl), false);
  assert.deepEqual(decodeDeepbridSubtitleConversionToken(token), payload);
});

test('Deepbrid player subtitle capability rejects unsafe source URLs', () => {
  for (const subtitleUrl of [
    'http://subtitles.example/captions.ass',
    'https://user:password@subtitles.example/captions.ass',
    'https://127.0.0.1/private.ass',
  ]) {
    assert.throws(() =>
      createDeepbridSubtitleConversionToken({
        apiKey: fixtureCredential,
        subtitleUrl,
      })
    );
  }
});

test('a transient Finder playback probe failure does not discard sibling results', async () => {
  const candidates = [
    { id: 'rate-limited' },
    { id: 'verified' },
    { id: 'invalid-media' },
  ];

  const result = await filterDeepbridProbeResults(candidates, {
    concurrency: 3,
    probe: async (candidate) => {
      if (candidate.id === 'rate-limited') {
        throw new Error('temporary probe failure');
      }
      return candidate.id === 'verified';
    },
  });

  assert.deepEqual(result.playable, [{ id: 'verified' }]);
  assert.equal(result.errors, 1);
  assert.equal(result.rejected, 1);
  assert.equal(result.aborted, 0);
});

test('aborting Finder playback probes does not report unverified files as playable', async () => {
  const controller = new AbortController();
  const result = await filterDeepbridProbeResults(
    [{ id: 'abort' }, { id: 'not-started' }],
    {
      concurrency: 1,
      signal: controller.signal,
      probe: async () => {
        controller.abort();
        throw new DOMException('request aborted', 'AbortError');
      },
    }
  );

  assert.deepEqual(result.playable, []);
  assert.equal(result.errors, 0);
  assert.equal(result.rejected, 0);
  assert.equal(result.aborted, 2);
});

test('combined Finder mode excludes Deepbrid itself from its external service fan-out', () => {
  const selected = deepbridUsenetServiceIds(
    [
      { id: 'deepbrid', enabled: true },
      { id: 'torbox', enabled: true },
      { id: 'stremio_nntp', enabled: true },
      { id: 'altmount', enabled: false },
    ],
    false
  );
  assert.deepEqual(selected, ['torbox', 'stremio_nntp']);
  assert.deepEqual(
    deepbridUsenetServiceIds([{ id: 'deepbrid', enabled: true }], true),
    ['deepbrid']
  );
});

test('signs Finder paths with deterministic timestamp and nonce headers', () => {
  const signer = new DeepbridRequestSigner({
    now: () => 1_750_000_000_000,
    random: () => 'abcdefgh',
    secret: '0123456789abcdef'.repeat(4),
  });
  assert.deepEqual(
    signer.sign(
      'GET',
      '/usenet/finder/search?q=The+Mentalist+S01E04&offset=0&limit=50'
    ),
    {
      'X-DB-Ts': '1750000000',
      'X-DB-Nonce': 'sxwkn40abcdefgh',
      'X-DB-Sig':
        '3684c92634f4e61e2432d0bc9d85a63ebfc52ffacae6aef62351ff65a225a7c3',
    }
  );
});

test('corrects Finder signatures using the server Date header', () => {
  const signer = new DeepbridRequestSigner({
    now: () => 1_750_000_000_000,
    random: () => 'abcdefgh',
    secret: '0123456789abcdef'.repeat(4),
  });
  assert.equal(
    signer.noteServerDate(new Date(1_750_000_012_000).toUTCString()),
    true
  );
  assert.equal(signer.sign('GET', '/test')['X-DB-Ts'], '1750000012');
});

const parserAddon: Addon = {
  name: 'Deepbrid Usenet',
  manifestUrl: 'https://example.com/manifest.json',
  enabled: true,
  timeout: 30_000,
  preset: { id: '', type: 'deepbrid-usenet', options: {} },
};

test('accepts HTTPS download hosts without embedded credentials', () => {
  assert.equal(
    validateDeepbridDownloadUrl('https://cdn.deepbrid.com/file.mkv').hostname,
    'cdn.deepbrid.com'
  );
  assert.throws(() =>
    validateDeepbridDownloadUrl('http://www.deepbrid.com/file.mkv')
  );
  assert.equal(
    validateDeepbridDownloadUrl('https://storage.example/file.mkv').hostname,
    'storage.example'
  );
  assert.throws(() =>
    validateDeepbridDownloadUrl('https://user:pass@storage.example/file.mkv')
  );
});

test('trusts only Deepbrid API and recovered Finder storage hosts', () => {
  assert.equal(isDeepbridStorageHost('usenet-2.myfast.link'), true);
  assert.equal(isTrustedDeepbridDownloadHost('www.deepbrid.com'), true);
  assert.equal(isTrustedDeepbridDownloadHost('usenet-2.myfast.link'), true);
  assert.equal(isTrustedDeepbridDownloadHost('myfast.link.evil.test'), false);
  assert.equal(isTrustedDeepbridDownloadHost('storage.example'), false);
});

test('round-trips encrypted, signed playback capabilities', () => {
  const payload = {
    apiKey: fixtureCredential,
    url: 'https://www.deepbrid.com/download/video.mkv',
    filename: 'video.mkv',
    size: 1234,
  };
  const token = createDeepbridPlaybackToken(payload);
  assert.ok(!token.includes(payload.apiKey));
  assert.deepEqual(decodeDeepbridPlaybackToken(token), payload);
  assert.throws(() => decodeDeepbridPlaybackToken(`${token.slice(0, -1)}x`));
  assert.throws(() =>
    createDeepbridPlaybackToken({
      ...payload,
      url: 'https://storage.example/video.mkv',
    })
  );
});

test('recognizes archive and video names', () => {
  assert.equal(isDeepbridArchiveName('release.part01.rar'), true);
  assert.equal(isDeepbridArchiveName('release.zip.001'), true);
  assert.equal(isDeepbridArchiveName('release.mkv'), false);
  assert.equal(isDeepbridVideoName('release.MKV'), true);
  assert.equal(isDeepbridVideoName('release.nfo'), false);
  assert.equal(
    isLikelyDeepbridVideoName('Titanic.1997.2160p.UHD.Blu-ray.Remux.HEVC'),
    true
  );
  assert.equal(isLikelyDeepbridVideoName('Titanic.1997.iso'), false);
});

test('marks provider-unreachable upload files as non-playable without exposing raw reasons', () => {
  assert.deepEqual(
    classifyDeepbridUploadFile({
      name: 'Example.Show.S01E01.mkv',
      link: '',
      unreachable: 'truncated_missing_volumes',
    }),
    {
      playableCandidate: false,
      status: 'unreachable',
      reason: 'provider-unreachable',
    }
  );
  assert.deepEqual(
    classifyDeepbridUploadFile({
      name: 'Example.Show.S01E01.mkv',
      link: 'https://cdn.example/video.mkv',
    }),
    { playableCandidate: true, status: 'candidate' }
  );
  assert.equal(
    classifyDeepbridUploadFile({
      name: 'Example.Show.S01E01.mkv',
      link: 'https://cdn.example/video.mkv',
      unreachable: 'truncated_missing_volumes',
    }).playableCandidate,
    false,
    'provider-declared unreachable must win even when a stale link is present'
  );
  assert.equal(
    classifyDeepbridUploadFile({
      name: 'Example.Show.S01E01.nfo',
      link: 'https://cdn.example/video.nfo',
    }).playableCandidate,
    false
  );
});

test('selects the requested episode when an expanded season has many files', () => {
  const files = [
    {
      name: 'Show.S01E01.mkv',
      link: 'https://www.deepbrid.com/1',
      size: 1,
      sizeHuman: '',
    },
    {
      name: 'Show.S01E02.mkv',
      link: 'https://www.deepbrid.com/2',
      size: 2,
      sizeHuman: '',
    },
    {
      name: 'Show.S01E03.nfo',
      link: 'https://www.deepbrid.com/3',
      size: 3,
      sizeHuman: '',
    },
  ];
  assert.deepEqual(
    chooseDeepbridVideoFiles(files, {
      type: 'series',
      season: 1,
      episode: 2,
    }).map((file) => file.name),
    ['Show.S01E02.mkv']
  );
});

test('returns all playable videos for movies', () => {
  const files = [
    {
      name: 'Movie.mkv',
      link: 'https://www.deepbrid.com/1',
      size: 1,
      sizeHuman: '',
    },
    {
      name: 'Movie.sample.mp4',
      link: 'https://www.deepbrid.com/2',
      size: 2,
      sizeHuman: '',
    },
    {
      name: 'Movie.nfo',
      link: 'https://www.deepbrid.com/3',
      size: 3,
      sizeHuman: '',
    },
  ];
  assert.deepEqual(
    chooseDeepbridVideoFiles(files, { type: 'movie' }).map((file) => file.name),
    ['Movie.mkv']
  );
});

test('does not guess among multiple wrong episode files', () => {
  const files = [
    {
      name: 'Show.S01E03.mkv',
      link: 'https://www.deepbrid.com/1',
      size: 1,
      sizeHuman: '',
    },
    {
      name: 'Show.S01E04.mkv',
      link: 'https://www.deepbrid.com/2',
      size: 2,
      sizeHuman: '',
    },
  ];
  assert.deepEqual(
    chooseDeepbridVideoFiles(files, { type: 'series', season: 1, episode: 2 }),
    []
  );
});

test('rejects a single video that explicitly names the wrong episode', () => {
  const files = [
    {
      name: 'Tower.Prep.S01E11.720p.HDTV.mkv',
      link: 'https://usenet-2.myfast.link/11',
      size: 1,
      sizeHuman: '',
    },
  ];
  assert.deepEqual(
    chooseDeepbridVideoFiles(
      files,
      { type: 'series', season: 1, episode: 9 },
      'Tower Prep S01E09'
    ),
    []
  );
});

test('keeps a single video with no episode marker for a matched release', () => {
  const files = [
    {
      name: 'video.mkv',
      link: 'https://usenet-2.myfast.link/video',
      size: 1,
      sizeHuman: '',
    },
  ];
  assert.deepEqual(
    chooseDeepbridVideoFiles(
      files,
      { type: 'series', season: 1, episode: 9 },
      'Tower Prep S01E09'
    ),
    files
  );
});

test('selects short episode names only inside a confirmed season pack', () => {
  const files = [
    {
      name: 'Tower Prep - 01 - New Kid.mkv',
      link: 'https://usenet-2.myfast.link/1',
      size: 1,
      sizeHuman: '',
    },
    {
      name: 'Tower Prep - 02 - Monitored.mkv',
      link: 'https://usenet-2.myfast.link/2',
      size: 1,
      sizeHuman: '',
    },
  ];
  assert.deepEqual(
    chooseDeepbridVideoFiles(
      files,
      { type: 'series', season: 1, episode: 1 },
      'Tower.Prep.S01.Complete.720p.HDTV'
    ).map((file) => file.name),
    ['Tower Prep - 01 - New Kid.mkv']
  );
  assert.deepEqual(
    chooseDeepbridVideoFiles(files, {
      type: 'series',
      season: 1,
      episode: 1,
    }),
    []
  );
});

test('adds an explicit season query without dropping exact episode search', () => {
  const queries = buildDeepbridQueries(
    { title: 'Tower Prep', aliases: [] },
    { type: 'series', season: 1, episode: 1 }
  );
  assert.equal(queries[0], 'Tower Prep S01E01');
  assert.equal(queries.includes('Tower Prep S01'), true);
  assert.equal(queries.includes('Tower Prep'), true);
});

test('reserves resolver capacity for matching season packs', () => {
  const result = (token: string, title: string, score: number) => ({
    result: {
      token,
      title,
      category: '',
      categoryName: '',
      kind: '',
      size: 1,
      sizeHuman: '',
      date: '',
      sources: 1,
    },
    score,
    confirmed: true,
  });
  const ranked = [
    result('episode-1', 'Tower Prep S01E05 1080p', 1_500),
    result('episode-2', 'Tower Prep S01E05 720p', 1_400),
    result('pack-1', 'Tower Prep S01 Complete 1080p', 1_200),
    result('pack-2', 'Tower Prep S01 Pack 720p', 1_100),
    result('other-pack', 'Tower Prep S02 Complete 1080p', 1_000),
  ];

  assert.deepEqual(
    prioritizeDeepbridSeasonPacks(
      ranked,
      { type: 'series', season: 1, episode: 5 },
      3
    ).map((item) => item.result.token),
    ['pack-1', 'episode-1', 'episode-2']
  );
});

test('marks playable Deepbrid Finder links as resolved/cached Usenet', () => {
  const parser = new TestDeepbridParser(parserAddon);
  const stream: Stream = {
    name: '[DB] Deepbrid Usenet',
    description:
      'Example.Show.S01E01.1080p.WEB-DL\nExample.Show.S01E01.1080p.WEB-DL.mkv',
    url: 'https://storage.example/episode.mkv',
    type: 'usenet',
    idMatched: true,
    age: 24,
    behaviorHints: {
      filename: 'Example.Show.S01E01.1080p.WEB-DL.mkv',
      videoSize: 4_294_967_296,
    },
  };

  const parsed = {
    addon: parserAddon,
    type: 'http',
    proxied: false,
  } as ParsedStream;
  assert.equal(parser.indexer(), 'Deepbrid Usenet');
  assert.deepEqual(parser.service(stream, parsed), {
    id: 'deepbrid',
    cached: true,
  });
  assert.equal(parser.streamType(stream, parsed), 'usenet');
  assert.equal(
    parser.filename(stream, parsed),
    'Example.Show.S01E01.1080p.WEB-DL.mkv'
  );
  parsed.filename = parser.filename(stream, parsed);
  assert.equal(parser.size(stream, parsed), 4_294_967_296);
});

test('DeepSpec score uses transparent Deepbrid evidence and aggregates Finder source coverage', () => {
  const baseline = scoreDeepbridSpec({
    titleMatchConfirmed: true,
    containerProbePassed: false,
    result: { sources: 0 },
    file: { name: 'Example.Movie.mkv', size: 0 },
  });
  const probed = scoreDeepbridSpec({
    titleMatchConfirmed: true,
    containerProbePassed: true,
    result: { sources: 0 },
    file: { name: 'Example.Movie.mkv', size: 0 },
  });
  const broadFinderCoverage = scoreDeepbridSpec({
    titleMatchConfirmed: true,
    containerProbePassed: true,
    result: { sources: 20 },
    file: {
      name: 'Example.Movie.1080p.WEB-DL.x265.HDR10.DDP5.1.mkv',
      size: 4_000_000_000,
    },
  });

  assert.ok(probed > baseline, 'successful media probe improves confidence');
  assert.ok(
    broadFinderCoverage > probed,
    'aggregate Finder source count and parsed release evidence contribute'
  );
  assert.ok(broadFinderCoverage <= 100);
  assert.equal(
    scoreDeepbridSpec({
      titleMatchConfirmed: true,
      containerProbePassed: true,
      result: { sources: 100_000 },
      file: {
        name: 'Example.Movie.2160p.REMUX.AV1.DV.TrueHD.Atmos.7.1.4.mkv',
        size: 100_000_000_000,
      },
    }),
    100,
    'score is capped at 100 even for unusually rich metadata'
  );
});

test('Deepbrid source-card extras expose DeepSpec as an estimate, not official TrueSpec verification', () => {
  const parser = new TestDeepbridParser(parserAddon);
  const parsed = {
    addon: parserAddon,
    type: 'http',
    proxied: false,
  } as ParsedStream;
  const extras = parser.extras(
    {
      name: '[DB⚡] Deepbrid Usenet · Direct',
      title: 'Example Movie',
      description: '✦ DeepSpec 82/100 · AIOStreams estimate',
      url: 'https://storage.example/movie.mkv',
      type: 'usenet',
      behaviorHints: {
        deepbridSpecScore: 82,
        deepbridSpecSourceCount: 9,
        deepbridSpecTitleMatch: true,
        deepbridSpecContainerProbePassed: true,
        deepbridSpecVersion: 1,
        deepbridMatchConfidence: 'high',
        deepbridMatchScore: 1_234,
        deepbridMatchEvidence: 'title,episode',
        deepbridEvidenceVersion: 1,
        deepbridEvidence: {
          parsed: true,
          resolved: true,
          probed: true,
          playbackConfirmed: false,
        },
      },
    },
    parsed
  );

  assert.deepEqual(extras?.deepbridSpec, {
    score: 82,
    sourceCount: 9,
    titleMatch: true,
    containerProbePassed: true,
    technicalEvidence: 'filename-inferred',
    scoreVersion: 1,
    rating: 'aiostreams-estimate',
  });
  assert.ok(extras?.formattingSuffix?.some((item) => item.includes('82/100')));
  assert.ok(
    extras?.formattingSuffix?.some((item) => item.includes('Finder sources: 9'))
  );
  assert.deepEqual(extras?.deepbridMatch, {
    confidence: 'high',
    score: 1_234,
    reason: 'title,episode',
  });
  assert.deepEqual(extras?.deepbridEvidence, {
    parsed: true,
    resolved: true,
    probed: true,
    playbackConfirmed: false,
  });
  assert.ok(
    extras?.formattingSuffix?.some((item) =>
      item.includes('Playback unverified')
    )
  );

  const malformed = parser.extras(
    {
      name: '[DB⚡] Deepbrid Usenet · Direct',
      title: 'Example Movie',
      url: 'https://storage.example/movie.mkv',
      type: 'usenet',
      behaviorHints: {
        deepbridSpecScore: null,
        deepbridSpecVersion: 1,
      },
    },
    parsed
  );
  assert.equal(malformed?.deepbridSpec, undefined);
});

test('keeps service routing and indexer formatting for indexer-mode results', () => {
  const parser = new TestDeepbridParser(parserAddon);
  const stream: Stream = {
    name: '[DB ⚡] Deepbrid Usenet',
    description: 'Example.Show.S01E01.1080p\n🔍 ExternalIndexer',
    url: 'https://aiostreams.example/playback',
    type: 'usenet',
    idMatched: true,
    behaviorHints: { filename: 'Example.Show.S01E01.mkv' },
  };
  const parsed = {
    addon: parserAddon,
    type: 'http',
    proxied: false,
  } as ParsedStream;
  assert.equal(parser.indexerFor(stream, parsed), 'ExternalIndexer');
  assert.deepEqual(parser.service(stream, parsed), {
    id: 'deepbrid',
    cached: true,
  });
});

test('offers only Deepbrid-compatible formatting controls', () => {
  const formatting = DEEPBRID_USENET_FORMATTING_OPTION;
  assert.equal(formatting?.type, 'subsection');
  assert.deepEqual(
    formatting?.subOptions?.map((option) => option.id),
    ['useAioFormatter']
  );
  assert.equal(formatting?.subOptions?.[0]?.default, true);

  const serialized = JSON.stringify(formatting).toLowerCase();
  for (const torrentClawSpecific of [
    'torbox',
    'truespec',
    'cache-on-play',
    'score',
    'remapping',
  ]) {
    assert.equal(serialized.includes(torrentClawSpecific), false);
  }
});

test('exposes season-pack provenance separately from the selected episode size', () => {
  const packTitle = 'Example Show S01 Complete 1080p';
  const packSize = 20 * 1024 ** 3;
  const episodeSize = 2 * 1024 ** 3;
  const behaviorHints = {
    filename: 'Example.Show.S01E05.mkv',
    videoSize: episodeSize,
    deepbridSeasonPack: true,
    deepbridReleaseTitle: packTitle,
    deepbridReleaseSize: packSize,
  };

  assert.equal(behaviorHints.videoSize, episodeSize);
  assert.equal(behaviorHints.deepbridReleaseSize, packSize);
  assert.equal(behaviorHints.deepbridReleaseTitle, packTitle);
});

test('uses AIOStreams formatting by default and supports an explicit opt-out', () => {
  assert.equal(deepbridUsenetFormatPassthrough(undefined), false);
  assert.equal(deepbridUsenetFormatPassthrough({}), false);
  assert.equal(
    deepbridUsenetFormatPassthrough({ useAioFormatter: true }),
    false
  );
  assert.equal(
    deepbridUsenetFormatPassthrough({ useAioFormatter: false }),
    true
  );
});

test('resolves Deepbrid content in bounded batches and stops at max results', async () => {
  const calls: string[] = [];
  const ranked = ['a', 'b', 'c', 'd'].map((token, index) => ({
    result: {
      token,
      title: `Movie ${token}`,
      category: '',
      categoryName: '',
      kind: '',
      size: 1,
      sizeHuman: '',
      date: '',
      sources: 4 - index,
    },
    score: 100 - index,
    confirmed: true,
  }));

  const resolved = await resolveDeepbridFiles(
    ranked,
    { type: 'movie' },
    {
      concurrency: 2,
      maxResults: 2,
      deadline: Date.now() + 10_000,
      getContent: async (token) => {
        calls.push(token);
        return {
          title: token,
          files: [
            {
              name: `${token}.mkv`,
              link: `https://storage.example/${token}.mkv`,
              size: 1,
              sizeHuman: '',
            },
          ],
          hasPassword: false,
          password: '',
        };
      },
    }
  );

  assert.deepEqual(calls, ['a', 'b']);
  assert.deepEqual(
    resolved.map((item) => item.file.name),
    ['a.mkv', 'b.mkv']
  );
  assert.equal(
    resolved.every((item) => item.archiveExpanded === false),
    true
  );
});

test('eligibility-only Finder probes never count as a passed container probe', async () => {
  const [resolved] = await resolveDeepbridFiles(
    [
      {
        result: {
          token: 'eligibility-only',
          title: 'Example Movie 1080p',
          category: '',
          categoryName: '',
          kind: '',
          size: 1_000_000_000,
          sizeHuman: '1 GB',
          date: '',
          sources: 12,
        },
        score: 100,
        confirmed: true,
      },
    ],
    { type: 'movie' },
    {
      concurrency: 1,
      maxResults: 0,
      deadline: Date.now() + 5_000,
      getContent: async () => ({
        title: 'Example Movie',
        files: [
          {
            name: 'Example.Movie.1080p.WEB-DL.mkv',
            link: 'https://storage.example/movie.mkv',
            size: 1_000_000_000,
            sizeHuman: '1 GB',
          },
        ],
        hasPassword: false,
        password: '',
      }),
      probeFile: async () => true,
      probeFileValidatesContainer: false,
    }
  );

  assert.equal(resolved?.containerProbePassed, false);
});

test('zero limits keep every Deepbrid candidate and every resolved file', async () => {
  const ranked = ['a', 'b', 'c', 'd'].map((token, index) => ({
    result: {
      token,
      title: `Movie ${token}`,
      category: '',
      categoryName: '',
      kind: '',
      size: 1,
      sizeHuman: '',
      date: '',
      sources: 4 - index,
    },
    score: 100 - index,
    confirmed: true,
  }));
  const candidates = prioritizeDeepbridSeasonPacks(
    ranked,
    { type: 'movie' },
    0
  );
  assert.equal(candidates.length, ranked.length);

  const calls: string[] = [];
  const resolved = await resolveDeepbridFiles(
    candidates,
    { type: 'movie' },
    {
      concurrency: 2,
      maxResults: 0,
      deadline: Date.now() + 10_000,
      requireCompleteResolution: true,
      getContent: async (token) => {
        calls.push(token);
        return {
          title: token,
          files: [
            {
              name: `${token}.mkv`,
              link: `https://storage.example/${token}.mkv`,
              size: 1,
              sizeHuman: '',
            },
          ],
          hasPassword: false,
          password: '',
        };
      },
    }
  );

  assert.deepEqual(calls, ['a', 'b', 'c', 'd']);
  assert.deepEqual(
    resolved.map((item) => item.file.name),
    ['a.mkv', 'b.mkv', 'c.mkv', 'd.mkv']
  );
});

test('uncapped progressive resolution rejects an incomplete candidate tail', async () => {
  let now = 1_000;
  let summary:
    | Parameters<
        NonNullable<Parameters<typeof resolveDeepbridFiles>[2]['onSummary']>
      >[0]
    | undefined;
  const ranked = ['a', 'b', 'c', 'd'].map((token, index) => ({
    result: {
      token,
      title: `Movie ${token}`,
      category: '',
      categoryName: '',
      kind: '',
      size: 1,
      sizeHuman: '',
      date: '',
      sources: 4 - index,
    },
    score: 100 - index,
    confirmed: true,
  }));

  await assert.rejects(
    resolveDeepbridFiles(
      ranked,
      { type: 'movie' },
      {
        concurrency: 1,
        maxResults: 0,
        deadline: 2_000,
        now: () => now,
        requireCompleteResolution: true,
        getContent: async () => {
          now = 2_000;
          return {
            title: 'Movie',
            files: [],
            hasPassword: false,
            password: '',
          };
        },
        onSummary: (value) => {
          summary = value;
        },
      }
    ),
    (error: unknown) =>
      error instanceof DeepbridResolutionIncompleteError &&
      error.summary.attempted === 1 &&
      error.summary.candidates === 4 &&
      error.summary.unattempted === 3 &&
      error.summary.stopReason === 'deadline'
  );

  assert.equal(summary?.attempted, 1);
  assert.equal(summary?.unattempted, 3);
  assert.equal(summary?.deadlineReached, true);
});

test('reports secret-free content resolution accounting for both-mode traces', async () => {
  const ranked = ['video', 'no-video', 'password'].map((token) => ({
    result: {
      token,
      title: `Movie ${token}`,
      category: '',
      categoryName: '',
      kind: '',
      size: 1,
      sizeHuman: '',
      date: '',
      sources: 1,
    },
    score: 100,
    confirmed: true,
  }));
  let summary:
    | Parameters<
        NonNullable<Parameters<typeof resolveDeepbridFiles>[2]['onSummary']>
      >[0]
    | undefined;

  const resolved = await resolveDeepbridFiles(
    ranked,
    { type: 'movie' },
    {
      concurrency: 1,
      maxResults: 0,
      deadline: Date.now() + 10_000,
      getContent: async (token) => ({
        title: token,
        files:
          token === 'video'
            ? [
                {
                  name: 'Movie.2026.1080p.mkv',
                  link: 'https://storage.example/private.mkv',
                  size: 100,
                  sizeHuman: '',
                },
              ]
            : [],
        hasPassword: token === 'password',
        password: '',
      }),
      onSummary: (value) => {
        summary = value;
      },
    }
  );

  assert.equal(resolved.length, 1);
  assert.deepEqual(summary, {
    candidates: 3,
    attempted: 3,
    contentRequests: 3,
    resolutionFailures: 0,
    resolutionFailureClasses: {
      abort: 0,
      timeout: 0,
      connection: 0,
      api: 0,
      other: 0,
    },
    apiFailureKinds: {
      api_12: 0,
      api_response: 0,
      http_error: 0,
      retry_exhausted: 0,
      cloudflare_response: 0,
      invalid_json: 0,
      unsafe_download_url: 0,
      request_gate_capacity: 0,
      other: 0,
    },
    retryExhaustionReasons: {
      request_gate_deadline: 0,
      wrapper_budget_before_attempt: 0,
      wrapper_completed_after_deadline: 0,
      request_json_budget_before_attempt: 0,
      request_json_budget_at_gate: 0,
      request_json_loop_exhausted: 0,
      signature_correction_budget: 0,
      finder_budget_at_gate: 0,
      unknown: 0,
    },
    api12Skips: 0,
    otherApiFailures: 0,
    passwordProtected: 1,
    episodeMatchedFiles: 1,
    returnedFiles: 1,
    unattempted: 0,
    deadlineSkipped: 0,
    stopReason: 'complete',
    deadlineReached: false,
    aborted: false,
  });
});

test('classifies resolver failures without retaining error text', () => {
  const timeout = new Error('PRIVATE_TIMEOUT_DETAIL');
  timeout.name = 'TimeoutError';
  const connection = new Error('PRIVATE_CONNECTION_DETAIL') as Error & {
    cause: Error & { code: string };
  };
  connection.cause = Object.assign(new Error('PRIVATE_NESTED_DETAIL'), {
    code: 'ECONNRESET',
  });

  assert.equal(classifyDeepbridResolutionFailure(timeout), 'timeout');
  assert.equal(
    classifyDeepbridResolutionFailure(
      new DOMException('private', 'AbortError')
    ),
    'abort'
  );
  assert.equal(classifyDeepbridResolutionFailure(connection), 'connection');
  assert.equal(
    classifyDeepbridResolutionFailure(
      new DeepbridApiError('PRIVATE_API_DETAIL', 429, 'http-error')
    ),
    'api'
  );
  assert.equal(
    classifyDeepbridResolutionFailure(
      new DeepbridApiError('PRIVATE_API_DETAIL', 503, 'http-error')
    ),
    'api'
  );
  assert.equal(
    classifyDeepbridResolutionFailure(new Error('PRIVATE_OTHER_DETAIL')),
    'other'
  );
  const malformed = Object.assign(new Error('PRIVATE_SENTINEL'), {
    name: 'PRIVATE_ERROR_NAME',
    code: {
      toString() {
        throw new Error('Must not execute');
      },
    },
  });
  assert.equal(classifyDeepbridResolutionFailure(malformed), 'other');
  assert.doesNotMatch(
    JSON.stringify([
      classifyDeepbridResolutionFailure(timeout),
      classifyDeepbridResolutionFailure(connection),
    ]),
    /PRIVATE_/i
  );
});

test('archive expansion is not reported as archive-integrity verification', () => {
  assert.equal(classifyDeepbridArchiveIntegrity(true), 'not-verified');
  assert.equal(classifyDeepbridArchiveIntegrity(false), 'not-assessed');
});

test('propagates incomplete split-archive evidence onto resolved Deepbrid files', async () => {
  const [resolved] = await resolveDeepbridFiles(
    [
      {
        result: {
          token: 'incomplete-archive',
          title: 'Example Movie 2026 1080p',
          category: '',
          categoryName: '',
          kind: '',
          size: 1_000_000_000,
          sizeHuman: '1 GB',
          date: '',
          sources: 1,
        },
        score: 100,
        confirmed: true,
      },
    ],
    { type: 'movie' },
    {
      concurrency: 1,
      maxResults: 0,
      deadline: Date.now() + 5_000,
      getContent: async (_token, archives) => ({
        title: 'Example Movie',
        files: archives
          ? [
              {
                name: 'Example.Movie.2026.mkv',
                link: 'https://storage.example/movie.mkv',
                size: 1_000,
                sizeHuman: '',
              },
            ]
          : [
              {
                name: 'Example.Movie.part01.rar',
                link: 'https://storage.example/part01.rar',
                size: 10,
                sizeHuman: '',
              },
              {
                name: 'Example.Movie.part03.rar',
                link: 'https://storage.example/part03.rar',
                size: 10,
                sizeHuman: '',
              },
            ],
        hasPassword: false,
        password: '',
      }),
    }
  );

  assert.equal(resolved.archiveExpanded, true);
  assert.equal(resolved.archiveIntegrity, 'incomplete');
});

test('detects visible missing archive-volume indices without claiming a full set is verified', () => {
  const gap = [{ name: 'Release.part01.rar' }, { name: 'Release.part03.rar' }];
  assert.deepEqual(assessDeepbridArchiveVolumes(gap), {
    hasArchives: true,
    incomplete: true,
    unreachableArchiveCount: 0,
    missingVolumeNumbers: [2],
  });
  assert.equal(classifyDeepbridArchiveIntegrity(true, gap), 'incomplete');

  assert.deepEqual(
    assessDeepbridArchiveVolumes([
      { name: 'Legacy.rar' },
      { name: 'Legacy.r00' },
      { name: 'Legacy.r02' },
    ]).missingVolumeNumbers,
    [1],
    'old-style RAR volume sequences are checked for internal gaps'
  );
  assert.deepEqual(
    assessDeepbridArchiveVolumes([
      { name: 'Split.zip' },
      { name: 'Split.z01' },
      { name: 'Split.z03' },
    ]).missingVolumeNumbers,
    [2],
    'split ZIP sequences are checked for internal gaps'
  );

  const unreachable = [
    { name: 'Release.7z.001' },
    { name: 'Release.7z.002', unreachable: 'provider-specific detail' },
  ];
  assert.equal(
    assessDeepbridArchiveVolumes(unreachable).unreachableArchiveCount,
    1
  );
  assert.equal(
    classifyDeepbridArchiveIntegrity(true, unreachable),
    'incomplete'
  );

  assert.equal(
    classifyDeepbridArchiveIntegrity(true, [
      { name: 'Release.part01.rar' },
      { name: 'Release.part02.rar' },
    ]),
    'not-verified',
    'a contiguous visible list does not prove that the final volume is present'
  );
});

test('malformed error codes cannot escape candidate resolution workers', async () => {
  const malformed = Object.assign(new Error('PRIVATE_SENTINEL'), {
    name: 'PRIVATE_ERROR_NAME',
    code: {
      toString() {
        throw new Error('Must not execute');
      },
    },
  });
  let summary:
    | Parameters<
        NonNullable<Parameters<typeof resolveDeepbridFiles>[2]['onSummary']>
      >[0]
    | undefined;

  const resolved = await resolveDeepbridFiles(
    [
      {
        result: {
          token: 'candidate-test',
          title: 'Movie 2026',
          category: '',
          categoryName: '',
          kind: '',
          size: 1,
          sizeHuman: '',
          date: '',
          sources: 1,
        },
        score: 100,
        confirmed: true,
      },
    ],
    { type: 'movie' },
    {
      concurrency: 1,
      maxResults: 0,
      deadline: Date.now() + 10_000,
      getContent: async () => {
        throw malformed;
      },
      onSummary: (value) => {
        summary = value;
      },
    }
  );

  assert.deepEqual(resolved, []);
  assert.equal(summary?.resolutionFailures, 1);
  assert.equal(summary?.resolutionFailureClasses.other, 1);
  assert.equal(summary?.apiFailureKinds.other, 0);
  assert.equal(summary?.otherApiFailures, 0);
  assert.equal(summary?.stopReason, 'complete');
  assert.doesNotMatch(
    JSON.stringify(summary),
    /PRIVATE_SENTINEL|PRIVATE_ERROR_NAME|private-candidate-token/i
  );
});

test('summary separates timeout failures from safe API error details', async () => {
  const timeout = new Error('PRIVATE_TIMEOUT_DETAIL');
  timeout.name = 'TimeoutError';
  let summary:
    | Parameters<
        NonNullable<Parameters<typeof resolveDeepbridFiles>[2]['onSummary']>
      >[0]
    | undefined;

  await resolveDeepbridFiles(
    [
      {
        result: {
          token: 'candidate-test',
          title: 'Movie 2026',
          category: '',
          categoryName: '',
          kind: '',
          size: 1,
          sizeHuman: '',
          date: '',
          sources: 1,
        },
        score: 100,
        confirmed: true,
      },
    ],
    { type: 'movie' },
    {
      concurrency: 1,
      maxResults: 0,
      deadline: Date.now() + 10_000,
      getContent: async () => {
        throw timeout;
      },
      onSummary: (value) => {
        summary = value;
      },
    }
  );

  assert.equal(summary?.resolutionFailures, 1);
  assert.deepEqual(summary?.resolutionFailureClasses, {
    abort: 0,
    timeout: 1,
    connection: 0,
    api: 0,
    other: 0,
  });
  assert.deepEqual(summary?.apiFailureKinds, {
    api_12: 0,
    api_response: 0,
    http_error: 0,
    retry_exhausted: 0,
    cloudflare_response: 0,
    invalid_json: 0,
    unsafe_download_url: 0,
    request_gate_capacity: 0,
    other: 0,
  });
  assert.deepEqual(summary?.retryExhaustionReasons, {
    request_gate_deadline: 0,
    wrapper_budget_before_attempt: 0,
    wrapper_completed_after_deadline: 0,
    request_json_budget_before_attempt: 0,
    request_json_budget_at_gate: 0,
    request_json_loop_exhausted: 0,
    signature_correction_budget: 0,
    finder_budget_at_gate: 0,
    unknown: 0,
  });
  assert.equal(summary?.api12Skips, 0);
  assert.equal(summary?.otherApiFailures, 0);
  assert.doesNotMatch(
    JSON.stringify(summary),
    /PRIVATE_|private-candidate-token/i
  );
});

test('counts expected api_12 skips separately without changing completeness', async () => {
  let summary:
    | Parameters<
        NonNullable<Parameters<typeof resolveDeepbridFiles>[2]['onSummary']>
      >[0]
    | undefined;
  const resolved = await resolveDeepbridFiles(
    [
      {
        result: {
          token: 'candidate-test',
          title: 'Movie 2026',
          category: '',
          categoryName: '',
          kind: '',
          size: 1,
          sizeHuman: '',
          date: '',
          sources: 1,
        },
        score: 100,
        confirmed: true,
      },
    ],
    { type: 'movie' },
    {
      concurrency: 1,
      maxResults: 0,
      deadline: Date.now() + 10_000,
      getContent: async () => {
        throw new DeepbridApiError('PRIVATE_API_DETAIL', 200, 'api_12');
      },
      onSummary: (value) => {
        summary = value;
      },
    }
  );

  assert.deepEqual(resolved, []);
  assert.equal(summary?.resolutionFailures, 1);
  assert.equal(summary?.resolutionFailureClasses.api, 1);
  assert.equal(summary?.apiFailureKinds.api_12, 1);
  assert.equal(summary?.apiFailureKinds.retry_exhausted, 0);
  assert.equal(
    Object.values(summary?.retryExhaustionReasons ?? {}).reduce(
      (total, count) => total + count,
      0
    ),
    0
  );
  assert.equal(summary?.api12Skips, 1);
  assert.equal(summary?.otherApiFailures, 0);
  assert.equal(summary?.stopReason, 'complete');
  assert.doesNotMatch(
    JSON.stringify(summary),
    /PRIVATE_|private-candidate-token/i
  );
});

test('aggregates fixed retry-exhaustion reasons without exposing error text', async () => {
  const failures = new Map<string, DeepbridApiError>([
    [
      'known',
      new DeepbridApiError(
        'PRIVATE_CANDIDATE_ERROR',
        undefined,
        'retry-exhausted',
        undefined,
        'finder_budget_at_gate'
      ),
    ],
    [
      'missing-reason',
      new DeepbridApiError(
        'PRIVATE_CANDIDATE_ERROR',
        undefined,
        'retry-exhausted'
      ),
    ],
  ]);
  let summary:
    | Parameters<
        NonNullable<Parameters<typeof resolveDeepbridFiles>[2]['onSummary']>
      >[0]
    | undefined;

  await resolveDeepbridFiles(
    [...failures.keys()].map((token) => ({
      result: {
        token,
        title: 'Movie 2026',
        category: '',
        categoryName: '',
        kind: '',
        size: 1,
        sizeHuman: '',
        date: '',
        sources: 1,
      },
      score: 100,
      confirmed: true,
    })),
    { type: 'movie' },
    {
      concurrency: 1,
      maxResults: 0,
      deadline: Date.now() + 10_000,
      getContent: async (token) => {
        throw failures.get(token);
      },
      onSummary: (value) => {
        summary = value;
      },
    }
  );

  assert.equal(summary?.apiFailureKinds.retry_exhausted, 2);
  assert.equal(summary?.retryExhaustionReasons.finder_budget_at_gate, 1);
  assert.equal(summary?.retryExhaustionReasons.unknown, 1);
  assert.equal(
    Object.values(summary?.retryExhaustionReasons ?? {}).reduce(
      (total, count) => total + count,
      0
    ),
    summary?.apiFailureKinds.retry_exhausted
  );
  assert.doesNotMatch(
    JSON.stringify(summary),
    /PRIVATE_CANDIDATE_ERROR|private-candidate-token|missing-reason/i
  );
});

test('a failing Deepbrid accounting callback cannot fail content resolution', async () => {
  const resolved = await resolveDeepbridFiles(
    [
      {
        result: {
          token: 'safe-fixture',
          title: 'Movie 2026',
          category: '',
          categoryName: '',
          kind: '',
          size: 1,
          sizeHuman: '',
          date: '',
          sources: 1,
        },
        score: 100,
        confirmed: true,
      },
    ],
    { type: 'movie' },
    {
      concurrency: 1,
      maxResults: 0,
      deadline: Date.now() + 10_000,
      getContent: async () => ({
        title: 'Movie 2026',
        files: [
          {
            name: 'Movie.2026.mkv',
            link: 'https://storage.example/fixture.mkv',
            size: 100,
            sizeHuman: '',
          },
        ],
        hasPassword: false,
        password: '',
      }),
      onSummary: () => {
        throw new Error('diagnostic callback failure');
      },
    }
  );

  assert.equal(resolved.length, 1);
});

test('an asynchronous accounting callback rejection is observed without delaying results', async () => {
  const resolved = await resolveDeepbridFiles(
    [
      {
        result: {
          token: 'safe-fixture',
          title: 'Movie 2026',
          category: '',
          categoryName: '',
          kind: '',
          size: 1,
          sizeHuman: '',
          date: '',
          sources: 1,
        },
        score: 100,
        confirmed: true,
      },
    ],
    { type: 'movie' },
    {
      concurrency: 1,
      maxResults: 1,
      deadline: Date.now() + 10_000,
      getContent: async () => ({
        title: 'Movie 2026',
        files: [
          {
            name: 'Movie.2026.mkv',
            link: 'https://storage.example/fixture.mkv',
            size: 100,
            sizeHuman: '',
          },
        ],
        hasPassword: false,
        password: '',
      }),
      onSummary: async () => {
        throw new Error('async diagnostic failure');
      },
    }
  );

  assert.equal(resolved.length, 1);
});

test('does not label an exhausted candidate list as stopped by max results', async () => {
  let stopReason = '';
  await resolveDeepbridFiles(
    [
      {
        result: {
          token: 'safe-fixture',
          title: 'Movie 2026',
          category: '',
          categoryName: '',
          kind: '',
          size: 1,
          sizeHuman: '',
          date: '',
          sources: 1,
        },
        score: 100,
        confirmed: true,
      },
    ],
    { type: 'movie' },
    {
      concurrency: 1,
      maxResults: 1,
      deadline: Date.now() + 10_000,
      getContent: async () => ({
        title: 'Movie 2026',
        files: [
          {
            name: 'Movie.2026.mkv',
            link: 'https://storage.example/fixture.mkv',
            size: 100,
            sizeHuman: '',
          },
        ],
        hasPassword: false,
        password: '',
      }),
      onSummary: (summary) => {
        stopReason = summary.stopReason;
      },
    }
  );

  assert.equal(stopReason, 'complete');
});

test('reports accounting on worker failure without replacing the original error', async () => {
  const controller = new AbortController();
  const originalError = new Error('synthetic progress failure');
  let summary:
    | Parameters<
        NonNullable<Parameters<typeof resolveDeepbridFiles>[2]['onSummary']>
      >[0]
    | undefined;

  await assert.rejects(
    resolveDeepbridFiles(
      [
        {
          result: {
            token: 'safe-fixture',
            title: 'Movie 2026',
            category: '',
            categoryName: '',
            kind: '',
            size: 1,
            sizeHuman: '',
            date: '',
            sources: 1,
          },
          score: 100,
          confirmed: true,
        },
      ],
      { type: 'movie' },
      {
        concurrency: 1,
        maxResults: 0,
        deadline: Date.now() + 10_000,
        signal: controller.signal,
        getContent: async () => ({
          title: 'Movie 2026',
          files: [
            {
              name: 'Movie.2026.mkv',
              link: 'https://storage.example/fixture.mkv',
              size: 100,
              sizeHuman: '',
            },
          ],
          hasPassword: false,
          password: '',
        }),
        onResolved: () => {
          controller.abort();
          throw originalError;
        },
        onSummary: (value) => {
          summary = value;
        },
      }
    ),
    (error: unknown) => error === originalError
  );

  assert.equal(summary?.stopReason, 'aborted');
  assert.equal(summary?.attempted, 1);
  assert.equal(summary?.returnedFiles, 0);
});

test('waits for other resolution workers before reporting a rejected worker', async () => {
  const controller = new AbortController();
  const originalError = new Error('synthetic progress failure');
  let releaseSlow!: () => void;
  let markSlowStarted!: () => void;
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const slowStarted = new Promise<void>((resolve) => {
    markSlowStarted = resolve;
  });
  let summary:
    | Parameters<
        NonNullable<Parameters<typeof resolveDeepbridFiles>[2]['onSummary']>
      >[0]
    | undefined;
  const ranked = ['fast', 'slow'].map((token) => ({
    result: {
      token,
      title: `Movie ${token}`,
      category: '',
      categoryName: '',
      kind: '',
      size: 1,
      sizeHuman: '',
      date: '',
      sources: 1,
    },
    score: 100,
    confirmed: true,
  }));

  await assert.rejects(
    resolveDeepbridFiles(
      ranked,
      { type: 'movie' },
      {
        concurrency: 2,
        maxResults: 0,
        deadline: Date.now() + 10_000,
        signal: controller.signal,
        getContent: async (token) => {
          if (token === 'slow') {
            markSlowStarted();
            await slowGate;
          } else await slowStarted;
          return {
            title: token,
            files: [
              {
                name: `Movie.${token}.mkv`,
                link: `https://storage.example/${token}.mkv`,
                size: 100,
                sizeHuman: '',
              },
            ],
            hasPassword: false,
            password: '',
          };
        },
        onResolved: async (files) => {
          if (files[0]?.result.token !== 'fast') return;
          controller.abort();
          releaseSlow();
          throw originalError;
        },
        onSummary: (value) => {
          summary = value;
        },
      }
    ),
    (error: unknown) => error === originalError
  );

  assert.equal(summary?.attempted, 2);
  assert.equal(summary?.contentRequests, 2);
  assert.equal(summary?.episodeMatchedFiles, 2);
  assert.equal(summary?.returnedFiles, 0);
  assert.equal(summary?.unattempted, 0);
  assert.equal(summary?.stopReason, 'aborted');
});

test('inherits the safe Finder search NZB URL when content files omit it', async () => {
  const finderNzbUrl = 'https://www.deepbrid.com/finder/release.nzb';
  const resolved = await resolveDeepbridFiles(
    [
      {
        result: {
          token: 'finder-token',
          title: 'Verified release',
          category: '',
          categoryName: '',
          kind: '',
          size: 1,
          sizeHuman: '',
          nzbUrl: finderNzbUrl,
          date: '',
          sources: 1,
        },
        score: 100,
        confirmed: true,
      },
    ],
    { type: 'movie' },
    {
      concurrency: 1,
      maxResults: 0,
      deadline: Date.now() + 5_000,
      getContent: async () => ({
        title: 'Verified release',
        files: [
          {
            name: 'release.mkv',
            link: 'https://storage.example/release.mkv',
            size: 1,
            sizeHuman: '',
          },
        ],
        hasPassword: false,
        password: '',
      }),
    }
  );

  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].file.nzbUrl, finderNzbUrl);
});

test('emits verified files as candidates resolve without changing final rank order', async () => {
  const ranked = ['a', 'b', 'c'].map((token, index) => ({
    result: {
      token,
      title: `Movie ${token}`,
      category: '',
      categoryName: '',
      kind: '',
      size: 1,
      sizeHuman: '',
      date: '',
      sources: 3 - index,
    },
    score: 100 - index,
    confirmed: true,
  }));
  let releaseA!: () => void;
  const aMayFinish = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const emitted: string[] = [];

  const resolved = await resolveDeepbridFiles(
    ranked,
    { type: 'movie' },
    {
      concurrency: 2,
      maxResults: 0,
      deadline: Date.now() + 5_000,
      getContent: async (token) => {
        if (token === 'a') await aMayFinish;
        return {
          title: token,
          files: [
            {
              name: `${token}.mkv`,
              link: `https://storage.example/${token}.mkv`,
              size: 1,
              sizeHuman: '',
            },
          ],
          hasPassword: false,
          password: '',
        };
      },
      onResolved: async (files) => {
        const token = files[0].result.token;
        emitted.push(token);
        if (token === 'b') releaseA();
      },
    }
  );

  assert.equal(emitted[0], 'b');
  assert.deepEqual(
    resolved.map((item) => item.result.token),
    ['a', 'b', 'c']
  );
});

test('slow direct probes do not hold Finder resolution or external NZB results', async () => {
  const collector = new ValidatedProgressiveStreamCollector();
  let releaseProbe!: () => void;
  const probeGate = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  const queue = new ValidatedFinderResolutionQueue(collector, async (files) => {
    await probeGate;
    return files.map((item) => ({
      name: '[DB⚡] Deepbrid Usenet · Direct',
      title: item.result.title,
      description: item.file.name,
      url: `https://playback.example/${item.file.name}`,
      type: 'usenet' as const,
    }));
  });

  const ranked = ['first', 'second'].map((token, index) => ({
    result: {
      token,
      title: `Movie ${token}`,
      category: '',
      categoryName: '',
      kind: '',
      size: 100 - index,
      sizeHuman: '',
      date: '',
      sources: 2,
      nzbUrl: `https://finder.example/${token}.nzb`,
    },
    score: 100 - index,
    confirmed: true,
  }));

  const resolved = await resolveDeepbridFiles(
    ranked,
    { type: 'movie' },
    {
      concurrency: 2,
      maxResults: 0,
      deadline: Date.now() + 5_000,
      getContent: async (token) => ({
        title: `Movie ${token}`,
        files: [
          {
            name: `${token}.mkv`,
            link: `https://storage.example/${token}.mkv`,
            size: 1,
            sizeHuman: '',
          },
        ],
        hasPassword: false,
        password: '',
      }),
      // The production both-mode path uses this always-true predicate so
      // external Usenet resolvers retain Finder NZBs independently of media
      // link preflight.
      probeFile: () => Promise.resolve(true),
      onResolved: queue.schedule,
    }
  );

  assert.equal(resolved.length, 2);
  assert.deepEqual(
    resolved.map(({ result }) => result.nzbUrl),
    ['https://finder.example/first.nzb', 'https://finder.example/second.nzb']
  );
  assert.deepEqual(collector.mergeFinal([]), []);

  const drain = queue.drain();
  releaseProbe();
  await drain;
  assert.deepEqual(
    collector.mergeFinal([]).map((stream) => stream.title),
    ['Movie first', 'Movie second']
  );
});

test('a failed progress notification does not discard a verified Deepbrid result', async () => {
  const ranked = [
    {
      result: {
        token: 'verified',
        title: 'Verified movie',
        category: '',
        categoryName: '',
        kind: '',
        size: 1,
        sizeHuman: '',
        date: '',
        sources: 1,
      },
      score: 100,
      confirmed: true,
    },
  ];
  const resolved = await resolveDeepbridFiles(
    ranked,
    { type: 'movie' },
    {
      concurrency: 1,
      maxResults: 0,
      deadline: Date.now() + 5_000,
      getContent: async () => ({
        title: 'Verified movie',
        files: [
          {
            name: 'verified.mkv',
            link: 'https://storage.example/verified.mkv',
            size: 1,
            sizeHuman: '',
          },
        ],
        hasPassword: false,
        password: '',
      }),
      onResolved: async () => {
        throw new Error('progress transport closed');
      },
    }
  );

  assert.deepEqual(
    resolved.map((item) => item.file.name),
    ['verified.mkv']
  );
});

test('finite caps let another worker continue after a reserved candidate fails', async () => {
  const calls: string[] = [];
  const ranked = ['fails', 'succeeds'].map((token, index) => ({
    result: {
      token,
      title: `Movie ${token}`,
      category: '',
      categoryName: '',
      kind: '',
      size: 1,
      sizeHuman: '',
      date: '',
      sources: 2 - index,
    },
    score: 100 - index,
    confirmed: true,
  }));

  const resolved = await resolveDeepbridFiles(
    ranked,
    { type: 'movie' },
    {
      concurrency: 2,
      maxResults: 1,
      deadline: Date.now() + 5_000,
      getContent: async (token) => {
        calls.push(token);
        if (token === 'fails') throw new Error('temporary content failure');
        return {
          title: token,
          files: [
            {
              name: 'succeeds.mkv',
              link: 'https://storage.example/succeeds.mkv',
              size: 1,
              sizeHuman: '',
            },
          ],
          hasPassword: false,
          password: '',
        };
      },
    }
  );

  assert.deepEqual(calls.sort(), ['fails', 'succeeds']);
  assert.deepEqual(
    resolved.map((item) => item.result.token),
    ['succeeds']
  );
});

test('zero Deepbrid result cap keeps every resolved video file', async () => {
  const ranked = ['a', 'b', 'c'].map((token) => ({
    result: {
      token,
      title: `Movie ${token}`,
      category: '',
      categoryName: '',
      kind: '',
      size: 1,
      sizeHuman: '',
      date: '',
      sources: 1,
    },
    score: 100,
    confirmed: true,
  }));
  const resolved = await resolveDeepbridFiles(
    ranked,
    { type: 'movie' },
    {
      concurrency: 2,
      maxResults: 0,
      deadline: Date.now() + 10_000,
      getContent: async (token) => ({
        title: token,
        files: [
          {
            name: `${token}.mkv`,
            link: `https://storage.example/${token}.mkv`,
            size: 1,
            sizeHuman: '',
          },
        ],
        hasPassword: false,
        password: '',
      }),
    }
  );
  assert.deepEqual(
    resolved.map((item) => item.file.name),
    ['a.mkv', 'b.mkv', 'c.mkv']
  );
});

test('aborting a Finder scrape stops content resolution before the next candidate', async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const ranked = ['a', 'b'].map((token) => ({
    result: {
      token,
      title: `Movie ${token}`,
      category: '',
      categoryName: '',
      kind: '',
      size: 1,
      sizeHuman: '',
      date: '',
      sources: 1,
    },
    score: 100,
    confirmed: true,
  }));

  const resolved = await resolveDeepbridFiles(
    ranked,
    { type: 'movie' },
    {
      concurrency: 1,
      maxResults: 0,
      deadline: Date.now() + 10_000,
      signal: controller.signal,
      getContent: async (token, _archives, options) => {
        calls.push(token);
        assert.equal(options.signal, controller.signal);
        controller.abort();
        throw new DOMException('request aborted', 'AbortError');
      },
    }
  );

  assert.deepEqual(calls, ['a']);
  assert.deepEqual(resolved, []);
});

test('Deepbrid Finder search paginates and retains already fetched pages', async () => {
  const calls: number[] = [];
  const makeResult = (token: string): DeepbridFinderResult => ({
    token,
    title: token,
    category: '',
    categoryName: '',
    kind: '',
    size: 1,
    sizeHuman: '',
    date: '',
    sources: 1,
  });
  const client = {
    searchPage: async (_query: string, options: { offset?: number }) => {
      const offset = options.offset ?? 0;
      calls.push(offset);
      if (offset === 0) {
        return {
          results: Array.from({ length: 50 }, (_, index) =>
            makeResult(`result-${index}`)
          ),
          rawCount: 50,
          invalidCount: 0,
        };
      }
      if (offset === 50) {
        return {
          results: [makeResult('result-50')],
          rawCount: 1,
          invalidCount: 0,
        };
      }
      if (offset === 100) {
        return { results: [], rawCount: 0, invalidCount: 0 };
      }
      throw new Error('unexpected extra page');
    },
  } as unknown as DeepbridFinderClient;
  let outcome: DeepbridFinderPaginationOutcome | undefined;
  const results = await searchDeepbridFinderPages(client, 'sample title', {
    deadline: Date.now() + 10_000,
    onOutcome: (value) => (outcome = value),
  });
  assert.deepEqual(calls, [0, 50, 100]);
  assert.equal(results.length, 51);
  assert.deepEqual(outcome, {
    pagesFetched: 3,
    pageRetries: 0,
    resultCount: 51,
    invalidResultCount: 0,
    termination: 'no-more-results',
  });

  const partialClient = {
    searchPage: async (_query: string, options: { offset?: number }) => {
      if ((options.offset ?? 0) === 0) {
        return {
          results: Array.from({ length: 50 }, (_, index) =>
            makeResult(`partial-${index}`)
          ),
          rawCount: 50,
          invalidCount: 0,
        };
      }
      throw new Error('later page unavailable');
    },
  } as unknown as DeepbridFinderClient;
  let partialOutcome: DeepbridFinderPaginationOutcome | undefined;
  const partial = await searchDeepbridFinderPages(
    partialClient,
    'sample title',
    {
      deadline: Date.now() + 10_000,
      onOutcome: (value) => (partialOutcome = value),
    }
  );
  assert.equal(partial.length, 50);
  assert.deepEqual(partialOutcome, {
    pagesFetched: 1,
    pageRetries: 0,
    resultCount: 50,
    invalidResultCount: 0,
    termination: 'page-error',
  });
});

test('Deepbrid Finder retries a transient page failure without skipping that page', async () => {
  const calls: number[] = [];
  const makeResult = (token: string): DeepbridFinderResult => ({
    token,
    title: token,
    category: '',
    categoryName: '',
    kind: '',
    size: 1,
    sizeHuman: '',
    date: '',
    sources: 1,
  });
  const client = {
    searchPage: async (_query: string, options: { offset?: number }) => {
      const offset = options.offset ?? 0;
      calls.push(offset);
      if (offset === 0) {
        return {
          results: Array.from({ length: 50 }, (_, index) =>
            makeResult(`retry-${index}`)
          ),
          rawCount: 50,
          invalidCount: 0,
        };
      }
      if (calls.filter((value) => value === offset).length === 1) {
        throw new TypeError('fetch failed');
      }
      return {
        results: [makeResult('retry-50')],
        rawCount: 1,
        invalidCount: 0,
      };
    },
  } as unknown as DeepbridFinderClient;
  let outcome: DeepbridFinderPaginationOutcome | undefined;

  const results = await searchDeepbridFinderPages(client, 'sample title', {
    deadline: Date.now() + 10_000,
    onOutcome: (value) => (outcome = value),
  });

  assert.deepEqual(calls, [0, 50, 50, 100, 100, 150, 150, 200, 200]);
  assert.equal(results.length, 51);
  assert.deepEqual(outcome, {
    pagesFetched: 5,
    pageRetries: 4,
    resultCount: 51,
    invalidResultCount: 0,
    termination: 'repeated-page',
  });
});

test('Deepbrid Finder treats an empty page after a successful retry as complete', async () => {
  let attempts = 0;
  const client = {
    searchPage: async () => {
      attempts++;
      if (attempts === 1) throw new TypeError('fetch failed');
      return { results: [], rawCount: 0, invalidCount: 0 };
    },
  } as unknown as DeepbridFinderClient;
  let outcome: DeepbridFinderPaginationOutcome | undefined;

  const results = await searchDeepbridFinderPages(client, 'sample title', {
    deadline: Date.now() + 10_000,
    onOutcome: (value) => (outcome = value),
  });

  assert.deepEqual(results, []);
  assert.equal(attempts, 2);
  assert.deepEqual(outcome, {
    pagesFetched: 1,
    pageRetries: 1,
    resultCount: 0,
    invalidResultCount: 0,
    termination: 'no-more-results',
  });
});

test('Deepbrid Finder does not retry non-network TypeErrors', async () => {
  let attempts = 0;
  const client = {
    searchPage: async () => {
      attempts++;
      throw new TypeError('invalid response adapter state');
    },
  } as unknown as DeepbridFinderClient;
  let outcome: DeepbridFinderPaginationOutcome | undefined;

  await assert.rejects(
    searchDeepbridFinderPages(client, 'sample title', {
      deadline: Date.now() + 10_000,
      onOutcome: (value) => (outcome = value),
    }),
    /invalid response adapter state/
  );

  assert.equal(attempts, 1);
  assert.deepEqual(outcome, {
    pagesFetched: 0,
    pageRetries: 0,
    resultCount: 0,
    invalidResultCount: 0,
    termination: 'page-error',
  });
});

test('Deepbrid Finder honors a 429 retry-after delay within the request budget', async () => {
  let attempts = 0;
  const client = {
    searchPage: async () => {
      attempts++;
      if (attempts === 1) {
        throw new DeepbridApiError('rate limited', 429, 'http-error', 1);
      }
      return { results: [], rawCount: 0, invalidCount: 0 };
    },
  } as unknown as DeepbridFinderClient;
  let outcome: DeepbridFinderPaginationOutcome | undefined;

  const results = await searchDeepbridFinderPages(client, 'sample title', {
    deadline: Date.now() + 10_000,
    onOutcome: (value) => (outcome = value),
  });

  assert.deepEqual(results, []);
  assert.equal(attempts, 2);
  assert.equal(outcome?.pageRetries, 1);
  assert.equal(outcome?.termination, 'no-more-results');
});

test('Deepbrid Finder caps repeated zero-cooldown 429 responses at two retries', async () => {
  let attempts = 0;
  const client = {
    searchPage: async () => {
      attempts++;
      throw new DeepbridApiError('rate limited', 429, 'http-error', 0);
    },
  } as unknown as DeepbridFinderClient;
  let outcome: DeepbridFinderPaginationOutcome | undefined;

  await assert.rejects(
    searchDeepbridFinderPages(client, 'sample title', {
      deadline: Date.now() + 10_000,
      onOutcome: (value) => (outcome = value),
    }),
    /rate limited/
  );

  assert.equal(attempts, 3);
  assert.equal(outcome?.pageRetries, 2);
  assert.equal(outcome?.termination, 'page-error');
});

test('Deepbrid Finder aborts during retry backoff without starting another page request', async () => {
  const controller = new AbortController();
  let attempts = 0;
  let outcome: DeepbridFinderPaginationOutcome | undefined;
  const abortTimer = setTimeout(() => controller.abort(), 20);
  const client = {
    searchPage: async () => {
      attempts++;
      throw new TypeError('fetch failed');
    },
  } as unknown as DeepbridFinderClient;

  try {
    await assert.rejects(
      searchDeepbridFinderPages(client, 'sample title', {
        deadline: Date.now() + 10_000,
        signal: controller.signal,
        onOutcome: (value) => (outcome = value),
      }),
      /fetch failed/
    );
  } finally {
    clearTimeout(abortTimer);
  }

  assert.equal(attempts, 1);
  assert.equal(outcome?.pageRetries, 0);
  assert.equal(outcome?.termination, 'aborted');
});

test('Deepbrid Finder does not retry authentication failures', async () => {
  for (const status of [401, 403]) {
    let attempts = 0;
    const error = new DeepbridApiError('unauthorized', status, 'http-error');
    const client = {
      searchPage: async () => {
        attempts++;
        throw error;
      },
    } as unknown as DeepbridFinderClient;
    let outcome: DeepbridFinderPaginationOutcome | undefined;

    await assert.rejects(
      searchDeepbridFinderPages(client, 'sample title', {
        deadline: Date.now() + 10_000,
        onOutcome: (value) => (outcome = value),
      }),
      (caught) => caught === error
    );

    assert.equal(attempts, 1);
    assert.equal(outcome?.pageRetries, 0);
    assert.equal(outcome?.termination, 'page-error');
  }
});

test('Deepbrid Finder bounds transient page retries and marks partial results incomplete', async () => {
  const calls: number[] = [];
  const makeResult = (token: string): DeepbridFinderResult => ({
    token,
    title: token,
    category: '',
    categoryName: '',
    kind: '',
    size: 1,
    sizeHuman: '',
    date: '',
    sources: 1,
  });
  const client = {
    searchPage: async (_query: string, options: { offset?: number }) => {
      const offset = options.offset ?? 0;
      calls.push(offset);
      if (offset === 0) {
        return {
          results: Array.from({ length: 50 }, (_, index) =>
            makeResult(`partial-retry-${index}`)
          ),
          rawCount: 50,
          invalidCount: 0,
        };
      }
      throw new TypeError('fetch failed');
    },
  } as unknown as DeepbridFinderClient;
  let outcome: DeepbridFinderPaginationOutcome | undefined;

  const results = await searchDeepbridFinderPages(client, 'sample title', {
    deadline: Date.now() + 10_000,
    onOutcome: (value) => (outcome = value),
  });

  assert.deepEqual(calls, [0, 50, 50, 50]);
  assert.equal(results.length, 50);
  assert.deepEqual(outcome, {
    pagesFetched: 1,
    pageRetries: 2,
    resultCount: 50,
    invalidResultCount: 0,
    termination: 'page-error',
  });
  assert.equal(summarizeDeepbridPagination([outcome!]).incompleteQueries, 1);
});

test('Deepbrid Finder continues after malformed rows in a full provider page', async () => {
  const offsets: number[] = [];
  const makeResult = (token: string): DeepbridFinderResult => ({
    token,
    title: token,
    category: '',
    categoryName: '',
    kind: '',
    size: 1,
    sizeHuman: '',
    date: '',
    sources: 1,
  });
  const client = {
    searchPage: async (_query: string, options: { offset?: number }) => {
      const offset = options.offset ?? 0;
      offsets.push(offset);
      if (offset === 0) {
        return {
          results: Array.from({ length: 49 }, (_, index) =>
            makeResult(`valid-${index}`)
          ),
          rawCount: 50,
          invalidCount: 1,
        };
      }
      if (offset === 50) {
        return {
          results: [makeResult('later-valid')],
          rawCount: 1,
          invalidCount: 0,
        };
      }
      return { results: [], rawCount: 0, invalidCount: 0 };
    },
  } as unknown as DeepbridFinderClient;

  const results = await searchDeepbridFinderPages(client, 'sample title', {
    deadline: Date.now() + 10_000,
  });
  assert.deepEqual(offsets, [0, 50, 100]);
  assert.equal(results.length, 50);
  assert.equal(
    results.some((result) => result.token === 'later-valid'),
    true
  );
});

test('Deepbrid Finder keeps paging through all-invalid pages until an empty page', async () => {
  const offsets: number[] = [];
  const client = {
    searchPage: async (_query: string, options: { offset?: number }) => {
      const offset = options.offset ?? 0;
      offsets.push(offset);
      return offset < 150
        ? { results: [], rawCount: 50, invalidCount: 50 }
        : { results: [], rawCount: 0, invalidCount: 0 };
    },
  } as unknown as DeepbridFinderClient;
  let outcome: DeepbridFinderPaginationOutcome | undefined;

  const results = await searchDeepbridFinderPages(client, 'sample title', {
    deadline: Date.now() + 10_000,
    onOutcome: (value) => (outcome = value),
  });

  assert.deepEqual(offsets, [0, 50, 100, 150]);
  assert.deepEqual(results, []);
  assert.deepEqual(outcome, {
    pagesFetched: 4,
    pageRetries: 0,
    resultCount: 0,
    invalidResultCount: 150,
    termination: 'no-more-results',
  });
});

test('Deepbrid Finder continues after a duplicate-only page and emits discovery before fetching the next page', async () => {
  const events: string[] = [];
  const makeResult = (token: string): DeepbridFinderResult => ({
    token,
    title: token,
    category: '',
    categoryName: '',
    kind: '',
    size: 1,
    sizeHuman: '',
    date: '',
    sources: 1,
  });
  const firstPage = Array.from({ length: 50 }, (_, index) =>
    makeResult(`duplicate-${index}`)
  );
  const client = {
    searchPage: async (_query: string, options: { offset?: number }) => {
      const offset = options.offset ?? 0;
      events.push(`request:${offset}`);
      if (offset === 0)
        return { results: firstPage, rawCount: 50, invalidCount: 0 };
      if (offset === 50)
        return { results: firstPage, rawCount: 50, invalidCount: 0 };
      if (offset === 100) {
        return {
          results: [makeResult('after-duplicate')],
          rawCount: 1,
          invalidCount: 0,
        };
      }
      return { results: [], rawCount: 0, invalidCount: 0 };
    },
  } as unknown as DeepbridFinderClient;

  const results = await searchDeepbridFinderPages(client, 'sample title', {
    deadline: Date.now() + 10_000,
    onPage: ({ offset, results }) =>
      events.push(`discovered:${offset}:${results.length}`),
  });

  assert.deepEqual(events.slice(0, 3), [
    'request:0',
    'discovered:0:50',
    'request:50',
  ]);
  assert.equal(results.length, 51);
  assert.equal(results.at(-1)?.token, 'after-duplicate');
});

test('progressive page resolution completes while a later Finder page is still blocked', async () => {
  let completeFirstResolution!: () => void;
  const firstResolution = new Promise<void>((resolve) => {
    completeFirstResolution = resolve;
  });
  let finalPageRequested = false;
  const queue = new DeepbridProgressiveResolutionQueue<string>();
  const client = {
    searchPage: async (_query: string, options: { offset?: number }) => {
      const offset = options.offset ?? 0;
      if (offset === 0) {
        return {
          results: [
            {
              token: 'early-candidate',
              title: 'Early candidate',
              category: '',
              categoryName: '',
              kind: '',
              size: 1,
              sizeHuman: '',
              date: '',
              sources: 1,
            },
          ],
          rawCount: 1,
          invalidCount: 0,
        };
      }
      finalPageRequested = true;
      await firstResolution;
      return { results: [], rawCount: 0, invalidCount: 0 };
    },
  } as unknown as DeepbridFinderClient;

  const search = searchDeepbridFinderPages(client, 'sample', {
    deadline: Date.now() + 10_000,
    onPage: ({ results }) => {
      return queue.enqueue(
        results.map((result) => result.token),
        async (batch) => {
          completeFirstResolution();
          return batch.map((token) => `resolved:${token}`);
        }
      );
    },
  });
  await search;
  const { resolved, failures } = await queue.drain();

  assert.equal(finalPageRequested, true);
  assert.deepEqual(resolved, ['resolved:early-candidate']);
  assert.deepEqual(failures, []);
});

test('progressive resolution keeps earlier results after a later batch fails', async () => {
  const queue = new DeepbridProgressiveResolutionQueue<string>();
  queue.enqueue(['first'], async () => ['resolved:first']);
  queue.enqueue(['second'], async () => {
    throw new Error('test failure');
  });

  const result = await queue.drain();
  assert.deepEqual(result.resolved, ['resolved:first']);
  assert.equal(result.failures.length, 1);
});

test('progressive resolution applies bounded backpressure to pending candidates', async () => {
  let releaseFirst!: () => void;
  const firstWork = new Promise<void>((resolve) => (releaseFirst = resolve));
  let secondAccepted = false;
  const queue = new DeepbridProgressiveResolutionQueue<string>();
  const first = queue.enqueue(
    Array.from({ length: 150 }, () => 'first'),
    async () => {
      await firstWork;
      return [];
    }
  );
  await Promise.resolve();
  const second = queue.enqueue(
    Array.from({ length: 100 }, () => 'second'),
    async () => {
      secondAccepted = true;
      return [];
    }
  );
  await Promise.resolve();
  assert.equal(secondAccepted, false);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(secondAccepted, true);
  assert.deepEqual(await queue.drain(), {
    resolved: [],
    failures: [],
    failedBatchCount: 0,
  });
});

test('Deepbrid Finder reports deadline pagination while retaining prior pages', async () => {
  let now = 0;
  const client = {
    searchPage: async () => {
      now = 1_000;
      return {
        results: Array.from({ length: 50 }, (_, index) => ({
          token: `deadline-${index}`,
          title: `deadline-${index}`,
          category: '',
          categoryName: '',
          kind: '',
          size: 1,
          sizeHuman: '',
          date: '',
          sources: 1,
        })),
        rawCount: 50,
        invalidCount: 0,
      };
    },
  } as unknown as DeepbridFinderClient;
  let outcome: DeepbridFinderPaginationOutcome | undefined;
  const results = await searchDeepbridFinderPages(client, 'sample title', {
    deadline: 1_500,
    now: () => now,
    onOutcome: (value) => (outcome = value),
  });

  assert.equal(results.length, 50);
  assert.deepEqual(outcome, {
    pagesFetched: 1,
    pageRetries: 0,
    resultCount: 50,
    invalidResultCount: 0,
    termination: 'deadline',
  });
});

test('Deepbrid queued requests use the remaining deadline budget at execution time', async () => {
  let receivedTimeout = 0;
  const result = await runWithinDeepbridRequestBudget(
    20_000,
    () => 15_000,
    undefined,
    async (timeoutMs) => {
      receivedTimeout = timeoutMs;
      return 'ok';
    }
  );

  assert.equal(result, 'ok');
  assert.equal(receivedTimeout, 5_000);
});

test('Deepbrid queued requests do not start after the request budget expires', async () => {
  let called = false;
  await assert.rejects(
    runWithinDeepbridRequestBudget(
      1_000,
      () => 500,
      undefined,
      async () => {
        called = true;
        return 'unexpected';
      }
    ),
    { name: 'AbortError' }
  );
  assert.equal(called, false);
});

test('Deepbrid queued requests recalculate their timeout after waiting in the queue', async () => {
  let now = 1_000;
  let receivedTimeout = 0;
  const queued = async <T>(task: () => Promise<T>): Promise<T> => {
    now = 8_500;
    return task();
  };

  const result = await runQueuedDeepbridRequest(
    10_000,
    () => now,
    undefined,
    queued,
    async (remainingMs) => {
      receivedTimeout = remainingMs;
      return 'ok';
    }
  );

  assert.equal(result, 'ok');
  assert.equal(receivedTimeout, 1_500);
});

test('Deepbrid queued requests never start after expiring in the queue', async () => {
  let now = 1_000;
  let called = false;
  const queued = async <T>(task: () => Promise<T>): Promise<T> => {
    now = 9_300;
    return task();
  };

  await assert.rejects(
    runQueuedDeepbridRequest(
      10_000,
      () => now,
      undefined,
      queued,
      async () => {
        called = true;
        return 'unexpected';
      }
    ),
    { name: 'AbortError' }
  );
  assert.equal(called, false);
});

test('Deepbrid pagination summary distinguishes complete and incomplete terminations', () => {
  assert.deepEqual(
    summarizeDeepbridPagination([
      {
        pagesFetched: 2,
        pageRetries: 0,
        resultCount: 51,
        invalidResultCount: 0,
        termination: 'no-more-results',
      },
      {
        pagesFetched: 1,
        pageRetries: 0,
        resultCount: 50,
        invalidResultCount: 0,
        termination: 'page-error',
      },
      {
        pagesFetched: 1,
        pageRetries: 0,
        resultCount: 50,
        invalidResultCount: 0,
        termination: 'deadline',
      },
    ]),
    {
      pagesFetched: 4,
      pageRetries: 0,
      invalidResultCount: 0,
      incompleteQueries: 2,
      terminationCounts: {
        'no-more-results': 1,
        deadline: 1,
        aborted: 0,
        'page-error': 1,
        'repeated-page': 0,
        'invalid-page-limit': 0,
      },
    }
  );
});

test('returns partial Deepbrid results when another content lookup fails', async () => {
  const ranked = ['good', 'slow'].map((token) => ({
    result: {
      token,
      title: token,
      category: '',
      categoryName: '',
      kind: '',
      size: 1,
      sizeHuman: '',
      date: '',
      sources: 1,
    },
    score: 100,
    confirmed: true,
  }));

  const resolved = await resolveDeepbridFiles(
    ranked,
    { type: 'movie' },
    {
      concurrency: 2,
      maxResults: 10,
      deadline: Date.now() + 10_000,
      getContent: async (token) => {
        if (token === 'slow')
          throw new DOMException('timed out', 'TimeoutError');
        return {
          title: token,
          files: [
            {
              name: `${token}.mkv`,
              link: `https://storage.example/${token}.mkv`,
              size: 1,
              sizeHuman: '',
            },
          ],
          hasPassword: false,
          password: '',
        };
      },
    }
  );

  assert.deepEqual(
    resolved.map((item) => item.file.name),
    ['good.mkv']
  );
});

test('drops failed playback probes and continues into later batches', async () => {
  const calls: string[] = [];
  const ranked = ['dead', 'working'].map((token) => ({
    result: {
      token,
      title: token,
      category: '',
      categoryName: '',
      kind: '',
      size: 1,
      sizeHuman: '',
      date: '',
      sources: 1,
    },
    score: 100,
    confirmed: true,
  }));
  const resolved = await resolveDeepbridFiles(
    ranked,
    { type: 'movie' },
    {
      concurrency: 1,
      maxResults: 1,
      deadline: Date.now() + 10_000,
      getContent: async (token) => ({
        title: token,
        files: [
          {
            name: `${token}.mkv`,
            link: `https://usenet-2.myfast.link/${token}.mkv`,
            size: 1,
            sizeHuman: '',
          },
        ],
        hasPassword: false,
        password: '',
      }),
      probeFile: async (file) => {
        calls.push(file.name);
        return file.name === 'working.mkv';
      },
    }
  );
  assert.deepEqual(calls, ['dead.mkv', 'working.mkv']);
  assert.deepEqual(
    resolved.map((item) => item.file.name),
    ['working.mkv']
  );
});

test('does not begin another Deepbrid batch after its deadline budget is spent', async () => {
  let now = 1_000;
  const calls: string[] = [];
  const ranked = ['first', 'second'].map((token) => ({
    result: {
      token,
      title: token,
      category: '',
      categoryName: '',
      kind: '',
      size: 1,
      sizeHuman: '',
      date: '',
      sources: 1,
    },
    score: 100,
    confirmed: true,
  }));

  const resolved = await resolveDeepbridFiles(
    ranked,
    { type: 'movie' },
    {
      concurrency: 1,
      maxResults: 10,
      deadline: 3_000,
      now: () => now,
      getContent: async (token) => {
        calls.push(token);
        now = 2_500;
        return {
          title: token,
          files: [],
          hasPassword: false,
          password: '',
        };
      },
    }
  );

  assert.deepEqual(calls, ['first']);
  assert.deepEqual(resolved, []);
});
