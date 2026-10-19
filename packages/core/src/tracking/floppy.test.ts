import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeFloppyBaseUrl } from './floppy.js';
import {
  fetchFloppySnapshot,
  floppyHistoryRecordsForTest,
  floppyMediaRecordsForTest,
  floppyPlaybackRecordsForTest,
} from './floppy-sync.js';

test('Floppy base URL requires public HTTPS and strips only a trailing slash', () => {
  assert.equal(
    normalizeFloppyBaseUrl('https://floppy.example.com/subpath/'),
    'https://floppy.example.com/subpath'
  );
  for (const value of [
    'http://floppy.example.com',
    'https://user:password@floppy.example.com',
    'https://127.0.0.1',
    'https://media.local',
    'file:///tmp/floppy',
  ]) {
    assert.throws(() => normalizeFloppyBaseUrl(value));
  }
});

test('Floppy media rows become canonical status, rating, note, and list records', () => {
  const records = floppyMediaRecordsForTest(
    {
      item_id: '603',
      source: 'tmdb',
      status: 3,
      score: 8.5,
      updated_at: '2026-10-06T12:00:00Z',
      notes: 'rewatch later',
      item: { type: 'movie', title: 'The Matrix', ids: { imdb: 'tt0133093', tmdb: 603 } },
      lists: [{ id: 12, name: 'Favorites', position: 0 }],
    },
    'movie'
  );
  assert.deepEqual(new Set(records.map((record) => record.state)), new Set(['watched', 'rated', 'note', 'list']));
  assert.ok(records.every((record) => record.origin === 'floppy'));
  assert.equal(records.find((record) => record.state === 'rated')?.rating, 8.5);
  assert.equal(records.find((record) => record.state === 'list')?.listIdProvider, 'floppy');
});

test('Floppy completed status uses the completion date, not a later progress/edit timestamp', () => {
  const records = floppyMediaRecordsForTest({
    item_id: '603',
    source: 'tmdb',
    status: 3,
    end_date: '2024-02-03T04:05:06Z',
    progressed_at: '2026-10-06T12:00:00Z',
    updated_at: '2026-10-06T12:30:00Z',
    scored_at: '2025-01-02T03:04:05Z',
    score: 8,
    item: { type: 'movie', title: 'The Matrix', ids: { tmdb: '603' } },
  }, 'movie');

  assert.equal(
    records.find((record) => record.state === 'watched')?.updatedAt,
    Date.parse('2024-02-03T04:05:06Z')
  );
  assert.equal(
    records.find((record) => record.state === 'rated')?.updatedAt,
    Date.parse('2025-01-02T03:04:05Z')
  );
});

test('Floppy media rows fall back to the nested source when the top-level source is blank', () => {
  const records = floppyMediaRecordsForTest(
    {
      item_id: '603',
      source: '',
      status: 3,
      item: {
        media_type: 'movie',
        media_id: '603',
        source: 'tmdb',
        ids: { imdb: 'tt0133093', tmdb: 603 },
      },
    },
    'movie'
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].providerId, 'movie:tmdb:603');
  assert.equal(records[0].state, 'watched');
});

test('Floppy playback and history preserve exact positions and event dates', () => {
  const resume = floppyPlaybackRecordsForTest({
    media_type: 'episode',
    source: 'tmdb',
    media_id: '1399',
    season_number: 1,
    episode_number: 2,
    ids: { tmdb: '1399', imdb: 'tt0944947' },
    position_seconds: 1234,
    duration_seconds: 3300,
    updated_at: '2026-10-06T12:00:00Z',
  })[0];
  assert.equal(resume.positionMs, 1_234_000);
  assert.equal(resume.durationMs, 3_300_000);
  const play = floppyHistoryRecordsForTest({
    media_type: 'movie',
    source: 'tmdb',
    media_id: '603',
    consumption_id: 44,
    played_at: '2026-10-01T10:30:00Z',
    item: { title: 'The Matrix', ids: { tmdb: '603' } },
  })[0];
  assert.equal(play.state, 'play');
  assert.equal(play.updatedAt, Date.parse('2026-10-01T10:30:00Z'));
});

test('Floppy API history rows use the nested media identity and entry key', () => {
  const play = floppyHistoryRecordsForTest({
    media_type: 'episode',
    entry_key: 'watch-42',
    played_at_local: '2026-10-01T10:30:00-04:00',
    season_number: 2,
    episode_number: 3,
    item: {
      id: 1399,
      media_id: '1399',
      source: 'tmdb',
      title: 'Episode title',
      ids: { tmdb: '1399' },
    },
  })[0];

  assert.equal(play.id, 'episode:tmdb:1399:s2e3|play:watch-42');
  assert.equal(play.providerId, 'episode:tmdb:1399:watch-42');
  assert.equal(play.updatedAt, Date.parse('2026-10-01T10:30:00-04:00'));
});

test('Floppy history prefers the actual completion date over the later row creation date', () => {
  const play = floppyHistoryRecordsForTest({
    media_type: 'movie',
    source: 'tmdb',
    media_id: '603',
    consumption_id: 45,
    end_date: '2024-02-03T04:05:06Z',
    created: '2026-10-06T12:00:00Z',
    item: { title: 'The Matrix', ids: { tmdb: '603' } },
  })[0];

  assert.equal(play.updatedAt, Date.parse('2024-02-03T04:05:06Z'));
});

test('Floppy snapshot is all-or-nothing when a provider facet fails', async () => {
  await assert.rejects(
    fetchFloppySnapshot(async (path) => {
      if (path.startsWith('/api/v1/media/movie/'))
        return { data: { results: [], pagination: { count: 0 } } };
      throw new Error('upstream unavailable');
    }),
    (error: unknown) =>
      error instanceof Error && error.message === 'Floppy snapshot failed'
  );
});
