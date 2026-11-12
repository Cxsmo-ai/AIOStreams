import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countInvalidPlaybackUrls,
  encodedFilenameCoverage,
  episodeModeSelectionPassed,
  episodeTargetMatch,
  isAllowedPlaybackUrl,
  isDeepbridFinderEntry,
  largestPlaybackEntryPerMode,
  mediaDecodePassed,
  normalizePlaybackMode,
  playbackAcceptancePassed,
  requestTimeoutMs,
  safeProbeErrorCategory,
  streamPlaybackMode,
} from './playback-safety.mjs';

test('playback URL allowlist pins origin, credentials, protocol and path boundaries', () => {
  const paths = ['/builtins/deepbrid-usenet/play/'];
  assert.equal(
    isAllowedPlaybackUrl(
      'https://example.test/builtins/deepbrid-usenet/play/a',
      'https://example.test',
      paths
    ),
    true
  );
  assert.equal(
    isAllowedPlaybackUrl(
      'https://example.test.evil/builtins/deepbrid-usenet/play/a',
      'https://example.test',
      paths
    ),
    false
  );
  assert.equal(
    isAllowedPlaybackUrl(
      'https://u:p@example.test/builtins/deepbrid-usenet/play/a',
      'https://example.test',
      paths
    ),
    false
  );
  assert.equal(
    isAllowedPlaybackUrl('file:///etc/passwd', 'https://example.test', ['/']),
    false
  );
  assert.equal(
    isAllowedPlaybackUrl(
      'https://example.test/builtins/deepbrid-usenet/playevil/a',
      'https://example.test',
      paths
    ),
    false
  );
});

test('Deepbrid Finder detection does not classify unrelated Deepbrid result services', () => {
  assert.equal(
    isDeepbridFinderEntry({ addon: { identifier: 'deepbrid-usenet' } }),
    true
  );
  assert.equal(
    isDeepbridFinderEntry({ name: 'Deepbrid Debrid result' }),
    false
  );
  assert.equal(
    isDeepbridFinderEntry({ behaviorHints: { addonId: 'deepbrid-usenet' } }),
    true
  );
});

test('playback modes normalize conservatively', () => {
  assert.equal(normalizePlaybackMode('HLS'), 'hls');
  assert.equal(normalizePlaybackMode('direct'), 'direct');
  assert.equal(streamPlaybackMode('transcode'), 'unknown');
});

test('individual episode match is preferred per mode; season pack is a marked fallback', () => {
  const directEpisode = {
    playbackMode: 'direct',
    episodeTargetMatch: true,
    releaseBytes: 2,
    stream: { url: 'e' },
  };
  const directPack = {
    playbackMode: 'direct',
    seasonPack: true,
    episodeTargetMatch: false,
    releaseBytes: 99,
    stream: { url: 'p' },
  };
  const hlsPack = {
    playbackMode: 'hls',
    seasonPack: true,
    episodeTargetMatch: false,
    releaseBytes: 20,
    stream: { url: 'h' },
  };
  const result = largestPlaybackEntryPerMode(
    [directPack, directEpisode, hlsPack],
    { preferEpisodes: true }
  );
  assert.deepEqual(
    result.entries.map((entry) => entry.stream.url),
    ['e', 'h']
  );
  assert.deepEqual(result.seasonPackFallbackModes, ['hls']);
});

test('target episode parsing accepts common forms without matching a different episode', () => {
  assert.equal(episodeTargetMatch({ name: 'Show.S03E23.1080p' }, 3, 23), true);
  assert.equal(episodeTargetMatch({ name: 'Show.S3E23.1080p' }, 3, 23), true);
  assert.equal(
    episodeTargetMatch({ behaviorHints: { season: 3, episode: 23 } }, 3, 23),
    true
  );
  assert.equal(episodeTargetMatch({ name: 'Show.S03E22.1080p' }, 3, 23), false);
  assert.equal(
    episodeTargetMatch({ name: 'Show complete season 3' }, 3, 23),
    false
  );
});

test('playback gates fail closed for missing required evidence', () => {
  assert.equal(
    countInvalidPlaybackUrls(
      [{ url: 'bad' }, { url: 'ok' }],
      (x) => x.url === 'ok'
    ),
    1
  );
  assert.deepEqual(
    encodedFilenameCoverage({
      requested: true,
      sampleAvailable: true,
      selected: true,
      probeOk: true,
    }),
    { status: 'verified', verified: true }
  );
  assert.equal(
    episodeModeSelectionPassed({
      requested: true,
      targetConfigured: true,
      selected: [{}],
      availableModeCount: 2,
      probeBudget: 3,
    }),
    false
  );
  assert.equal(episodeModeSelectionPassed({ requested: false }), true);
  assert.equal(
    playbackAcceptancePassed({
      responseOk: true,
      results: [{ ok: true, releaseBytes: 1 }],
      minimumReleaseBytes: 1,
    }),
    true
  );
  assert.equal(
    playbackAcceptancePassed({
      responseOk: true,
      results: [{ ok: true, releaseBytes: 1 }],
      invalidPlayableUrlCount: 1,
    }),
    false
  );
});

test('decode gate enforces duration and optional measured A/V skew', () => {
  assert.equal(
    mediaDecodePassed(
      [{ status: 'decoded', decodedSeconds: 12, audioVideoSkewMs: 40 }],
      10,
      50
    ),
    true
  );
  assert.equal(
    mediaDecodePassed(
      [{ status: 'decoded', decodedSeconds: 12, audioVideoSkewMs: 80 }],
      10,
      50
    ),
    false
  );
  assert.equal(
    mediaDecodePassed([{ status: 'decoded', decodedSeconds: 3 }], 10),
    false
  );
});

test('diagnostic categories never echo raw error text or URLs', () => {
  assert.equal(
    safeProbeErrorCategory(
      Object.assign(new Error('https://u:p@example/secret'), {
        code: 'ETIMEDOUT',
      })
    ),
    'etimedout'
  );
  assert.equal(
    safeProbeErrorCategory(new Error('token=secret')),
    'probe-failed'
  );
  assert.equal(requestTimeoutMs(true), 240000);
  assert.equal(requestTimeoutMs(false), 120000);
});
