import assert from 'node:assert/strict';
import test from 'node:test';
import type { Addon, ParsedStream } from '../db/schemas.js';
import {
  getDeepbridFinderIdentities,
  isAlreadyResolvedByDeepbridFinder,
} from './serviceWrapper.js';

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

test('matches equivalent Finder releases from different signed NZB URLs by exact title and size', () => {
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
