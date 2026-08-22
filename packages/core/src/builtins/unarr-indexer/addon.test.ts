import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildUnarrSearchParams,
  collectUnarrSearchResults,
  connectUnarr,
  parseUnarrSearchResponse,
  unarrQuotaMetadata,
  validateUnarrApiUrl,
} from './addon.js';
import type { ParsedId } from '../../utils/id-parser.js';
import {
  issueUnarrConfigProxyGrant,
  UnarrIndexerStreamParser,
} from '../../presets/unarrIndexer.js';
import type { Addon, ParsedStream, Stream } from '../../db/index.js';
import {
  isConfigProxyRequestAllowed,
  issueConfigProxyGrant,
  verifyConfigProxyGrant,
} from '../../utils/index.js';

const unarrResult = (
  nzbId: string,
  overrides: Record<string, unknown> = {}
) => ({
  title: `Release ${nzbId}`,
  nzbId,
  category: '',
  size: 1_000,
  publishedAt: '',
  grabs: 0,
  group: '',
  poster: '',
  attributes: {},
  ...overrides,
});

class TestUnarrParser extends UnarrIndexerStreamParser {
  service(stream: Stream | string) {
    return this.getService(
      typeof stream === 'string' ? ({ name: stream } as Stream) : stream,
      {} as ParsedStream
    );
  }
  extras(stream: Stream, parsed: ParsedStream) {
    return this.getExtras(stream, parsed);
  }
  folderSize(stream: Stream, parsed: ParsedStream) {
    return this.getFolderSize(stream, parsed);
  }
  releaseGroup(stream: Stream, parsed: ParsedStream) {
    return this.getReleaseGroup(stream, parsed);
  }
  indexer() {
    return this.getIndexer();
  }
}

test('uses the actual Usenet resolver in TorrentClaw stream badges', () => {
  const parser = new TestUnarrParser({
    name: 'TorrentClaw Usenet',
    instanceId: 'unarr-service-test',
    preset: { id: 'test', type: 'unarr-indexer', options: {} },
  } as Addon);

  for (const [id, shortName] of [
    ['torbox', 'TB'],
    ['deepbrid', 'DB'],
    ['aiostreams', 'AIO'],
  ] as const) {
    assert.deepEqual(
      parser.service({
        name: `[${shortName} ⚡] TorrentClaw Usenet`,
        aioResolver: { id, cached: true },
      } as Stream),
      { id, cached: true }
    );
  }
});

test('uses the leading resolver badge for older built-in stream responses', () => {
  const parser = new TestUnarrParser({
    name: 'TorrentClaw Usenet',
    instanceId: 'unarr-legacy-service-test',
    preset: { id: 'test', type: 'unarr-indexer', options: {} },
  } as Addon);

  assert.deepEqual(parser.service('[TB ⚡] TorrentClaw Usenet'), {
    id: 'torbox',
    cached: true,
  });
  assert.deepEqual(parser.service('[AIO ⚡] TorrentClaw Usenet'), {
    id: 'aiostreams',
    cached: true,
  });
});

test('preserves TorBox uncached state for Cache and Play behavior', () => {
  const parser = new TestUnarrParser({
    name: 'TorrentClaw Usenet',
    instanceId: 'unarr-cache-play-test',
    preset: { id: 'test', type: 'unarr-indexer', options: {} },
  } as Addon);

  assert.deepEqual(
    parser.service({
      name: '[TB ⏳] TorrentClaw Usenet',
      aioResolver: { id: 'torbox', cached: false },
    } as Stream),
    { id: 'torbox', cached: false }
  );
});

const parsedEpisode: ParsedId = {
  type: 'imdbId',
  value: 'tt1196946',
  fullId: 'tt1196946:1:1',
  externalType: 'imdb_id',
  mediaType: 'series',
  season: '1',
  episode: '1',
  generator: (value, season, episode) => `${value}:${season}:${episode}`,
};

test('builds Unarr episode search with IDs, query, and season mapping', () => {
  assert.deepEqual(
    buildUnarrSearchParams(
      parsedEpisode,
      {
        primaryTitle: 'The Mentalist',
        titles: ['The Mentalist'],
        year: 2008,
        imdbId: 'tt1196946',
        tvdbId: 82459,
        season: 1,
        episode: 1,
      },
      30
    ),
    {
      query: 'The Mentalist 2008',
      imdbId: 'tt1196946',
      tvdbId: '82459',
      season: 1,
      episode: 1,
      limit: 30,
    }
  );
});

test('uses the parsed IMDb ID when metadata has no external ID', () => {
  assert.equal(
    buildUnarrSearchParams(parsedEpisode, { titles: ['The Mentalist'] }, 10)
      .imdbId,
    'tt1196946'
  );
});

test('normalizes nullable text and primitive Unarr attributes', () => {
  const parsed = parseUnarrSearchResponse({
    results: [
      {
        title: 'A release',
        nzbId: 'nzb-1',
        category: null,
        publishedAt: null,
        group: null,
        poster: null,
        attributes: {
          codec: 'HEVC',
          files: 42,
          passworded: false,
          ignored: null,
        },
        futureField: { safely: 'ignored' },
      },
    ],
  });

  assert.deepEqual(parsed.results[0], {
    title: 'A release',
    nzbId: 'nzb-1',
    category: '',
    size: 0,
    publishedAt: '',
    grabs: 0,
    group: '',
    poster: '',
    attributes: {
      codec: 'HEVC',
      files: '42',
      passworded: 'false',
    },
  });
  assert.equal(parsed.rawResultCount, 1);
});

test('keeps valid Unarr results when another result is malformed', () => {
  const invalidIndexes: number[] = [];
  const parsed = parseUnarrSearchResponse(
    {
      results: [
        { title: 'Missing its NZB id' },
        { title: 'Valid release', nzbId: 'valid', size: 1234 },
      ],
      total: 2,
      offset: 0,
    },
    ({ index }) => invalidIndexes.push(index)
  );

  assert.deepEqual(invalidIndexes, [0]);
  assert.equal(parsed.rawResultCount, 2);
  assert.deepEqual(
    parsed.results.map((result) => result.nzbId),
    ['valid']
  );
});

test('collects overlapping Unarr pages without duplicates and preserves rank', async () => {
  const calls: Array<{ offset: number; limit: number }> = [];
  const pages = [
    {
      results: [unarrResult('a'), unarrResult('b')],
      total: 4,
      offset: 0,
    },
    {
      results: [unarrResult('b'), unarrResult('c')],
      total: 4,
      offset: 2,
    },
  ];

  const results = await collectUnarrSearchResults(3, async (offset, limit) => {
    calls.push({ offset, limit });
    return pages[calls.length - 1];
  });

  assert.deepEqual(
    results.map((result) => result.nzbId),
    ['a', 'b', 'c']
  );
  assert.deepEqual(calls, [
    { offset: 0, limit: 3 },
    { offset: 2, limit: 1 },
  ]);
});

test('continues past unusable Unarr results to fill the configured maximum', async () => {
  const offsets: number[] = [];
  const results = await collectUnarrSearchResults(
    2,
    async (offset) => {
      offsets.push(offset);
      return offset === 0
        ? {
            results: [
              unarrResult('too-large', { size: 10_000 }),
              unarrResult('usable-a'),
            ],
            total: 4,
            offset: 0,
          }
        : {
            results: [unarrResult('usable-b'), unarrResult('usable-c')],
            total: 4,
            offset: 2,
          };
    },
    { isUsable: (result) => result.size <= 5_000 }
  );

  assert.deepEqual(offsets, [0, 2]);
  assert.deepEqual(
    results.map((result) => result.nzbId),
    ['usable-a', 'usable-b']
  );
});

test('can fill a one-result target from a later Unarr page', async () => {
  const offsets: number[] = [];
  const results = await collectUnarrSearchResults(
    1,
    async (offset) => {
      offsets.push(offset);
      return offset === 0
        ? {
            results: [unarrResult('unusable', { size: 10_000 })],
            total: 2,
            offset: 0,
          }
        : {
            results: [unarrResult('usable')],
            total: 2,
            offset: 1,
          };
    },
    { isUsable: (result) => result.size <= 5_000 }
  );

  assert.deepEqual(offsets, [0, 1]);
  assert.deepEqual(
    results.map((result) => result.nzbId),
    ['usable']
  );
});

test('returns earlier Unarr pages when a later page fails', async () => {
  const partialFailures: Array<{ page: number; offset: number }> = [];
  const results = await collectUnarrSearchResults(
    3,
    async (offset) => {
      if (offset > 0) throw new Error('temporary upstream failure');
      return {
        results: [unarrResult('a'), unarrResult('b')],
        total: 4,
        offset: 0,
      };
    },
    {
      onPartialFailure: (_error, context) => partialFailures.push(context),
    }
  );

  assert.deepEqual(
    results.map((result) => result.nzbId),
    ['a', 'b']
  );
  assert.deepEqual(partialFailures, [{ page: 2, offset: 2 }]);
});

test('throws when the first Unarr search page fails', async () => {
  await assert.rejects(
    collectUnarrSearchResults(3, async () => {
      throw new Error('initial failure');
    }),
    /initial failure/
  );
});

test('stops if Unarr repeats an identical page while ignoring offsets', async () => {
  let calls = 0;
  const results = await collectUnarrSearchResults(5, async () => {
    calls += 1;
    return {
      results: [unarrResult('a'), unarrResult('b')],
      total: 100,
    };
  });

  assert.equal(calls, 2);
  assert.deepEqual(
    results.map((result) => result.nzbId),
    ['a', 'b']
  );
});

test('allows only the official HTTPS Unarr host family', () => {
  assert.equal(validateUnarrApiUrl('https://unarr.app/'), 'https://unarr.app');
  assert.equal(
    validateUnarrApiUrl('https://api.unarr.app/'),
    'https://api.unarr.app'
  );
  assert.throws(() => validateUnarrApiUrl('http://unarr.app'));
  assert.throws(() => validateUnarrApiUrl('https://unarr.app.example.com'));
});

test('fully bypasses local quota metadata when the ceiling is disabled', () => {
  assert.deepEqual(unarrQuotaMetadata(false, 'release-key', 42), {
    indexer: 'Unarr',
  });
  assert.deepEqual(unarrQuotaMetadata(true, 'release-key', 42), {
    indexer: 'TorrentClaw / Unarr',
    quotaReservationKey: 'release-key',
    quotaBytes: 42,
  });
});

test('rejects non-Unarr credentials before making a network request', async () => {
  await assert.rejects(
    connectUnarr({ apiUrl: 'https://unarr.app', credential: 'not-a-key' }),
    /tc_|unarr-authkey-/
  );
});

test('issues deterministic, isolated per-config proxy grants', () => {
  const first = issueConfigProxyGrant(
    'preset-instance-a',
    'unarr-nzb',
    'https://unarr.app'
  );
  const repeated = issueConfigProxyGrant(
    'preset-instance-a',
    'unarr-nzb',
    'https://unarr.app'
  );
  const second = issueConfigProxyGrant(
    'preset-instance-b',
    'unarr-nzb',
    'https://unarr.app'
  );

  assert.equal(first, repeated);
  assert.notEqual(first, second);
  assert.match(verifyConfigProxyGrant(first)?.identity ?? '', /^config:/);
});

test('rejects tampered or malformed config proxy grants', () => {
  const grant = issueConfigProxyGrant(
    'preset-instance-a',
    'unarr-nzb',
    'https://unarr.app'
  );
  const replacement = grant.endsWith('A') ? 'B' : 'A';
  assert.equal(verifyConfigProxyGrant(grant.slice(0, -1) + replacement), null);
  assert.equal(verifyConfigProxyGrant('pcg_not-a-grant'), null);
  assert.throws(() =>
    issueConfigProxyGrant('preset-instance-a', 'unarr-nzb', 'http://unarr.app')
  );
});

test('binds Unarr grants to NZB downloads on the signed origin', () => {
  const token = issueConfigProxyGrant(
    'preset-instance-a',
    'unarr-nzb',
    'https://unarr.app'
  );
  const grant = verifyConfigProxyGrant(token);
  assert.ok(grant);
  assert.equal(
    isConfigProxyRequestAllowed(grant, {
      url: 'https://unarr.app/api/internal/agent/nzb-download?nzbId=123',
      type: 'nzb',
    }),
    true
  );
  assert.equal(
    isConfigProxyRequestAllowed(grant, {
      url: 'https://unarr.app/api/internal/agent/nzb-download?nzbId=123',
      type: 'stream',
    }),
    false
  );
  assert.equal(
    isConfigProxyRequestAllowed(grant, {
      url: 'https://evil.example/api/internal/agent/nzb-download?nzbId=123',
      type: 'nzb',
    }),
    false
  );
  assert.equal(
    isConfigProxyRequestAllowed(grant, {
      url: 'https://unarr.app/api/internal/agent/me',
      type: 'nzb',
    }),
    false
  );
});

test('generates a per-config Unarr proxy grant without AIOSTREAMS_AUTH input', () => {
  const options = {
    name: 'Unarr test',
    unarrAuth: {
      apiUrl: 'https://unarr.app',
      apiKey: 'tc_test-only-key',
    },
  };
  const grant = issueUnarrConfigProxyGrant(
    'unarr-config-test',
    'https://unarr.app'
  );
  assert.match(grant, /^pcg_/);
  assert.ok(verifyConfigProxyGrant(grant));
  assert.equal(options.proxyAuth, undefined);
});

test('formats Unarr NZBs with TorrentClaw metadata and pack sizes', () => {
  const addon = {
    name: 'TorrentClaw Unarr',
    instanceId: 'unarr-test',
    preset: {
      id: 'test',
      type: 'unarr-indexer',
      options: { formatting: {} },
    },
  } as Addon;
  const stream = {
    behaviorHints: {
      folderSize: 10_000_000_000,
    },
    unarr: {
      grabs: 1234,
      category: 'TV > HD',
      group: 'GROUP',
    },
  } as Stream;
  const parsed = {
    service: { id: 'aiostreams', cached: true },
    library: false,
  } as ParsedStream;
  const parser = new TestUnarrParser(addon);

  assert.equal(parser.indexer(), 'TorrentClaw');
  assert.equal(parser.folderSize(stream, parsed), 10_000_000_000);
  assert.equal(parser.releaseGroup(stream, parsed), 'GROUP');
  assert.deepEqual(parser.extras(stream, parsed)?.formattingSuffix, [
    '🦞 Unarr · 1,234 grabs · TV > HD',
    '⚡ Cached',
  ]);
});

test('can hide pack size and optional Unarr formatting fields', () => {
  const addon = {
    name: 'TorrentClaw Unarr',
    instanceId: 'unarr-hidden-test',
    preset: {
      id: 'test',
      type: 'unarr-indexer',
      options: {
        formatting: {
          showEpisodeAndPackSizes: false,
          showGrabs: false,
          showCategory: false,
          showGroup: false,
        },
      },
    },
  } as Addon;
  const stream = {
    behaviorHints: { folderSize: 2_000_000_000 },
    unarr: { grabs: 99, category: 'Movies', group: 'GROUP' },
  } as Stream;
  const parsed = {
    service: { id: 'aiostreams', cached: false },
    library: false,
  } as ParsedStream;
  const parser = new TestUnarrParser(addon);

  assert.equal(parser.folderSize(stream, parsed), undefined);
  assert.equal(parser.releaseGroup(stream, parsed), undefined);
  assert.deepEqual(parser.extras(stream, parsed)?.formattingSuffix, [
    '🦞 Unarr',
    '⏳ Uncached',
  ]);
});
