import assert from 'node:assert/strict';
import test from 'node:test';
import type { Addon, ParsedStream } from '../db/schemas.js';
import {
  deepbridPresentationOverrides,
  formatGlobalDeepbridName,
  getDeepbridFinderIdentities,
  hasTorrentClawAutoWrapAddon,
  isAlreadyResolvedByDeepbridFinder,
  originalsForResolvedNzb,
} from './serviceWrapper.js';
import { hashNzbUrl } from '../debrid/index.js';

test('rebuilds presentation for global Deepbrid copies instead of keeping the old service badge', () => {
  const source = stream('source', 'newshosting-indexer', {
    addon: {
      ...addon('newshosting-indexer'),
      formatPassthrough: true,
    },
    extra: { formattingPassthrough: true },
    originalName: '[AIO⚡] Newshosting as an Indexer 1080p',
    originalDescription: 'old service label',
  });
  const overrides = deepbridPresentationOverrides(source);

  assert.equal(overrides.addon.formatPassthrough, false);
  assert.equal(overrides.extra?.formattingPassthrough, false);
  assert.equal(overrides.originalName, undefined);
  assert.equal(overrides.originalDescription, undefined);
  assert.equal(source.addon.formatPassthrough, true);
});

test('labels externally resolved indexer results as Deepbrid, not their old route', () => {
  assert.equal(
    formatGlobalDeepbridName('[AIO⚡] altHUB Usenet 1080p', false),
    '[DB⏳] altHUB Usenet 1080p'
  );
  assert.equal(
    formatGlobalDeepbridName('🔑 [TB⏳] Newshosting as an Indexer 720p', true),
    '🔑 [DB⚡] Newshosting as an Indexer 720p'
  );
});

test('maps Deepbrid responses back to external indexers by NZB URL after hash rewrite', () => {
  const sourceUrl = 'https://indexer.example/download?id=release-1';
  const original = stream('newznab-release-1', 'newznab', {
    nzbUrl: sourceUrl,
    indexer: 'altHUB',
  });
  const originalsBySourceHash = new Map([
    [hashNzbUrl(sourceUrl), [original]],
  ]);

  const mapped = originalsForResolvedNzb(
    {
      hash: 'deepbrid-hash-for-submitted-url',
      nzb: sourceUrl,
    },
    originalsBySourceHash
  );

  assert.deepEqual(mapped, [original]);
});

const addon = (identifier: string): Addon =>
  ({
    name: identifier,
    manifestUrl: `https://example.com/${identifier}/manifest.json`,
    enabled: true,
    identifier,
    preset: { id: identifier, type: identifier, options: {} },
    instanceId: identifier,
  }) as Addon;

const stream = (
  id: string,
  identifier: string,
  overrides: Partial<ParsedStream> = {}
): ParsedStream =>
  ({
    id,
    addon: addon(identifier),
    type: 'usenet',
    proxied: false,
    ...overrides,
  }) as ParsedStream;

test('suppresses an external Deepbrid copy when Finder exposed the same NZB', () => {
  const finder = stream('finder', 'deepbrid-usenet', {
    otherBehaviorHints: { deepbridNzbHash: 'same-hash' },
  });
  const external = stream('external', 'althub', {
    otherBehaviorHints: { deepbridNzbHash: 'same-hash' },
  });

  assert.equal(
    isAlreadyResolvedByDeepbridFinder(
      external,
      getDeepbridFinderIdentities(finder)
    ),
    true
  );
});

test('recognizes only an internally service-wrapped TorrentClaw addon for auto-wrap', () => {
  const torrentClaw = {
    ...addon('torrentclaw'),
    preset: { id: 'torrentclaw', type: 'torrentclaw', options: {} },
    serviceWrapped: true,
  } as Addon;
  const ordinaryWrappedAddon = {
    ...addon('comet'),
    serviceWrapped: true,
  } as Addon;

  assert.equal(hasTorrentClawAutoWrapAddon([torrentClaw]), true);
  assert.equal(hasTorrentClawAutoWrapAddon([ordinaryWrappedAddon]), false);
  assert.equal(
    hasTorrentClawAutoWrapAddon([{ ...torrentClaw, serviceWrapped: false }]),
    false
  );
});

test('does not suppress an independent NZB merely because title and size match Finder', () => {
  const finder = stream('finder', 'deepbrid-usenet', {
    otherBehaviorHints: {
      deepbridReleaseTitle: 'Show.S01E03.1080p.WEB-DL-GROUP',
      deepbridReleaseSize: 8_123_456_789,
    },
  });
  const external = stream('external', 'torrentclaw-usenet', {
    folderName: 'Show S01E03 1080p WEB-DL GROUP',
    folderSize: 8_123_456_789,
    nzbUrl: 'https://indexer.example/download/other-token',
  });

  assert.equal(
    isAlreadyResolvedByDeepbridFinder(
      external,
      getDeepbridFinderIdentities(finder)
    ),
    false
  );
});

test('does not treat a release fingerprint as proof of identical NZB content', () => {
  const finder = stream('finder', 'deepbrid-usenet', {
    releaseKey: 'wd1:0123456789abcdef0123456789abcdef',
  });
  const external = stream('external', 'newshosting-indexer', {
    releaseKey: 'wd1:0123456789abcdef0123456789abcdef',
    nzbUrl: 'https://indexer.example/download?id=independent-nzb',
  });

  assert.equal(
    isAlreadyResolvedByDeepbridFinder(
      external,
      getDeepbridFinderIdentities(finder)
    ),
    false
  );
});

test('suppresses only when both streams carry the same exact NZB content key', () => {
  const finder = stream('finder', 'deepbrid-usenet', {
    releaseKey: 'nh1:0123456789abcdef0123456789abcdef01234567',
  });
  const external = stream('external', 'newshosting-indexer', {
    releaseKey: 'nh1:0123456789abcdef0123456789abcdef01234567',
    nzbUrl: 'https://indexer.example/download?id=independent-nzb',
  });

  assert.equal(
    isAlreadyResolvedByDeepbridFinder(
      external,
      getDeepbridFinderIdentities(finder)
    ),
    true
  );
});

test('does not suppress a different release with the same title but different bytes', () => {
  const finder = stream('finder', 'deepbrid-usenet', {
    otherBehaviorHints: {
      deepbridReleaseTitle: 'Movie.2026.2160p.REMUX-GROUP',
      deepbridReleaseSize: 80_000_000_000,
    },
  });
  const external = stream('external', 'newshosting', {
    folderName: 'Movie.2026.2160p.REMUX-GROUP',
    folderSize: 79_999_999_999,
  });

  assert.equal(
    isAlreadyResolvedByDeepbridFinder(
      external,
      getDeepbridFinderIdentities(finder)
    ),
    false
  );
});
