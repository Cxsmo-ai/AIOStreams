import assert from 'node:assert/strict';
import test from 'node:test';
import { TrackerRecordSchema, type TrackerRecord } from '@aiostreams/core';
import {
  traktTrackerAdapter,
  weTrakrTrackerAdapter,
  floppyTrackerAdapter,
  type TrackerProviderApiRequest,
  type TrackerScrobbleEvent,
} from './tracker-providers.js';

test('Floppy snapshot reads every library facet and exact resume positions', async () => {
  const requested: string[] = [];
  const request: TrackerProviderApiRequest = async (_authRef, path) => {
    requested.push(path);
    if (path.startsWith('/api/v1/media/movie/'))
      return { data: { results: [{ item_id: '603', source: 'tmdb', status: 3, item: { title: 'The Matrix', ids: { tmdb: '603' } } }], pagination: { count: 1 } } };
    if (path.startsWith('/api/v1/playback/progress/'))
      return { data: { results: [{ media_type: 'movie', source: 'tmdb', media_id: '603', ids: { tmdb: '603' }, position_seconds: 900, duration_seconds: 8160, updated_at: '2026-10-01T00:00:00Z' }], pagination: { count: 1 } } };
    return { data: { results: [], pagination: { count: 0 } } };
  };
  const records = await floppyTrackerAdapter.pullSnapshot!('floppy-auth', request) as TrackerRecord[];
  assert.equal(records.some((record) => record.state === 'watched' && record.title === 'The Matrix'), true);
  assert.equal(records.some((record) => record.positionMs === 900_000 && record.durationMs === 8_160_000), true);
  assert.equal(requested.filter((path) => path.startsWith('/api/v1/media/')).length, 5);
  assert.equal(requested.some((path) => path.startsWith('/api/v1/history/')), true);
});

test('Floppy provider failure aborts the complete snapshot instead of implying empty history', async () => {
  const request: TrackerProviderApiRequest = async (_authRef, path) => {
    if (path.startsWith('/api/v1/media/anime/')) throw new Error('temporary upstream failure');
    return { data: { results: [], pagination: { count: 0 } } };
  };
  await assert.rejects(
    floppyTrackerAdapter.pullSnapshot!('floppy-auth', request),
    (error: unknown) => {
      const failure = error as Error & { reason?: string; endpoint?: string };
      assert.equal(failure.message, 'Floppy snapshot failed');
      assert.equal(failure.reason, 'invalid_upstream_response');
      assert.equal(failure.endpoint, 'floppy_media_anime');
      assert.equal(failure.message.includes('temporary upstream failure'), false);
      return true;
    }
  );
});

test('Floppy snapshot failure retains only safe HTTP status and endpoint metadata', async () => {
  await assert.rejects(
    floppyTrackerAdapter.pullSnapshot!('floppy-auth', async (_authRef, path) => {
      assert.equal(path, '/api/v1/media/movie/?limit=200&offset=0');
      throw new Error('Floppy API request failed (404)');
    }),
    (error: unknown) => {
      const failure = error as Error & { status?: number; reason?: string; endpoint?: string };
      assert.equal(failure.message, 'Floppy snapshot failed');
      assert.equal(failure.status, 404);
      assert.equal(failure.reason, 'upstream_http_404');
      assert.equal(failure.endpoint, 'floppy_media_movie');
      assert.equal(failure.message.includes('private response body'), false);
      return true;
    }
  );
});

test('Floppy snapshot parser failure identifies the safe failing endpoint', async () => {
  await assert.rejects(
    floppyTrackerAdapter.pullSnapshot!('floppy-auth', async () => ({
      data: { unexpected: 'private payload' },
      headers: new Headers(),
    })),
    (error: unknown) => {
      const failure = error as Error & { reason?: string; endpoint?: string };
      assert.equal(failure.message, 'Floppy snapshot failed');
      assert.equal(failure.reason, 'invalid_upstream_response');
      assert.equal(failure.endpoint, 'floppy_media_movie');
      assert.equal(failure.message.includes('private payload'), false);
      return true;
    }
  );
});

test('Floppy movie resume writes persist through a stop scrobble', async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const request: TrackerProviderApiRequest = async (_authRef, path, init) => {
    calls.push({ path, method: init.method, body: init.body });
    return { data: {}, headers: new Headers() };
  };
  const result = await floppyTrackerAdapter.pushRecords('floppy-auth', [{
    id: 'movie:tmdb:603|resume',
    kind: 'movie',
    ids: { tmdb: '603' },
    state: 'in_progress',
    positionMs: 900_000,
    durationMs: 8_160_000,
    revision: 0,
    updatedAt: 1_800_000_000_000,
    origin: 'trakt',
  }], request);
  assert.deepEqual(result, { synced: 1, skipped: 0 });
  assert.equal(calls[0].path, '/api/v1/scrobble/');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, {
    action: 'stop',
    media_type: 'movie',
    ids: { tmdb: '603' },
    position_seconds: 900,
    duration_seconds: 8160,
    completed: false,
    played_at: new Date(1_800_000_000_000).toISOString(),
  });
});

test('Floppy does not turn a movie-watch deletion into a Completed write', async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const request: TrackerProviderApiRequest = async (_authRef, path, init) => {
    calls.push({ path, method: init.method, body: init.body });
    return { data: {}, headers: new Headers() };
  };
  const result = await floppyTrackerAdapter.pushRecords('floppy-auth', [{
    id: 'movie:tmdb:603|watched',
    kind: 'movie',
    ids: { tmdb: '603' },
    state: 'deleted',
    deletedState: 'watched',
    revision: 1,
    updatedAt: 1_800_000_000_000,
    origin: 'nuvio',
  }], request);
  assert.deepEqual(result, { synced: 0, skipped: 1 });
  assert.equal(calls.length, 0);
});

test('Floppy episode scoring uses the documented PATCH endpoint', async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const request: TrackerProviderApiRequest = async (_authRef, path, init) => {
    calls.push({ path, method: init.method, body: init.body });
    return { data: {}, headers: new Headers() };
  };
  const result = await floppyTrackerAdapter.pushRecords('floppy-auth', [{
    id: 'episode:tmdb:1396:s1e1|rating',
    kind: 'episode',
    ids: { tmdb: '1396' },
    season: 1,
    episode: 1,
    state: 'rated',
    rating: 8,
    revision: 1,
    updatedAt: 1_800_000_000_000,
    origin: 'nuvio',
  }], request);
  assert.deepEqual(result, { synced: 1, skipped: 0 });
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].path, '/api/v1/media/tv/tmdb/1396/1/episodes/1/score/');
  assert.deepEqual(calls[0].body, { score: 8 });
});

test('Floppy treats absent deletes idempotently and skips only an unknown media write', async () => {
  const deletedRating = TrackerRecordSchema.parse({
    id: 'episode:tmdb:1396:s1e1|rating',
    kind: 'episode',
    ids: { tmdb: '1396' },
    season: 1,
    episode: 1,
    state: 'deleted',
    deletedState: 'rated',
    revision: 2,
    updatedAt: 1_800_000_000_000,
    origin: 'nuvio',
  });
  const result = await floppyTrackerAdapter.pushRecords(
    'floppy-auth',
    [deletedRating],
    async () => {
      throw new Error('Floppy API request failed (404)');
    }
  );
  assert.deepEqual(result, { synced: 1, skipped: 0 });

  const ordinaryRating = TrackerRecordSchema.parse({
    ...deletedRating,
    state: 'rated',
    rating: 8,
    deletedState: undefined,
  });
  const unknownWrite = await floppyTrackerAdapter.pushRecords(
    'floppy-auth',
    [ordinaryRating],
    async () => {
      throw new Error('Floppy API request failed (404)');
    }
  );
  assert.deepEqual(unknownWrite, { synced: 0, skipped: 1 });
});

test('Floppy movie watch writes preserve the source date and are retry-idempotent', async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const request: TrackerProviderApiRequest = async (_authRef, path, init) => {
    calls.push({ path, method: init.method, body: init.body });
    if (init.method === 'GET') return { data: { results: [] }, headers: new Headers() };
    return { data: {}, headers: new Headers() };
  };
  const result = await floppyTrackerAdapter.pushRecords('floppy-auth', [{
    id: 'movie:tmdb:603|watched',
    kind: 'movie',
    ids: { tmdb: '603' },
    state: 'watched',
    revision: 1,
    updatedAt: 1_800_000_000_000,
    origin: 'nuvio',
  }], request);
  assert.deepEqual(result, { synced: 1, skipped: 0 });
  assert.deepEqual(calls, [
    { path: '/api/v1/media/movie/tmdb/603/history/', method: 'GET', body: undefined },
    {
      path: '/api/v1/scrobble/',
      method: 'POST',
      body: {
        action: 'stop',
        media_type: 'movie',
        ids: { tmdb: '603' },
        completed: true,
        played_at: new Date(1_800_000_000_000).toISOString(),
      },
    },
  ]);
});

test('Floppy episode watch writes preserve completion date and exact episode identity', async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const request: TrackerProviderApiRequest = async (_authRef, path, init) => {
    calls.push({ path, method: init.method, body: init.body });
    if (init.method === 'GET') return { data: { results: [] }, headers: new Headers() };
    return { data: {}, headers: new Headers() };
  };
  const result = await floppyTrackerAdapter.pushRecords('floppy-auth', [{
    id: 'episode:tmdb:1396:s1e1|watched',
    kind: 'episode',
    ids: { tmdb: '1396' },
    season: 1,
    episode: 1,
    state: 'watched',
    revision: 1,
    updatedAt: 1_800_000_000_000,
    origin: 'nuvio',
  }], request);
  assert.deepEqual(result, { synced: 1, skipped: 0 });
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].path, '/api/v1/media/tv/tmdb/1396/1/1/history/');
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].path, '/api/v1/scrobble/');
  assert.deepEqual(calls[1].body, {
    action: 'stop',
    media_type: 'episode',
    ids: { tmdb: '1396' },
    season_number: 1,
    episode_number: 1,
    completed: true,
    played_at: new Date(1_800_000_000_000).toISOString(),
  });
});

test('Floppy watch retries do not append a duplicate when the exact dated play exists', async () => {
  const calls: Array<{ path: string; method: string }> = [];
  const playedAt = new Date(1_800_000_000_000).toISOString();
  const request: TrackerProviderApiRequest = async (_authRef, path, init) => {
    calls.push({ path, method: init.method });
    return {
      data: init.method === 'GET'
        ? { results: [{ played_at: playedAt }] }
        : {},
      headers: new Headers(),
    };
  };
  const result = await floppyTrackerAdapter.pushRecords('floppy-auth', [{
    id: 'movie:tmdb:603|watched',
    kind: 'movie',
    ids: { tmdb: '603' },
    state: 'watched',
    revision: 1,
    updatedAt: 1_800_000_000_000,
    origin: 'nuvio',
  }], request);
  assert.deepEqual(result, { synced: 1, skipped: 0 });
  assert.deepEqual(calls, [{ path: '/api/v1/media/movie/tmdb/603/history/', method: 'GET' }]);
});

test('Floppy corrects the existing completed play date instead of appending a duplicate', async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const request: TrackerProviderApiRequest = async (_authRef, path, init) => {
    calls.push({ path, method: init.method, body: init.body });
    return {
      data: init.method === 'GET'
        ? { results: [{ consumption_id: 42, status: 3, end_date: '2026-10-06T12:00:00Z' }] }
        : {},
      headers: new Headers(),
    };
  };
  const playedAt = Date.parse('2024-02-03T04:05:06Z');
  const result = await floppyTrackerAdapter.pushRecords('floppy-auth', [{
    id: 'movie:tmdb:603|watched',
    kind: 'movie',
    ids: { tmdb: '603' },
    state: 'watched',
    revision: 1,
    updatedAt: playedAt,
    origin: 'nuvio',
  }], request);

  assert.deepEqual(result, { synced: 1, skipped: 0 });
  assert.deepEqual(calls, [
    { path: '/api/v1/media/movie/tmdb/603/history/', method: 'GET', body: undefined },
    {
      path: '/api/v1/media/movie/tmdb/603/history/42/',
      method: 'PATCH',
      body: { end_date: new Date(playedAt).toISOString() },
    },
  ]);
});

test('Floppy writes prefer the native TMDB identity when canonical records carry multiple IDs', async () => {
  const calls: string[] = [];
  const request: TrackerProviderApiRequest = async (_authRef, path, init) => {
    calls.push(path);
    if (init.method === 'GET') return { data: { results: [] }, headers: new Headers() };
    return { data: {}, headers: new Headers() };
  };
  await floppyTrackerAdapter.pushRecords('floppy-auth', [{
    id: 'episode:imdb:tt0959621:s1e1|watched',
    kind: 'episode',
    ids: { imdb: 'tt0959621', tmdb: '1396', tvdb: '12345' },
    season: 1,
    episode: 1,
    state: 'watched',
    revision: 1,
    updatedAt: 1_800_000_000_000,
    origin: 'nuvio',
  }], request);
  assert.deepEqual(calls, [
    '/api/v1/media/tv/tmdb/1396/1/1/history/',
    '/api/v1/scrobble/',
  ]);
});

test('Floppy resume writes use a durable stop scrobble, not a nonexistent progress PUT', async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const request: TrackerProviderApiRequest = async (_authRef, path, init) => {
    calls.push({ path, method: init.method, body: init.body });
    return { data: {}, headers: new Headers() };
  };
  const result = await floppyTrackerAdapter.pushRecords('floppy-auth', [{
    id: 'episode:tmdb:1396:s2e3|resume',
    kind: 'episode',
    ids: { tmdb: '1396', anilist: '123' },
    seriesTitle: 'Example Show',
    season: 2,
    episode: 3,
    state: 'in_progress',
    positionMs: 900_500,
    durationMs: 2_400_900,
    revision: 1,
    updatedAt: 1_800_000_000_000,
    origin: 'nuvio',
  }], request);
  assert.deepEqual(result, { synced: 1, skipped: 0 });
  assert.equal(calls[0].path, '/api/v1/scrobble/');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, {
    action: 'stop',
    media_type: 'episode',
    ids: { tmdb: '1396' },
    series_title: 'Example Show',
    season_number: 2,
    episode_number: 3,
    position_seconds: 900,
    duration_seconds: 2400,
    completed: false,
    played_at: new Date(1_800_000_000_000).toISOString(),
  });
});

test('Floppy writes supported list membership through its media list endpoint', async () => {
  const calls: Array<{ path: string; method: string }> = [];
  const request: TrackerProviderApiRequest = async (_authRef, path, init) => {
    calls.push({ path, method: init.method });
    return { data: {}, headers: new Headers() };
  };
  const result = await floppyTrackerAdapter.pushRecords('floppy-auth', [{
    id: 'movie:tmdb:603|list:23',
    kind: 'movie',
    ids: { tmdb: '603' },
    state: 'list',
    listId: '23',
    listIdProvider: 'floppy',
    revision: 1,
    updatedAt: 1_800_000_000_000,
    origin: 'nuvio',
  }], request);
  assert.deepEqual(result, { synced: 1, skipped: 0 });
  assert.deepEqual(calls, [{
    path: '/api/v1/media/movie/tmdb/603/lists/23/',
    method: 'PUT',
  }]);
});

test('Floppy unsupported note and standalone movie rating records do not issue invented PUT requests', async () => {
  let calls = 0;
  const request: TrackerProviderApiRequest = async () => {
    calls += 1;
    return { data: {}, headers: new Headers() };
  };
  const result = await floppyTrackerAdapter.pushRecords('floppy-auth', [
    {
      id: 'movie:tmdb:603|note',
      kind: 'movie',
      ids: { tmdb: '603' },
      state: 'note',
      text: 'A note',
      revision: 1,
      updatedAt: 1_800_000_000_000,
      origin: 'nuvio',
    },
    {
      id: 'movie:tmdb:603|rating',
      kind: 'movie',
      ids: { tmdb: '603' },
      state: 'rated',
      rating: 8,
      revision: 1,
      updatedAt: 1_800_000_000_000,
      origin: 'nuvio',
    },
  ], request);
  assert.deepEqual(result, { synced: 0, skipped: 2 });
  assert.equal(calls, 0);
});

test('Floppy skips non-episode TV completion and unidentifiable episode resumes', async () => {
  let calls = 0;
  const request: TrackerProviderApiRequest = async () => {
    calls += 1;
    return { data: {}, headers: new Headers() };
  };
  const result = await floppyTrackerAdapter.pushRecords('floppy-auth', [
    {
      id: 'series:tmdb:1396|watched',
      kind: 'series',
      ids: { tmdb: '1396' },
      state: 'watched',
      revision: 1,
      updatedAt: 1_800_000_000_000,
      origin: 'nuvio',
    },
    {
      id: 'episode:tmdb:1396:s2e3|resume',
      kind: 'episode',
      ids: { tmdb: '1396' },
      season: 2,
      episode: 3,
      state: 'in_progress',
      positionMs: 900_000,
      durationMs: 2_400_000,
      revision: 1,
      updatedAt: 1_800_000_000_000,
      origin: 'nuvio',
    },
  ], request);
  assert.deepEqual(result, { synced: 0, skipped: 2 });
  assert.equal(calls, 0);
});

test('Floppy scrobble waits for exact playback position and duration', async () => {
  const event: TrackerScrobbleEvent = {
    eventId: 'stable-event-id',
    action: 'stop',
    progress: 100,
    media: { kind: 'movie', ids: { tmdb: '603' }, title: 'The Matrix' },
  };
  let calls = 0;
  const request: TrackerProviderApiRequest = async () => {
    calls += 1;
    return { data: {}, headers: new Headers() };
  };
  const ignored = await floppyTrackerAdapter.scrobble('floppy-auth', event, request);
  assert.deepEqual(ignored, { status: 'ignored', reason: 'Floppy needs exact playback position and duration to persist a stop event.' });
  assert.equal(calls, 0);
  const delivered = await floppyTrackerAdapter.scrobble(
    'floppy-auth',
    { ...event, positionMs: 8_160_000, durationMs: 8_160_000 },
    request
  );
  assert.equal(delivered, undefined);
  assert.equal(calls, 1);
});

test('Floppy permits ID-backed live start and pause events without final position', async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const request: TrackerProviderApiRequest = async (_authRef, path, init) => {
    calls.push({ path, method: init.method, body: init.body });
    return { data: {}, headers: new Headers() };
  };
  const live: TrackerScrobbleEvent = {
    eventId: 'live-start',
    action: 'start',
    progress: 0,
    media: {
      kind: 'show',
      title: 'Example Show',
      ids: { tmdb: '1396', anilist: '123' },
      episode: { season: 1, number: 2, title: 'Pilot' },
    },
  };
  assert.equal(await floppyTrackerAdapter.scrobble('floppy-auth', live, request), undefined);
  assert.deepEqual(calls[0].body, {
    action: 'start',
    media_type: 'episode',
    ids: { tmdb: '1396' },
    title: 'Pilot',
    series_title: 'Example Show',
    season_number: 1,
    episode_number: 2,
  });
  assert.deepEqual(
    await floppyTrackerAdapter.scrobble('floppy-auth', {
      ...live,
      eventId: 'live-unmapped',
      media: {
        kind: 'show',
        title: 'Example Show',
        ids: { anilist: '123' },
        episode: { season: 1, number: 2 },
      },
    }, request),
    { status: 'ignored', reason: 'Floppy needs a TMDB, IMDb, or TVDB ID for scrobbling.' }
  );
  assert.equal(calls.length, 1);
});

test('WeTrakr adapter refuses foreign comment and custom-list IDs before API fan-out', async () => {
  const calls: string[] = [];
  const request: TrackerProviderApiRequest = async (_authRef, path) => {
    calls.push(path);
    return { data: {}, headers: new Headers() };
  };
  const result = await weTrakrTrackerAdapter.pushRecords(
    'opaque-ref',
    [
      {
        id: 'movie:imdb:tt1234567|comment:8',
        kind: 'movie',
        ids: { imdb: 'tt1234567' },
        state: 'deleted',
        deletedState: 'comment',
        providerId: '8',
        providerIdProvider: 'another-tracker',
        revision: 1,
        updatedAt: 1_800_000_000_000,
        origin: 'nuvio',
      },
      {
        id: 'movie:imdb:tt1234567|list:42',
        kind: 'movie',
        ids: { imdb: 'tt1234567' },
        state: 'deleted',
        deletedState: 'list',
        listId: '42',
        listIdProvider: 'another-tracker',
        revision: 1,
        updatedAt: 1_800_000_000_001,
        origin: 'nuvio',
      },
      {
        id: 'movie:imdb:tt1234567|list:42',
        kind: 'movie',
        ids: { imdb: 'tt1234567' },
        state: 'list',
        listId: '42',
        listIdProvider: 'another-tracker',
        revision: 1,
        updatedAt: 1_800_000_000_002,
        origin: 'nuvio',
      },
      {
        id: 'movie:imdb:tt1234567|list:7',
        kind: 'movie',
        ids: { imdb: 'tt1234567' },
        state: 'list',
        listId: '7',
        listIdProvider: 'wetrakr',
        revision: 1,
        updatedAt: 1_800_000_000_003,
        origin: 'nuvio',
      },
    ],
    request
  );

  assert.equal(result.skipped, 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], '/sync/lists/7/items');
});

test('Trakt snapshot adapter loads each live account facet and maps common IDs', async () => {
  const requested: string[] = [];
  const request: TrackerProviderApiRequest = async (_authRef, path) => {
    requested.push(path);
    if (path.startsWith('/sync/history?type=movies')) {
      return {
        data: [
          {
            watched_at: '2026-09-01T00:00:00Z',
            movie: { title: 'Film', ids: { imdb: 'tt1234567', tmdb: 12 } },
          },
        ],
        headers: new Headers(),
      };
    }
    return { data: [], headers: new Headers() };
  };

  const records = await traktTrackerAdapter.pullSnapshot!(
    'opaque-ref',
    request
  );
  assert.deepEqual(
    (Array.isArray(records) ? records : records.records).map(({ id }) => id),
    ['movie:imdb:tt1234567']
  );
  assert.equal(requested.length, 8);
  assert.ok(
    requested.some((path) => path.startsWith('/sync/playback/episodes'))
  );
});

test('Trakt snapshot refuses an unbounded partial page set instead of deleting unseen ledger records', async () => {
  let calls = 0;
  const request: TrackerProviderApiRequest = async (_authRef, path) => {
    calls += 1;
    return {
      data: path.startsWith('/sync/history?type=movies')
        ? Array.from({ length: 100 }, (_, index) => ({ index }))
        : [],
      headers: new Headers(),
    };
  };
  await assert.rejects(
    traktTrackerAdapter.pullSnapshot!('opaque-ref', request),
    /safe pagination limit/
  );
  assert.equal(calls, 107);
});

test('WeTrakr live scrobble preserves canonical show IDs, episode coordinates, and idempotency', async () => {
  const calls: Array<{
    path: string;
    body: unknown;
    idempotencyKey?: string;
  }> = [];
  const request: TrackerProviderApiRequest = async (_authRef, path, init) => {
    calls.push({
      path,
      body: init.body,
      idempotencyKey: init.idempotencyKey,
    });
    return { data: {}, headers: new Headers() };
  };

  await weTrakrTrackerAdapter.scrobble(
    'opaque-ref',
    {
      eventId: 'nuvio-session-episode-1-pause',
      action: 'pause',
      progress: 37.5,
      media: {
        kind: 'show',
        title: 'Example Show',
        year: 2024,
        ids: { imdb: 'tt1234567', tvdb: '789012' },
        episode: { season: 3, number: 8, title: 'The Example' },
      },
    },
    request
  );

  assert.deepEqual(calls, [
    {
      path: '/scrobble/pause',
      body: {
        show: {
          title: 'Example Show',
          year: 2024,
          ids: { imdb: 'tt1234567', tvdb: '789012' },
        },
        episode: { season: 3, number: 8, title: 'The Example' },
        progress: 37.5,
      },
      idempotencyKey: 'nuvio-session-episode-1-pause',
    },
  ]);
});

test('Trakt live scrobble sends movie and episode payloads to the documented action path', async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const request: TrackerProviderApiRequest = async (_authRef, path, init) => {
    calls.push({ path, body: init.body });
    return { data: {}, headers: new Headers() };
  };
  const events: TrackerScrobbleEvent[] = [
    {
      eventId: 'event-movie',
      action: 'start',
      progress: 0,
      media: { kind: 'movie', ids: { imdb: 'tt1234567' } },
    },
    {
      eventId: 'event-episode',
      action: 'pause',
      progress: 42.5,
      media: {
        kind: 'show',
        ids: { tmdb: '45' },
        episode: { season: 2, number: 3 },
      },
    },
    {
      eventId: 'event-stop-at-zero',
      action: 'stop',
      progress: 0,
      media: { kind: 'movie', ids: { imdb: 'tt1234567' } },
    },
  ];
  for (const event of events)
    await traktTrackerAdapter.scrobble('opaque-ref', event, request);

  assert.deepEqual(
    calls.map(({ path }) => path),
    ['/scrobble/start', '/scrobble/pause']
  );
  assert.deepEqual(calls[0].body, {
    movie: { ids: { imdb: 'tt1234567' } },
    progress: 0,
  });
  assert.deepEqual(calls[1].body, {
    show: { ids: { tmdb: '45' } },
    episode: { season: 2, number: 3 },
    progress: 42.5,
  });
});

test('Trakt reports a below-threshold stop as ignored without making a request', async () => {
  let requested = false;
  const result = await traktTrackerAdapter.scrobble(
    'opaque-ref',
    {
      eventId: 'event-stop-below-threshold',
      action: 'stop',
      progress: 0.5,
      media: { kind: 'movie', ids: { imdb: 'tt1234567' } },
    },
    async () => {
      requested = true;
      return { data: {}, headers: new Headers() };
    }
  );
  assert.equal(requested, false);
  assert.deepEqual(result, {
    status: 'ignored',
    reason: 'Trakt ignores stop events below 1%.',
  });
});

test('Trakt record fan-out writes supported states and reports unsupported ones', async () => {
  const calls: string[] = [];
  const request: TrackerProviderApiRequest = async (_authRef, path) => {
    calls.push(path);
    return {
      data: path.startsWith('/sync/watched/') ? [] : {},
      headers: new Headers(),
    };
  };
  const base = {
    kind: 'movie' as const,
    ids: { imdb: 'tt1234567' },
    updatedAt: 1_800_000_000_000,
    origin: 'nuvio',
  };
  const result = await traktTrackerAdapter.pushRecords(
    'opaque-ref',
    [
      TrackerRecordSchema.parse({
        ...base,
        id: 'movie:imdb:tt1234567',
        state: 'watched',
      }),
      TrackerRecordSchema.parse({
        ...base,
        id: 'movie:imdb:tt1234567|favorite',
        state: 'favorite',
      }),
    ],
    request
  );
  assert.deepEqual(calls, [
    '/sync/watched/movies?page=1&limit=100',
    '/sync/watched/shows?page=1&limit=100',
    '/sync/history',
  ]);
  assert.deepEqual(result, { synced: 1, skipped: 1 });
});

test('Trakt watched writes avoid replaying items already recorded by a live scrobble', async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const request: TrackerProviderApiRequest = async (_authRef, path, init) => {
    calls.push({ path, body: init.body });
    if (path.startsWith('/sync/watched/movies')) {
      return {
        data: [{ movie: { ids: { imdb: 'tt1234567' } } }],
        headers: new Headers(),
      };
    }
    return { data: [], headers: new Headers() };
  };
  const base = {
    kind: 'movie' as const,
    updatedAt: 1_800_000_000_000,
    origin: 'nuvio',
  };
  const result = await traktTrackerAdapter.pushRecords(
    'opaque-ref',
    [
      TrackerRecordSchema.parse({
        ...base,
        id: 'movie:imdb:tt1234567',
        ids: { imdb: 'tt1234567' },
        state: 'watched',
      }),
      TrackerRecordSchema.parse({
        ...base,
        id: 'movie:imdb:tt7654321',
        ids: { imdb: 'tt7654321' },
        state: 'watched',
      }),
    ],
    request
  );
  assert.deepEqual(
    calls.map(({ path }) => path),
    [
      '/sync/watched/movies?page=1&limit=100',
      '/sync/watched/shows?page=1&limit=100',
      '/sync/history',
    ]
  );
  assert.deepEqual(calls[2].body, { movies: [{ ids: { imdb: 'tt7654321' } }] });
  assert.deepEqual(result, { synced: 1, skipped: 0 });
});

test('Trakt progress tombstones are not deleted with a foreign provider ID', async () => {
  const record = TrackerRecordSchema.parse({
    id: 'movie:imdb:tt1234567|progress',
    kind: 'movie',
    ids: { imdb: 'tt1234567' },
    state: 'deleted',
    deletedState: 'in_progress',
    updatedAt: 1_800_000_000_000,
    origin: 'nuvio',
  });
  await assert.rejects(
    traktTrackerAdapter.removeRecord!('opaque-ref', record, async () => ({
      data: {},
      headers: new Headers(),
    })),
    /Trakt playback item id/
  );
});
