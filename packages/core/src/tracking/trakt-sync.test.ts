import assert from 'node:assert/strict';
import test from 'node:test';
import { TrackerRecordSchema } from './types.js';
import { mapTraktSnapshot, planTraktWrites } from './trakt-sync.js';

test('Trakt history maps movie and episode records onto shared media identities', () => {
  const records = mapTraktSnapshot({
    history: [
      {
        watched_at: '2026-01-01T12:00:00.000Z',
        movie: { title: 'Example', ids: { imdb: 'tt1234567', tmdb: 41 } },
      },
      {
        watched_at: '2026-01-02T12:00:00.000Z',
        show: { title: 'Series', ids: { imdb: 'tt7654321', tmdb: 99 } },
        episode: { title: 'Pilot' },
        season: 1,
        number: 2,
      },
    ],
  }, 1);

  assert.deepEqual(records.map(({ id }) => id).sort(), [
    'movie:imdb:tt1234567',
    'episode:imdb:tt7654321:s1:e2',
  ].sort());
  const episode = records.find(({ kind }) => kind === 'episode')!;
  assert.equal(episode.kind, 'episode');
  assert.equal(episode.title, 'Series');
  assert.equal(episode.episodeTitle, 'Pilot');
  assert.equal(episode.state, 'watched');
  assert.equal(episode.origin, 'trakt');
});

test('Trakt ratings, watchlist, and playback stay independent facets', () => {
  const records = mapTraktSnapshot({
    watchlistMovies: [{ listed_at: '2026-02-01T00:00:00Z', movie: { title: 'Example', ids: { tmdb: 41 } } }],
    ratingsMovies: [{ rated_at: '2026-02-02T00:00:00Z', rating: 8, movie: { title: 'Example', ids: { tmdb: 41 } } }],
    playback: [{
      paused_at: '2026-02-03T00:00:00Z',
      progress: 25,
      movie: { title: 'Example', runtime: 120, ids: { tmdb: 41 } },
    }],
  }, 1);

  assert.deepEqual(new Set(records.map(({ id }) => id)), new Set([
    'movie:tmdb:41|watchlist',
    'movie:tmdb:41|rated',
    'movie:tmdb:41|progress',
  ]));
  const rated = records.find(({ state }) => state === 'rated');
  assert.equal(rated?.rating, 8);
  const playback = records.find(({ state }) => state === 'in_progress');
  assert.equal(playback?.durationMs, 7_200_000);
  assert.equal(playback?.positionMs, 1_800_000);
});

test('Trakt write planner batches supported history and watchlist mutations and reports unsupported states', () => {
  const base = {
    kind: 'movie' as const,
    ids: { imdb: 'tt1234567' },
    updatedAt: 1_700_000_000_000,
    origin: 'nuvio',
  };
  const plan = planTraktWrites([
    TrackerRecordSchema.parse({ ...base, id: 'movie:imdb:tt1234567', state: 'watched' }),
    TrackerRecordSchema.parse({ ...base, id: 'movie:imdb:tt2345678|watchlist', ids: { tmdb: '42' }, state: 'watchlist' }),
    TrackerRecordSchema.parse({ ...base, id: 'movie:imdb:tt3456789|favorite', state: 'favorite' }),
    TrackerRecordSchema.parse({ ...base, id: 'movie:imdb:tt4567890|note', state: 'note', text: 'remember this' }),
  ]);
  assert.equal(plan.operations.length, 2);
  assert.equal(plan.operations.find(({ path }) => path === '/sync/history')?.recordIds.length, 1);
  assert.equal(plan.operations.find(({ path }) => path === '/sync/watchlist')?.recordIds.length, 1);
  assert.equal(plan.skipped, 2);
});

test('Trakt write planner uses nested season episode shape and preserves tombstone targets', () => {
  const episode = TrackerRecordSchema.parse({
    id: 'episode:imdb:tt7654321:s2:e4',
    kind: 'episode',
    ids: { imdb: 'tt7654321' },
    season: 2,
    episode: 4,
    state: 'watchlist',
    updatedAt: 1_700_000_000_000,
    origin: 'nuvio',
  });
  const tombstone = TrackerRecordSchema.parse({
    ...episode,
    state: 'deleted',
    deletedState: 'watchlist',
    updatedAt: 1_700_000_000_001,
  });
  const plan = planTraktWrites([episode, tombstone]);
  assert.equal(plan.operations.length, 2);
  const add = plan.operations.find(({ path }) => path === '/sync/watchlist');
  const remove = plan.operations.find(({ path }) => path === '/sync/watchlist/remove');
  assert.deepEqual(add?.body.shows, [{ ids: { imdb: 'tt7654321' }, seasons: [{ number: 2, episodes: [{ number: 4 }] }] }]);
  assert.deepEqual(remove?.body.shows, [{ ids: { imdb: 'tt7654321' }, seasons: [{ number: 2, episodes: [{ number: 4 }] }] }]);
});

test('periodic Trakt ledger writes never masquerade as live pause events', () => {
  const progress = TrackerRecordSchema.parse({
    id: 'movie:imdb:tt1234567|progress',
    kind: 'movie',
    ids: { imdb: 'tt1234567' },
    state: 'in_progress',
    positionMs: 45_000,
    durationMs: 120_000,
    updatedAt: 1_700_000_000_000,
    origin: 'nuvio',
  });
  assert.deepEqual(planTraktWrites([progress]), { operations: [], skipped: 0 });
});
