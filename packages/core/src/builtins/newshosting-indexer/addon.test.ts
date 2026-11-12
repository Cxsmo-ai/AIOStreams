import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import {
  buildNewshostingQueries,
  decodeNewshostingNzbId,
  encodeNewshostingNzbId,
  matchesNewshostingEpisode,
  rankNewshostingResult,
  searchNewshostingQueries,
} from './addon.js';
import {
  buildNewshostingNzb,
  decodeNewshostingXmlText,
  isOfficialNewshostingFinderEndpoint,
  NEWSHOSTING_FINDER_CERT_FINGERPRINT,
  parseNewshostingGroups,
  validateNewshostingFinderFingerprint,
} from './client.js';
import { decodeNewshostingFrame, encodeNewshostingFrame } from './protocol.js';
import {
  parseNewshostingRelease,
  scoreNewshostingReleaseMatch,
} from './release.js';
import {
  isConfigProxyRequestAllowed,
  issueConfigProxyGrant,
  verifyConfigProxyGrant,
} from '../../utils/index.js';

test('round-trips the proprietary compressed XML frame', async () => {
  const xml = '<response><login valid="true"/></response>';
  const stream = new PassThrough();
  stream.end(encodeNewshostingFrame(xml));
  assert.equal(await decodeNewshostingFrame(stream, 1_000), xml);
});

test('parses Newshosting group search results', () => {
  const parsed = parseNewshostingGroups(
    '<response><groups items="1" pages="1"><group size="1234" files="2" timestamp="2026-01-02T03:04:05Z" media-category="TV"><id index="idx" scope="scope" item="item"/><title>The.Mentalist.S01E01.1080p.WEB-DL.mkv</title><author>poster</author></group></groups></response>'
  );
  assert.equal(parsed.totalItems, 1);
  assert.deepEqual(parsed.results[0], {
    name: 'The.Mentalist.S01E01.1080p.WEB-DL.mkv',
    size: 1234,
    date: '2026-01-02T03:04:05Z',
    files: 2,
    category: 'TV',
    author: 'poster',
    index: 'idx',
    scope: 'scope',
    itemId: 'item',
  });
});

test('builds valid escaped NZB XML', () => {
  const nzb = buildNewshostingNzb(
    [
      {
        name: 'Episode & One.mkv',
        author: 'poster@example',
        timestamp: '2026-01-02T03:04:05Z',
        articles: [{ number: 1, bytes: 42, messageId: 'part&one@example' }],
      },
    ],
    ['alt.binaries.test']
  );
  assert.match(nzb, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(nzb, /Episode &amp; One\.mkv/);
  assert.match(nzb, /part&amp;one@example/);
});

test('decodes Newshosting XML entities before building article ids', () => {
  assert.equal(
    decodeNewshostingXmlText('&lt;part&amp;one&#64;example&gt;'),
    '<part&one@example>'
  );
  assert.equal(decodeNewshostingXmlText('part&#x40;example'), 'part@example');
});

test('pins only the exact official Newshosting Finder endpoint', () => {
  assert.equal(
    isOfficialNewshostingFinderEndpoint({
      host: 'srv.aboutusenet.com',
      ip: '81.171.93.8',
      port: 5598,
    }),
    true
  );
  assert.equal(
    isOfficialNewshostingFinderEndpoint({
      host: 'srv.aboutusenet.com',
      ip: '81.171.93.9',
      port: 5598,
    }),
    false
  );
  assert.equal(
    isOfficialNewshostingFinderEndpoint({
      host: 'custom.example',
      ip: '81.171.93.8',
      port: 5598,
    }),
    false
  );
});

test('accepts only the pinned Newshosting Finder certificate fingerprint', () => {
  assert.doesNotThrow(() =>
    validateNewshostingFinderFingerprint(NEWSHOSTING_FINDER_CERT_FINGERPRINT)
  );
  assert.throws(
    () =>
      validateNewshostingFinderFingerprint(
        '00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00'
      ),
    /fingerprint_mismatch/
  );
  assert.throws(
    () => validateNewshostingFinderFingerprint(undefined),
    /fingerprint_mismatch/
  );
});

test('builds the proven episode-first search plan', () => {
  assert.deepEqual(
    buildNewshostingQueries(
      {
        title: 'The Mentalist',
        aliases: ['The Mentalist'],
        year: 2008,
      },
      { type: 'series', season: 1, episode: 1 }
    ),
    ['The Mentalist S01E01', 'The Mentalist S01', 'The Mentalist']
  );
});

test('scores exact episodes above mismatched episodes', () => {
  const metadata = {
    title: 'The Mentalist',
    aliases: ['The Mentalist'],
    year: 2008,
    countries: ['US'],
  };
  const media = { type: 'series' as const, season: 1, episode: 1 };
  const exactTitle = 'The.Mentalist.S01E01.1080p.WEB-DL-GROUP';
  const wrongTitle = 'The.Mentalist.S01E02.1080p.WEB-DL-GROUP';
  const exact = scoreNewshostingReleaseMatch(
    exactTitle,
    media,
    parseNewshostingRelease(exactTitle),
    metadata
  );
  const wrong = scoreNewshostingReleaseMatch(
    wrongTitle,
    media,
    parseNewshostingRelease(wrongTitle),
    metadata
  );
  assert.ok(exact.score >= 650);
  assert.ok(exact.score > wrong.score);
});

test('scores release quality and explains sequel year and edition matches', () => {
  const metadata = {
    title: 'Example Movie',
    aliases: ['Example: The Return'],
    year: 2024,
    edition: "director's cut",
  };
  const media = { type: 'movie' as const };
  const preferredTitle =
    'Example.The.Return.2024.Directors.Cut.2160p.TrueHD.Atmos.7.1.24GB.mkv';
  const otherSequel = 'Example.The.Return.2014.Theatrical.720p.AAC.1.2GB.mkv';
  const preferred = scoreNewshostingReleaseMatch(
    preferredTitle,
    media,
    parseNewshostingRelease(preferredTitle),
    metadata
  );
  const other = scoreNewshostingReleaseMatch(
    otherSequel,
    media,
    parseNewshostingRelease(otherSequel),
    metadata
  );

  assert.equal(
    parseNewshostingRelease(preferredTitle).edition,
    'directors-cut'
  );
  assert.ok(preferred.score > other.score);
  assert.equal(preferred.confidence, 'high');
  assert.ok(preferred.reason.includes('year'));
  assert.ok(preferred.reason.includes('edition'));
  assert.ok(preferred.signals.audio > 0);
  assert.ok(preferred.signals.size > 0);
});

test('does not claim an untagged requested edition is confirmed', () => {
  const metadata = {
    title: 'Example Movie',
    aliases: ['Example: The Return'],
    year: 2024,
    edition: "director's cut",
  };
  const title =
    'Example.The.Return.2024.2160p.BluRay.TrueHD.Atmos.7.1.14GB.mkv';
  const match = scoreNewshostingReleaseMatch(
    title,
    { type: 'movie' },
    parseNewshostingRelease(title),
    metadata
  );

  assert.equal(match.signals.edition, -120);
  assert.ok(match.reason.includes('edition-unconfirmed'));
  assert.notEqual(match.confidence, 'high');
});

test('normalizes combined HDR and language tags without promoting them to media facts', () => {
  const release = parseNewshostingRelease(
    'Example.Movie.2024.2160p.DV.HDR10+.TrueHD.Atmos.7.1.English.mkv'
  );
  assert.deepEqual(release.hdrFormats, ['HDR10+', 'DV']);
  assert.deepEqual(release.languages, ['en']);
  assert.equal(release.audioChannels, '7.1');
  assert.equal(release.hdr, 'HDR10+');
  assert.deepEqual(
    parseNewshostingRelease('Example.Movie.DV.HDR10.HDR10+.mkv').hdrFormats,
    ['HDR10+', 'DV', 'HDR10']
  );
});

test('round-trips validated NZB result ids and rejects malformed ids', () => {
  const result = {
    name: 'The.Mentalist.S01E01.1080p.WEB-DL.mkv',
    size: 1_000_000_000,
    date: '2026-01-02T03:04:05Z',
    files: 2,
    category: 'TV',
    author: 'poster',
    index: 'idx',
    scope: 'scope',
    itemId: 'item',
  };
  assert.deepEqual(decodeNewshostingNzbId(encodeNewshostingNzbId(result)), {
    index: 'idx',
    scope: 'scope',
    itemId: 'item',
    title: result.name,
    files: 2,
  });
  assert.throws(() => decodeNewshostingNzbId('not-valid'));
});

test('applies file-count and playable-video ranking signals', () => {
  const base = {
    name: 'Movie.2026.1080p.WEB-DL.mkv',
    size: 5 * 1_073_741_824,
    date: '',
    category: 'Movie',
    author: '',
    index: 'idx',
    scope: 'scope',
    itemId: 'item',
  };
  assert.ok(
    rankNewshostingResult({ ...base, files: 1 }, 800) >
      rankNewshostingResult({ ...base, files: 30 }, 800)
  );
});

test('parses immersive surround layouts and object-audio tags from release names', () => {
  const release = parseNewshostingRelease(
    'Example.Movie.2026.2160p.WEB-DL.DDP5.1.2.Atmos.DV-GROUP'
  );

  assert.equal(release.resolution, '2160p');
  assert.equal(release.audioChannels, '5.1.2');
  assert.ok(release.audioFormats?.some((format) => /DDP5\.1/i.test(format)));
  assert.equal(release.hdr, 'DV');
});

test('parses DTS:X and 7.1.4 without treating channel tags as title words', () => {
  const release = parseNewshostingRelease(
    'Example.Show.S01E02.1080p.BluRay.TrueHD.DTS-X.7.1.4-GROUP'
  );

  assert.equal(release.audioChannels, '7.1.4');
  assert.ok(release.audioFormats?.some((format) => /DTS[. -]*X/i.test(format)));
  assert.equal(release.normalizedTitle, 'example show');
});

test('keeps requested episodes and season packs while rejecting explicit mismatches', () => {
  const episode = { type: 'series', season: 1, episode: 1 } as const;
  assert.equal(
    matchesNewshostingEpisode(
      parseNewshostingRelease('Tower Prep - 1x01'),
      episode
    ),
    true
  );
  assert.equal(
    matchesNewshostingEpisode(
      parseNewshostingRelease('Tower Prep - 1x09'),
      episode
    ),
    false
  );
  assert.equal(
    matchesNewshostingEpisode(
      parseNewshostingRelease('Tower.Prep.S01.Complete.720p'),
      episode
    ),
    true
  );
  assert.equal(
    matchesNewshostingEpisode(
      parseNewshostingRelease('Tower Prep HDTV'),
      episode
    ),
    true
  );
});

test('keeps successful Newshosting query results when another query fails', async () => {
  let created = 0;
  let closed = 0;
  const successful = {
    name: 'Game.of.Thrones.S01E01.1080p.WEB-DL.mkv',
    size: 4_000_000_000,
    date: '2026-01-02T03:04:05Z',
    files: 1,
    category: 'TV',
    author: 'poster',
    index: 'idx',
    scope: 'scope',
    itemId: 'item',
  };

  const result = await searchNewshostingQueries(
    ['exact', 'broad'],
    () => {
      const index = created++;
      return {
        async connect() {},
        async search() {
          if (index === 1) throw new Error('temporary_search_failure');
          return { results: [successful] };
        },
        close() {
          closed += 1;
        },
      };
    },
    1_000
  );

  assert.deepEqual(result.results, [successful]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /temporary_search_failure/);
  assert.equal(closed, 2);
});

test('binds Newshosting grants to only the protected NZB route', () => {
  const token = issueConfigProxyGrant(
    'newshosting-config-a',
    'newshosting-nzb',
    'https://aio.example'
  );
  const grant = verifyConfigProxyGrant(token);
  assert.ok(grant);
  const configToken = 'A'.repeat(64);
  const resultToken = 'B'.repeat(32);
  assert.equal(
    isConfigProxyRequestAllowed(grant, {
      url: `https://aio.example/builtins/newshosting-indexer/${configToken}/nzb/${resultToken}`,
      type: 'nzb',
    }),
    true
  );
  assert.equal(
    isConfigProxyRequestAllowed(grant, {
      url: `https://evil.example/builtins/newshosting-indexer/${configToken}/nzb/${resultToken}`,
      type: 'nzb',
    }),
    false
  );
  assert.equal(
    isConfigProxyRequestAllowed(grant, {
      url: `https://aio.example/builtins/newshosting-indexer/${configToken}/stream/${resultToken}`,
      type: 'nzb',
    }),
    false
  );
  assert.equal(
    isConfigProxyRequestAllowed(grant, {
      url: `https://aio.example/builtins/newshosting-indexer/${configToken}/nzb/${resultToken}`,
      type: 'stream',
    }),
    false
  );
});
