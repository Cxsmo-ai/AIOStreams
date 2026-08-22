import assert from 'node:assert/strict';
import test from 'node:test';
import type { Addon, Stream, UserData } from '../db/index.js';
import { constants } from '../utils/index.js';
import { applyMigrations } from '../utils/config.js';
import {
  buildTorrentClawHeaders,
  getTorrentClawServiceConfig,
  isTrustedTorrentClawUrl,
  isUnsafeTorrentClawStream,
  matchTorrentClawTorrent,
  type TorrentClawApiTorrent,
} from './torrentclaw-api.js';
import { TorrentClawStreamParser } from './torrentclaw.js';

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
