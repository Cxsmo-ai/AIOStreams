import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchWeTrakrAccountRecords,
  fetchWeTrakrAccountSnapshot,
  fetchWeTrakrJournalDelta,
  mapWeTrakrJournalEntry,
  mapWeTrakrItemToTrackerRecord,
  planWeTrakrWrites,
  pushWeTrakrRecords,
} from './wetrakr-sync.js';
import type { TrackerRecord } from './types.js';

test('WeTrakr watched movie keys match Nuvio progress identity', () => {
  const record = mapWeTrakrJournalEntry({
    category: 'watched',
    status: 'added',
    type: 'movie',
    id: 126,
    title: 'The Dark Knight',
    ids: { imdb: 'tt0468569', tmdb: 155 },
    action_at: '2026-10-01T12:30:00.000Z',
  });
  assert.equal(record?.id, 'movie:imdb:tt0468569');
  assert.equal(record?.state, 'watched');
  assert.equal(record?.origin, 'wetrakr');
  assert.equal(record?.ids.tmdb, '155');
});

test('episode history uses parent show identity and preserves season/episode metadata', () => {
  const record = mapWeTrakrJournalEntry({
    category: 'watched',
    status: 'added',
    type: 'episode',
    id: 62085,
    title: 'Pilot',
    ids: { imdb: 'tt0959621' },
    show: { ids: { imdb: 'tt0903747', tmdb: 1396 }, title: 'Breaking Bad' },
    season_number: 1,
    number: 1,
    watched_at: '2026-10-01T12:30:00.000Z',
  });
  assert.equal(record?.id, 'episode:imdb:tt0903747:s1:e1');
  assert.equal(record?.kind, 'episode');
  assert.equal(record?.seriesTitle, 'Breaking Bad');
  assert.equal(record?.episodeTitle, 'Pilot');
});

test('WeTrakr playing snapshots map into the shared in-progress record', () => {
  const record = mapWeTrakrItemToTrackerRecord(
    {
      type: 'episode',
      id: 62085,
      title: 'Pilot',
      ids: { imdb: 'tt0959621' },
      show: { ids: { imdb: 'tt0903747' }, title: 'Breaking Bad' },
      season_number: 1,
      number: 1,
      position_ms: 420_000,
      duration_ms: 2_700_000,
      updated_at: '2026-10-05T12:30:00.000Z',
    },
    { category: 'playing', status: 'added' }
  );

  assert.equal(record?.id, 'episode:imdb:tt0903747:s1:e1');
  assert.equal(record?.state, 'in_progress');
  assert.equal(record?.positionMs, 420_000);
  assert.equal(record?.durationMs, 2_700_000);
});

test('ratings, favorites, and notes have independent keys from playback progress', () => {
  const base = {
    type: 'movie',
    id: 126,
    title: 'The Dark Knight',
    ids: { imdb: 'tt0468569' },
    action_at: '2026-10-01T12:30:00.000Z',
  };
  const favorite = mapWeTrakrItemToTrackerRecord(base, {
    category: 'favorites',
    status: 'added',
  });
  const rating = mapWeTrakrItemToTrackerRecord(
    { ...base, rating: 9.5 },
    {
      category: 'ratings',
      status: 'updated',
    }
  );
  const note = mapWeTrakrItemToTrackerRecord(
    { ...base, text: 'Rewatch the IMAX cut.' },
    {
      category: 'notes',
      status: 'added',
    }
  );
  assert.equal(favorite?.id, 'movie:imdb:tt0468569|favorite');
  assert.equal(rating?.id, 'movie:imdb:tt0468569|rated');
  assert.equal(rating?.rating, 9.5);
  assert.equal(note?.id, 'movie:imdb:tt0468569|note');
  assert.equal(note?.text, 'Rewatch the IMAX cut.');
  assert.notEqual(favorite?.id, rating?.id);
});

test('removal tombstones the matching facet instead of erasing playback state', () => {
  const removed = mapWeTrakrJournalEntry({
    category: 'favorites',
    status: 'removed',
    type: 'movie',
    id: 126,
    ids: { imdb: 'tt0468569' },
    action_at: '2026-10-01T12:30:00.000Z',
  });
  assert.equal(removed?.id, 'movie:imdb:tt0468569|favorite');
  assert.equal(removed?.state, 'deleted');
  assert.equal(removed?.deletedState, 'favorite');
});

test('malformed and unsupported provider entries are ignored safely', () => {
  assert.equal(
    mapWeTrakrJournalEntry({ category: 'unknown', type: 'movie' }),
    null
  );
  assert.equal(
    mapWeTrakrJournalEntry({ category: 'watched', type: 'movie' }),
    null
  );
});

test('account snapshot importer visits supported endpoints and leaves ignored changes to the journal', async () => {
  const paths: string[] = [];
  const records = await fetchWeTrakrAccountRecords(async (path) => {
    paths.push(path);
    const data = path.startsWith('/sync/tracking/playing/all')
      ? [
          {
            type: 'movie',
            id: 126,
            ids: { imdb: 'tt0468569' },
            title: 'The Dark Knight',
            position_ms: 600_000,
            duration_ms: 9_000_000,
            updated_at: '2026-10-05T12:30:00.000Z',
          },
        ]
      : path.startsWith('/sync/ratings/all')
      ? [
          {
            type: 'movie',
            id: 126,
            ids: { imdb: 'tt0468569' },
            title: 'The Dark Knight',
            rating: 9,
            rated_at: '2026-10-01T12:30:00.000Z',
          },
        ]
      : path.startsWith('/sync/comments/all')
        ? [
            {
              id: 80055,
              target: 'movies',
              text: 'A great rewatch.',
              movie: {
                id: 126,
                ids: { imdb: 'tt0468569' },
                title: 'The Dark Knight',
              },
              comment_added_at: '2026-10-01T12:30:00.000Z',
            },
            {
              id: 80057,
              target: 'movies',
              parent_id: 80055,
              text: 'Adding my reply to the mirror.',
              movie: {
                id: 126,
                ids: { imdb: 'tt0468569' },
                title: 'The Dark Knight',
              },
              comment_added_at: '2026-10-01T12:31:00.000Z',
            },
          ]
        : path.startsWith('/sync/likes/all')
          ? [
              {
                list: { id: 42, name: 'Comfort rewatches' },
                like_added_at: '2026-10-01T12:31:00.000Z',
              },
              {
                comment: { id: 80056, text: 'A terrific episode.' },
                like_added_at: '2026-10-01T12:32:00.000Z',
              },
            ]
        : [];
    return { data, headers: new Headers({ 'x-pagination-page-count': '1' }) };
  });
  assert.ok(
    paths.some((path) =>
      path.startsWith('/sync/tracking/watched/history/movies?compact=true')
    )
  );
  assert.ok(
    paths.some((path) =>
      path.startsWith('/sync/tracking/watched/history/episodes?compact=true')
    )
  );
  assert.ok(paths.some((path) => path.startsWith('/sync/favorites/all')));
  assert.ok(paths.some((path) => path.startsWith('/sync/likes/all')));
  assert.ok(
    paths.every((path) => !path.startsWith('/sync/tracking/ignored/all'))
  );
  assert.ok(paths.some((path) => path.startsWith('/sync/notes/all')));
  assert.ok(
    paths.some((path) =>
      path.startsWith('/sync/comments/all?include_replies=true')
    )
  );
  assert.ok(
    records.some(
      (record) =>
        record.id === 'movie:imdb:tt0468569|rated' && record.rating === 9
    )
  );
  assert.ok(
    records.some(
      (record) =>
        record.id === 'movie:imdb:tt0468569' &&
        record.state === 'in_progress' &&
        record.positionMs === 600_000
    )
  );
  assert.ok(
    records.some(
      (record) =>
        record.id === 'movie:imdb:tt0468569|comment:80055' &&
        record.state === 'comment'
    )
  );
  assert.ok(
    records.some(
      (record) =>
        record.id === 'movie:imdb:tt0468569|comment:80057' &&
        record.parentId === '80055' &&
        record.text === 'Adding my reply to the mirror.'
    )
  );
  assert.ok(
    records.some(
      (record) =>
        record.id === 'list:wetrakr:list:42|liked' &&
        record.kind === 'list' &&
        record.providerId === '42' &&
        record.state === 'liked'
    )
  );
  assert.ok(
    records.some(
      (record) =>
        record.id === 'comment:wetrakr:comment:80056|liked' &&
        record.kind === 'comment' &&
        record.providerId === '80056' &&
        record.text === 'A terrific episode.' &&
        record.state === 'liked'
    )
  );
});

test('partial account snapshot retains allowed facets and reports a denied facet safely', async () => {
  const snapshot = await fetchWeTrakrAccountSnapshot(async (path) => {
    if (path.startsWith('/sync/likes/all')) {
      throw Object.assign(new Error('private upstream body must not escape'), {
        status: 403,
        endpoint: 'likes_all',
        providerCode: 'PRIVATE',
      });
    }
    return {
      data: path.startsWith('/sync/tracking/playing/all')
        ? [
            {
              type: 'movie',
              ids: { imdb: 'tt0468569' },
              title: 'The Dark Knight',
              position_ms: 60_000,
              duration_ms: 9_000_000,
              updated_at: '2026-10-05T12:30:00.000Z',
            },
          ]
        : [],
      headers: new Headers({ 'x-pagination-page-count': '1' }),
    };
  });

  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0]?.state, 'in_progress');
  assert.deepEqual(snapshot.failures, [
    {
      endpoint: 'likes_all',
      facetId: 'likes_all',
      status: 403,
      providerCode: 'PRIVATE',
    },
  ]);
  assert.equal(JSON.stringify(snapshot).includes('private upstream body'), false);
});

test('partial snapshot classifies malformed history cursors without retaining provider text', async () => {
  const paths: string[] = [];
  const snapshot = await fetchWeTrakrAccountSnapshot(async (path) => {
    paths.push(path);
    return {
      data: [],
      headers: path.includes('/history/episodes')
        ? new Headers({ 'x-pagination-next': 'repeated-cursor' })
        : new Headers({ 'x-pagination-page-count': '1' }),
    };
  });

  assert.equal(
    paths.filter((path) => path.includes('/history/episodes')).length,
    2
  );
  assert.deepEqual(
    snapshot.failures.find(
      (failure) =>
        failure.endpoint === 'sync_tracking_watched_history_episodes'
    ),
    {
      endpoint: 'sync_tracking_watched_history_episodes',
      facetId: 'sync_tracking_watched_history_episodes',
      reason: 'invalid_history_cursor',
    }
  );
});

test('partial WeTrakr snapshots retry only failed facets after persisting successful facets', async () => {
  const firstPaths: string[] = [];
  const first = await fetchWeTrakrAccountSnapshot(async (path) => {
    firstPaths.push(path);
    if (path.startsWith('/sync/likes/all'))
      throw Object.assign(new Error('denied'), { status: 403 });
    return { data: [], headers: new Headers({ 'x-pagination-page-count': '1' }) };
  });
  assert.ok(first.completedFacets.includes('sync_tracking_watched_history_episodes'));
  assert.ok(!first.completedFacets.includes('likes_all'));
  assert.equal(first.authoritative, false);

  const retryPaths: string[] = [];
  const retry = await fetchWeTrakrAccountSnapshot(
    async (path) => {
      retryPaths.push(path);
      return { data: [], headers: new Headers({ 'x-pagination-page-count': '1' }) };
    },
    { completedFacets: first.completedFacets }
  );
  assert.deepEqual(retryPaths, ['/sync/likes/all?page=1&limit=100']);
  assert.ok(retry.completedFacets.includes('likes_all'));
  assert.ok(retry.completedFacets.includes('sync_lists_items'));
  assert.ok(retry.completedFacets.includes('sync_lists'));
  assert.deepEqual(retry.failures, []);
  assert.equal(retry.authoritative, false);
  assert.ok(firstPaths.length > retryPaths.length);
});

test('account snapshot bounds concurrent WeTrakr reads across lists and facets', async () => {
  let active = 0;
  let maxActive = 0;
  const records = await fetchWeTrakrAccountRecords(async (path) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    const data = path.startsWith('/sync/lists?')
      ? Array.from({ length: 20 }, (_, index) => ({
          id: index + 1,
          name: `List ${index + 1}`,
        }))
      : [];
    return { data, headers: new Headers({ 'x-pagination-page-count': '1' }) };
  });

  assert.equal(maxActive, 4);
  assert.equal(records.filter((record) => record.kind === 'list').length, 20);
});

test('incremental journal import follows the safe visible checkpoint and preserves removed plays', async () => {
  const requests: string[] = [];
  const delta = await fetchWeTrakrJournalDelta(async (path) => {
    requests.push(path);
    return {
      data: {
        visible_until: '2026-10-05T12:00:00.000Z',
        journal: [
          {
            entry_id: 'journal-1',
            category: 'favorites',
            status: 'added',
            action_at: '2026-10-05T11:59:58.000Z',
            type: 'movie',
            id: 126,
            title: 'The Dark Knight',
            ids: { imdb: 'tt0468569' },
          },
          {
            entry_id: 'journal-2',
            category: 'watched',
            status: 'removed',
            action_at: '2026-10-05T11:59:59.000Z',
            type: 'episode',
            id: 62085,
            title: 'Pilot',
            ids: { imdb: 'tt0959621' },
            show: { title: 'Breaking Bad', ids: { imdb: 'tt0903747' } },
            season_number: 1,
            number: 1,
            play_id: 778,
          },
          {
            entry_id: 'journal-3',
            category: 'ignored',
            status: 'added',
            action_at: '2026-10-05T11:59:59.500Z',
            type: 'episode',
            id: 62086,
            title: 'Cat\'s in the Bag...',
            ids: { imdb: 'tt0959622' },
            show: { title: 'Breaking Bad', ids: { imdb: 'tt0903747' } },
            season_number: 1,
            number: 2,
          },
        ],
      },
      headers: new Headers({ 'x-pagination-page-count': '1' }),
    };
  }, '2026-10-05T11:00:00.000Z');

  assert.equal(requests.length, 1);
  assert.match(
    requests[0],
    /^\/sync\/journal\?from_date=2026-10-05T11%3A00%3A00\.000Z&page=1&limit=1000$/
  );
  assert.equal(delta.checkpoint, '2026-10-05T12:00:00.000Z');
  assert.deepEqual(delta.entryIds, ['journal-1', 'journal-2', 'journal-3']);
  assert.ok(delta.records.some((record) => record.state === 'favorite'));
  assert.ok(delta.records.some((record) => record.state === 'ignored'));
  const removedPlay = delta.records.find((record) =>
    record.id.endsWith('|play:778')
  );
  assert.equal(removedPlay?.state, 'deleted');
  assert.equal(removedPlay?.deletedState, 'play');
});

test('compact history snapshot follows provider cursors and preserves play IDs', async () => {
  const paths: string[] = [];
  const records = await fetchWeTrakrAccountRecords(async (path) => {
    paths.push(path);
    const parsed = new URL(path, 'https://api.wetrakr.com');
    if (parsed.pathname.endsWith('/history/movies')) {
      if (!parsed.searchParams.has('after')) {
        return {
          data: [
            {
              type: 'movie',
              id: 778,
              ids: { imdb: 'tt0468569' },
              watched_at: '2026-10-05T12:30:00.000Z',
            },
          ],
          headers: new Headers({ 'x-pagination-next': 'movie-cursor-2' }),
        };
      }
      return {
        data: [
          {
            type: 'movie',
            id: 779,
            ids: { imdb: 'tt0111161' },
            watched_at: '2026-10-04T12:30:00.000Z',
          },
        ],
        headers: new Headers(),
      };
    }
    if (parsed.pathname.endsWith('/history/episodes')) {
      return {
        data: [
          {
            type: 'episode',
            id: 880,
            ids: { imdb: 'tt0959621' },
            show_ids: { imdb: 'tt0903747' },
            season_number: 1,
            number: 1,
            watched_at: '2026-10-03T12:30:00.000Z',
          },
        ],
        headers: new Headers(),
      };
    }
    return {
      data: [],
      headers: new Headers({ 'x-pagination-page-count': '1' }),
    };
  });
  assert.ok(paths.includes(
    '/sync/tracking/watched/history/movies?compact=true&limit=1000'
  ));
  assert.ok(paths.includes(
    '/sync/tracking/watched/history/movies?compact=true&limit=1000&after=movie-cursor-2'
  ));
  assert.ok(paths.includes(
    '/sync/tracking/watched/history/episodes?compact=true&limit=1000'
  ));
  assert.ok(
    records.some((record) =>
      record.id === 'movie:imdb:tt0468569|play:778' && record.state === 'play'
    )
  );
  assert.ok(
    records.some((record) =>
      record.id === 'episode:imdb:tt0903747:s1:e1|play:880' &&
      record.state === 'play'
    )
  );
});

test('snapshot importer mirrors account lists and keeps each list membership distinct', async () => {
  const paths: string[] = [];
  const records = await fetchWeTrakrAccountRecords(async (path) => ({
    data: (paths.push(path), path.startsWith('/sync/lists?'))
      ? [{ id: 25, name: 'Sci-fi favorites', description: 'Saved films' }]
      : path.startsWith('/sync/lists/25/items')
        ? [
            {
              type: 'movie',
              id: 126,
              ids: { imdb: 'tt0468569' },
              title: 'The Dark Knight',
            },
          ]
        : [],
    headers: new Headers({ 'x-pagination-page-count': '1' }),
  }));
  assert.ok(paths.some((path) => path.startsWith('/sync/lists?')));
  assert.ok(paths.some((path) => path.startsWith('/sync/lists/25/items?')));
  const list = records.find((record) => record.kind === 'list');
  const member = records.find((record) => record.kind === 'movie');
  assert.equal(list?.listId, '25');
  assert.equal(list?.listIdProvider, 'wetrakr');
  assert.equal(list?.title, 'Sci-fi favorites');
  assert.equal(member?.id, 'movie:imdb:tt0468569|list:25');
  assert.equal(member?.listId, '25');
  assert.equal(member?.listIdProvider, 'wetrakr');
  assert.equal(member?.text, 'Sci-fi favorites');
});

test('comment rows map their target type, embedded media identity, and comment timestamp', () => {
  const comment = mapWeTrakrItemToTrackerRecord(
    {
      id: 80055,
      target: 'movies',
      text: 'A great rewatch.',
      movie: {
        id: 126,
        ids: { imdb: 'tt0468569', tmdb: 155 },
        title: 'The Dark Knight',
      },
      comment_added_at: '2026-10-05T12:30:00.000Z',
    },
    { category: 'comments' }
  );
  assert.equal(comment?.kind, 'movie');
  assert.equal(comment?.title, 'The Dark Knight');
  assert.equal(comment?.id, 'movie:imdb:tt0468569|comment:80055');
  assert.equal(comment?.providerId, '80055');
  assert.equal(comment?.providerIdProvider, 'wetrakr');
  assert.equal(comment?.text, 'A great rewatch.');
  assert.equal(comment?.updatedAt, Date.parse('2026-10-05T12:30:00.000Z'));
});

test('reaction-only comments round-trip through WeTrakr without adding blank text', () => {
  const imported = mapWeTrakrItemToTrackerRecord(
    {
      id: 80056,
      target: 'movies',
      reaction: 'like',
      movie: {
        id: 126,
        ids: { imdb: 'tt0468569' },
        title: 'The Dark Knight',
      },
      comment_added_at: '2026-10-05T12:31:00.000Z',
    },
    { category: 'comments' }
  );
  assert.equal(imported?.reaction, 'like');
  assert.equal(imported?.text, undefined);

  const planned = planWeTrakrWrites([
    { ...imported!, origin: 'nuvio', updatedAt: imported!.updatedAt + 1 },
  ]);
  const comment = planned.operations.find(
    (operation) => operation.path === '/sync/comments'
  );
  assert.deepEqual(comment?.body, {
    movie: { ids: { imdb: 'tt0468569' } },
    reaction: 'like',
  });
  assert.equal(planned.skipped, 0);
});

test('write planner maps merged progress, ratings, favorites, and deletions to WeTrakr APIs', () => {
  const base = {
    kind: 'movie' as const,
    ids: { imdb: 'tt0468569' },
    title: 'The Dark Knight',
    updatedAt: 1_800_000_000_000,
    origin: 'nuvio',
    revision: 0,
  };
  const progress = {
    ...base,
    id: 'movie:imdb:tt0468569',
    state: 'in_progress' as const,
    positionMs: 900_000,
    durationMs: 1_800_000,
  };
  const rating = {
    ...base,
    id: 'movie:imdb:tt0468569|rated',
    state: 'rated' as const,
    rating: 9.2,
  };
  const removedFavorite = {
    ...base,
    id: 'movie:imdb:tt0468569|favorite',
    state: 'deleted' as const,
    deletedState: 'favorite' as const,
  };
  const plan = planWeTrakrWrites([progress, rating, removedFavorite]);
  assert.equal(plan.skipped, 0);
  assert.deepEqual(plan.operations.map((operation) => operation.path).sort(), [
    '/sync/favorites/remove',
    '/sync/ratings',
    '/sync/tracking',
  ]);
  const tracking = plan.operations.find(
    (operation) => operation.path === '/sync/tracking'
  );
  assert.deepEqual(tracking?.body, {
    movies: [{ ids: { imdb: 'tt0468569' }, status: 'watching' }],
    allow_rewatch: false,
  });
  const ratingWrite = plan.operations.find(
    (operation) => operation.path === '/sync/ratings'
  );
  assert.deepEqual(ratingWrite?.body, {
    movies: [{ ids: { imdb: 'tt0468569' }, rating: 9.2 }],
  });
});

test('episode writes use parent-show ids and preserve season/episode numbering', () => {
  const plan = planWeTrakrWrites([
    {
      id: 'episode:imdb:tt0903747:s2:e3',
      kind: 'episode',
      ids: { imdb: 'tt0903747', tmdb: '1396' },
      title: 'Breaking Bad',
      seriesTitle: 'Breaking Bad',
      episodeTitle: 'Bit by a Dead Bee',
      season: 2,
      episode: 3,
      state: 'watched',
      updatedAt: 1_800_000_000_000,
      origin: 'nuvio',
      revision: 0,
    },
  ]);
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].path, '/sync/tracking');
  assert.deepEqual(plan.operations[0].body, {
    shows: [
      {
        ids: { imdb: 'tt0903747', tmdb: '1396' },
        seasons: [{ number: 2, episodes: [{ number: 3, status: 'watched' }] }],
      },
    ],
    allow_rewatch: false,
  });
});

test('waiting and ignored tracking states are preserved on WeTrakr writes', () => {
  const common = {
    kind: 'movie' as const,
    ids: { imdb: 'tt0468569' },
    updatedAt: 1_800_000_000_000,
    origin: 'nuvio',
    revision: 1,
  };
  const plan = planWeTrakrWrites([
    { ...common, id: 'movie:tt0468569|waiting', state: 'waiting' },
    { ...common, id: 'movie:tt0468569|ignored', state: 'ignored' },
  ]);

  assert.equal(plan.skipped, 0);
  assert.deepEqual(
    plan.operations.find((operation) => operation.path === '/sync/tracking')
      ?.body,
    {
      movies: [
        { ids: { imdb: 'tt0468569' }, status: 'ignored' },
        { ids: { imdb: 'tt0468569' }, status: 'waiting' },
      ],
      allow_rewatch: false,
    }
  );
});

test('notes, comments, and existing-list memberships fan out with bounded deletes', () => {
  const common = {
    ids: { imdb: 'tt0468569' },
    updatedAt: 1_800_000_000_000,
    origin: 'nuvio',
    revision: 1,
  };
  const plan = planWeTrakrWrites([
    {
      ...common,
      id: 'movie:tt0468569|note:1',
      kind: 'movie',
      title: 'The Dark Knight',
      state: 'note',
      text: 'Watch the IMAX cut.',
      spoiler: false,
    },
    {
      ...common,
      id: 'movie:tt0468569|comment:2',
      kind: 'movie',
      title: 'The Dark Knight',
      state: 'comment',
      text: 'Still holds up.',
      spoiler: false,
    },
    {
      ...common,
      id: 'movie:tt0468569|list:42',
      kind: 'movie',
      title: 'The Dark Knight',
      state: 'list',
      listId: '42',
      listIdProvider: 'wetrakr',
      listRank: 3,
    },
    {
      ...common,
      id: 'movie:tt0468569|list:42:deleted',
      kind: 'movie',
      title: 'The Dark Knight',
      state: 'deleted',
      deletedState: 'list',
      listId: '42',
      listIdProvider: 'wetrakr',
    },
    {
      ...common,
      id: 'movie:tt0468569|note:deleted',
      kind: 'movie',
      title: 'The Dark Knight',
      state: 'deleted',
      deletedState: 'note',
    },
  ]);

  assert.equal(
    plan.skipped,
    1,
    'note tombstones must not delete every note for a title'
  );
  const note = plan.operations.find((operation) => operation.path === '/notes');
  assert.deepEqual(note?.body, {
    movies: [{ ids: common.ids, text: 'Watch the IMAX cut.', spoiler: false }],
  });
  const comment = plan.operations.find(
    (operation) => operation.path === '/sync/comments'
  );
  assert.deepEqual(comment?.body, {
    movie: { ids: common.ids },
    text: 'Still holds up.',
    spoiler: false,
  });
  const listAdd = plan.operations.find(
    (operation) => operation.path === '/sync/lists/42/items'
  );
  assert.deepEqual(listAdd?.body, { movies: [{ ids: common.ids, rank: 3 }] });
  const listRemove = plan.operations.find(
    (operation) => operation.path === '/sync/lists/42/items/remove'
  );
  assert.deepEqual(listRemove?.body, { movies: [{ ids: common.ids }] });
});

test('comment tombstone deletes only its mapped WeTrakr comment', () => {
  const plan = planWeTrakrWrites([
    {
      id: 'comment:80055',
      kind: 'movie',
      ids: { imdb: 'tt0468569' },
      state: 'deleted',
      deletedState: 'comment',
      providerId: '80055',
      providerIdProvider: 'wetrakr',
      updatedAt: 1_800_000_000_001,
      origin: 'nuvio',
      revision: 2,
    },
  ]);
  assert.deepEqual(plan.operations, [
    {
      method: 'DELETE',
      path: '/sync/comments/80055',
      recordIds: ['comment:80055'],
    },
  ]);
});

test('comment and like tombstones never delete an unowned provider id', () => {
  const plan = planWeTrakrWrites([
    {
      id: 'comment:external:80055',
      kind: 'movie',
      ids: { imdb: 'tt0468569' },
      state: 'deleted',
      deletedState: 'comment',
      providerId: '80055',
      providerIdProvider: 'other-tracker',
      updatedAt: 1_800_000_000_001,
      origin: 'nuvio',
      revision: 2,
    },
    {
      id: 'comment:external:80056|liked',
      kind: 'comment',
      ids: {},
      state: 'deleted',
      deletedState: 'liked',
      providerId: '80056',
      providerIdProvider: 'other-tracker',
      updatedAt: 1_800_000_000_002,
      origin: 'nuvio',
      revision: 1,
    },
    {
      id: 'movie:imdb:tt0468569|list:42',
      kind: 'movie',
      ids: { imdb: 'tt0468569' },
      state: 'deleted',
      deletedState: 'list',
      listId: '42',
      listIdProvider: 'another-tracker',
      updatedAt: 1_800_000_000_003,
      origin: 'nuvio',
      revision: 1,
    },
  ]);
  assert.deepEqual(plan.operations, []);
  assert.equal(plan.skipped, 3);
});

test('list and comment likes map to idempotent provider-specific mutations', () => {
  const plan = planWeTrakrWrites([
    {
      id: 'list:wetrakr:list:42|liked',
      kind: 'list',
      ids: {},
      providerId: '42',
      providerIdProvider: 'wetrakr',
      state: 'liked',
      updatedAt: 1_800_000_000_000,
      origin: 'nuvio',
    },
    {
      id: 'comment:wetrakr:comment:80056|liked',
      kind: 'comment',
      ids: {},
      providerId: '80056',
      providerIdProvider: 'wetrakr',
      text: 'A terrific episode.',
      state: 'deleted',
      deletedState: 'liked',
      updatedAt: 1_800_000_000_001,
      origin: 'nuvio',
    },
  ]);
  assert.equal(plan.skipped, 0);
  assert.deepEqual(
    plan.operations.map(({ method, path }) => ({ method, path })),
    [
      { method: 'DELETE', path: '/comments/80056/like' },
      { method: 'POST', path: '/lists/42/like' },
    ]
  );
});

test('comment deletion is sent with an idempotency key and no body', async () => {
  const calls: Array<{
    path: string;
    method: string;
    body?: unknown;
    idempotencyKey: string;
  }> = [];
  const result = await pushWeTrakrRecords(
    [
      {
        id: 'comment:80055',
        kind: 'movie',
        ids: { imdb: 'tt0468569' },
        state: 'deleted',
        deletedState: 'comment',
        providerId: '80055',
        providerIdProvider: 'wetrakr',
        updatedAt: 1_800_000_000_001,
        origin: 'nuvio',
        revision: 2,
      },
    ],
    async (path, init) => {
      calls.push({
        path,
        method: init.method,
        body: init.body,
        idempotencyKey: init.idempotencyKey,
      });
      return { data: { success: true } };
    }
  );
  assert.equal(result.synced, 1);
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].body, undefined);
  assert.match(calls[0].idempotencyKey, /^[a-f0-9]{64}$/);
});

test('provider-origin records never echo and unsupported writes are reported', async () => {
  const imported = mapWeTrakrJournalEntry({
    category: 'favorites',
    status: 'added',
    type: 'movie',
    id: 126,
    ids: { imdb: 'tt0468569' },
  })!;
  const note = mapWeTrakrItemToTrackerRecord(
    {
      type: 'movie',
      id: 126,
      ids: { imdb: 'tt0468569' },
      text: 'A private note',
    },
    { category: 'notes' }
  )!;
  const deletedNote = {
    ...note,
    id: `${note.id}|deleted`,
    origin: 'nuvio',
    state: 'deleted' as const,
    deletedState: 'note' as const,
  };
  const calls: Array<{ path: string; body: unknown }> = [];
  const result = await pushWeTrakrRecords(
    [imported, note, deletedNote],
    async (path, init) => {
      calls.push({ path, body: init.body });
      return { data: { success: true } };
    }
  );
  assert.equal(calls.length, 0);
  assert.equal(result.synced, 0);
  assert.equal(result.skipped, 1);
});

test('provider retries reuse deterministic idempotency keys and revisions rotate them', async () => {
  const source: TrackerRecord = {
    id: 'movie:imdb:tt0468569',
    kind: 'movie',
    ids: { imdb: 'tt0468569' },
    title: 'The Dark Knight',
    state: 'watched',
    updatedAt: 1_800_000_000_000,
    origin: 'nuvio',
    revision: 1,
  };
  const keys: string[] = [];
  const send = async (record: TrackerRecord) =>
    pushWeTrakrRecords([record], async (_path, init) => {
      keys.push(init.idempotencyKey);
      return { data: { success: true } };
    });

  await send(source);
  await send(source);
  await send({ ...source, updatedAt: source.updatedAt + 1, revision: 2 });

  assert.match(keys[0], /^[a-f0-9]{64}$/);
  assert.equal(keys[1], keys[0]);
  assert.notEqual(keys[2], keys[0]);
});
