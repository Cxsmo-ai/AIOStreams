import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  parseNewshostingRelease,
  scoreNewshostingReleaseMatch,
  type NewshostingMediaMetadata,
  type NewshostingMediaRequest,
} from './release.js';

interface ReleaseFixture {
  title: string;
  expected: Record<string, unknown>;
  match?: {
    media: NewshostingMediaRequest;
    metadata?: NewshostingMediaMetadata;
    expectedConfidence: 'high' | 'medium' | 'low';
    reasonIncludes: string[];
  };
}

const fixtures = JSON.parse(
  readFileSync(
    new URL('./fixtures/release-cases.json', import.meta.url),
    'utf8'
  )
) as ReleaseFixture[];

test('portable anonymized release fixtures preserve selected parsing signals', () => {
  assert.ok(fixtures.length >= 10);
  for (const fixture of fixtures) {
    const parsed = parseNewshostingRelease(fixture.title);
    for (const [field, expected] of Object.entries(fixture.expected)) {
      assert.deepEqual(
        (parsed as unknown as Record<string, unknown>)[field],
        expected,
        `${fixture.title}: ${field}`
      );
    }

    if (fixture.match) {
      const match = scoreNewshostingReleaseMatch(
        fixture.title,
        fixture.match.media,
        parsed,
        fixture.match.metadata
      );
      assert.equal(match.confidence, fixture.match.expectedConfidence);
      for (const reason of fixture.match.reasonIncludes) {
        assert.ok(
          match.reason.split(',').includes(reason),
          `${fixture.title}: expected reason ${reason}`
        );
      }
    }
  }
});

test('portable release fixtures contain no live provider data or credential fields', () => {
  const serialized = JSON.stringify(fixtures);
  assert.doesNotMatch(serialized, /https?:\/\//i);
  assert.doesNotMatch(
    serialized,
    /(?:api[_ -]?key|password|token|authorization)/i
  );
  for (const fixture of fixtures) {
    assert.match(fixture.title, /^Example|^Chronicle/);
  }
});

test('release episode ranges never combine unrelated filename expressions', () => {
  const unrelated = 'Example.Show.S01E02.100-105.1080p.WEB-DL';
  const parsedUnrelated = parseNewshostingRelease(unrelated);
  assert.equal(parsedUnrelated.episodeRange, undefined);

  const falseEpisodeMatch = scoreNewshostingReleaseMatch(
    unrelated,
    { type: 'series', season: 1, episode: 50 },
    parsedUnrelated,
    { title: 'Example Show' }
  );
  assert.doesNotMatch(falseEpisodeMatch.reason, /episode-range/);
  assert.match(falseEpisodeMatch.reason, /episode-mismatch/);
});

test('release episode ranges retain endpoints from their own expression', () => {
  assert.deepEqual(
    parseNewshostingRelease('Example.Show.S01E02-E04.1080p').episodeRange,
    { start: 2, end: 4 }
  );
  assert.deepEqual(
    parseNewshostingRelease('Chronicle.101-104.1080p').episodeRange,
    { start: 101, end: 104 }
  );
  assert.equal(
    parseNewshostingRelease('Example.Show.S01E08-E03.1080p').episodeRange,
    undefined
  );
});
