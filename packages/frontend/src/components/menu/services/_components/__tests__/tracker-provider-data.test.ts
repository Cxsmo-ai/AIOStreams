import { describe, expect, it } from 'vitest';
import {
  catalogItems,
  catalogPoster,
  makeCatalogTrackerRecord,
  makeCatalogTrackerTombstone,
  makeListMembershipRecord,
  trackerActionErrorMessage,
} from '../tracker-provider-data';

describe('tracker provider account data', () => {
  it('guides the user to save a locally linked WeTrakr provider before account actions', () => {
    expect(
      trackerActionErrorMessage(
        new Error(
          'Connect and enable WeTrakr in this AIOStreams profile first.'
        ),
        'WeTrakr sync failed'
      )
    ).toBe(
      'The saved AIOStreams profile does not have WeTrakr enabled yet. Use the main Save button to save this configuration, then retry.'
    );
  });

  it('preserves unrelated tracker errors and uses a fallback for unknown errors', () => {
    expect(
      trackerActionErrorMessage(new Error('Provider timed out'), 'Sync failed')
    ).toBe('Provider timed out');
    expect(trackerActionErrorMessage('unexpected failure', 'Sync failed')).toBe(
      'Sync failed'
    );
  });

  it('combines grouped movie and show history without duplicating shared rows', () => {
    const movie = { id: 1, title: 'Movie' };
    const show = { id: 2, title: 'Show' };
    expect(
      catalogItems({ data: { movies: [movie], shows: [show, movie] } })
    ).toEqual([movie, show]);
  });

  it('unwraps common API envelopes and caps rendered account cards', () => {
    const rows = Array.from({ length: 45 }, (_, id) => ({ id }));
    expect(catalogItems({ data: { results: rows } })).toHaveLength(40);
    expect(catalogItems({ data: rows.slice(0, 2) })).toEqual(rows.slice(0, 2));
    expect(catalogItems(null)).toEqual([]);
    expect(catalogItems({ data: { results: rows } }, 100)).toHaveLength(45);
  });

  it('creates a canonical provider-neutral list membership and matching tombstone', () => {
    const movie = {
      id: 22,
      title: 'The Dark Knight',
      ids: { imdb: 'tt0468569', tmdb: 155 },
    };
    const list = { id: 42, name: 'Favorites' };
    const record = makeListMembershipRecord(movie, 'movie', list, 'list', 1234);
    expect(record).toMatchObject({
      id: 'movie:imdb:tt0468569|list:42',
      kind: 'movie',
      ids: { imdb: 'tt0468569', tmdb: '155' },
      title: 'The Dark Knight',
      state: 'list',
      listId: '42',
      listIdProvider: 'wetrakr',
      listName: 'Favorites',
      updatedAt: 1234,
      origin: 'aiostreams-ui',
    });
    expect(
      makeListMembershipRecord(movie, 'movie', list, 'deleted', 1235)
    ).toMatchObject({
      id: 'movie:imdb:tt0468569|list:42',
      state: 'deleted',
      deletedState: 'list',
      listIdProvider: 'wetrakr',
    });
    expect(makeListMembershipRecord(movie, 'episode', list)).toBeNull();
    expect(makeListMembershipRecord(movie, 'movie', { id: 'bad' })).toBeNull();
  });

  it('creates merged rating, favorite, note, and comment writes with portable identities', () => {
    const movie = {
      id: 22,
      title: 'The Dark Knight',
      ids: { imdb: 'tt0468569', tmdb: 155 },
    };
    expect(
      makeCatalogTrackerRecord(
        movie,
        'movie',
        { state: 'rated', rating: 8.6 },
        2000
      )
    ).toMatchObject({
      id: 'movie:imdb:tt0468569|rated',
      kind: 'movie',
      ids: { imdb: 'tt0468569', tmdb: '155' },
      state: 'rated',
      rating: 8.6,
      origin: 'aiostreams-ui',
      updatedAt: 2000,
    });
    expect(
      makeCatalogTrackerRecord(
        movie,
        'movie',
        { state: 'favorite' },
        2001
      )
    ).toMatchObject({ id: 'movie:imdb:tt0468569|favorite', state: 'favorite' });
    expect(
      makeCatalogTrackerRecord(
        movie,
        'movie',
        { state: 'note', text: '  Rewatch the IMAX cut.  ', spoiler: true },
        2002
      )
    ).toMatchObject({
      id: 'movie:imdb:tt0468569|note',
      state: 'note',
      text: 'Rewatch the IMAX cut.',
      spoiler: true,
    });
    expect(
      makeCatalogTrackerRecord(
        movie,
        'movie',
        { state: 'comment', text: 'Great film.' },
        2003,
        'comment-1'
      )
    ).toMatchObject({
      id: 'movie:imdb:tt0468569|comment:comment-1',
      state: 'comment',
      text: 'Great film.',
    });
  });

  it('rejects non-portable or invalid writes and creates safe item-scoped tombstones', () => {
    const movie = { id: 22, title: 'Film', ids: { imdb: 'tt1234567' } };
    expect(
      makeCatalogTrackerRecord(movie, 'movie', { state: 'rated', rating: 11 })
    ).toBeNull();
    expect(
      makeCatalogTrackerRecord(movie, 'movie', { state: 'note', text: '  ' })
    ).toBeNull();
    expect(
      makeCatalogTrackerRecord(movie, 'movie', {
        state: 'note',
        text: 'n'.repeat(10_001),
      })
    ).toBeNull();
    expect(
      makeCatalogTrackerRecord(
        movie,
        'movie',
        { state: 'comment', text: 'x'.repeat(10_001) },
        3000,
        'comment-2'
      )
    ).toBeNull();
    expect(
      makeCatalogTrackerRecord(
        movie,
        'movie',
        { state: 'comment', reaction: 'r'.repeat(81) },
        3000,
        'comment-3'
      )
    ).toBeNull();
    expect(
      makeCatalogTrackerRecord(movie, 'movie', { state: 'comment' }, 3000, '')
    ).toBeNull();
    expect(
      makeCatalogTrackerRecord({ id: 9, title: 'No global ID' }, 'movie', {
        state: 'favorite',
      })
    ).toBeNull();
    expect(
      makeCatalogTrackerTombstone(movie, 'movie', 'favorite', 3001)
    ).toMatchObject({
      id: 'movie:imdb:tt1234567|favorite',
      state: 'deleted',
      deletedState: 'favorite',
      updatedAt: 3002,
      origin: 'aiostreams-ui',
    });
  });

  it('renders WeTrakr likes that reference a list or comment object', () => {
    expect(
      catalogItems({
        data: [
          {
            list: { id: 42, name: 'Favorites to revisit' },
            like_added_at: '2026-10-05T12:00:00.000Z',
          },
          {
            comment: { id: 17, text: 'A terrific episode.' },
            like_added_at: '2026-10-05T12:01:00.000Z',
          },
        ],
      })
    ).toEqual([
      {
        id: 42,
        name: 'Favorites to revisit',
        like_added_at: '2026-10-05T12:00:00.000Z',
        likedTargetType: 'list',
      },
      {
        id: 17,
        text: 'A terrific episode.',
        like_added_at: '2026-10-05T12:01:00.000Z',
        likedTargetType: 'comment',
      },
    ]);
  });

  it('allows TMDB posters and rejects arbitrary remote image hosts', () => {
    expect(catalogPoster({ poster_path: '/poster.jpg' })).toBe(
      'https://image.tmdb.org/t/p/w185/poster.jpg'
    );
    expect(
      catalogPoster({ posterUrl: 'https://image.tmdb.org/t/p/w185/poster.jpg' })
    ).toBe('https://image.tmdb.org/t/p/w185/poster.jpg');
    expect(catalogPoster({ posterUrl: 'https://attacker.example/p.jpg' })).toBe(
      null
    );
  });
});
