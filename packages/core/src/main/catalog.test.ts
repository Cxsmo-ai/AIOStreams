import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isNsfwContent,
  filterNsfwCatalogItems,
  deduplicateCatalogItems,
  normalizeSeriesCatalogItems,
} from './catalog.js';
import type { MetaPreview } from '../db/schemas.js';

test('isNsfwContent flags adult keywords in title, description, or genres', () => {
  assert.equal(
    isNsfwContent({ name: 'Clean Show', genres: ['Action', 'Drama'] }),
    false
  );
  assert.equal(
    isNsfwContent({ name: 'Secret Erotica Film', genres: ['Drama'] }),
    true
  );
  assert.equal(
    isNsfwContent({ name: 'Animation Special', genres: ['Hentai'] }),
    true
  );
  assert.equal(
    isNsfwContent({
      name: 'Documentary',
      description: 'Explicit porn scene analysis',
      genres: ['Documentary'],
    }),
    true
  );
  assert.equal(isNsfwContent({ name: 'Adult Movie', isAdult: true }), true);
});

test('filterNsfwCatalogItems removes NSFW items while keeping clean ones', () => {
  const items: MetaPreview[] = [
    {
      id: 'tt1480669',
      type: 'series',
      name: 'Tower Prep',
      poster: 'https://img.com/tp.jpg',
    },
    {
      id: 'tt9999999',
      type: 'movie',
      name: 'Brazzers Special 18+',
      poster: 'https://img.com/xxx.jpg',
    },
    {
      id: 'tt0120338',
      type: 'movie',
      name: 'Titanic',
      poster: 'https://img.com/titanic.jpg',
    },
  ];
  const filtered = filterNsfwCatalogItems(items);
  assert.equal(filtered.length, 2);
  assert.deepEqual(
    filtered.map((i) => i.name),
    ['Tower Prep', 'Titanic']
  );
});

test('series season previews collapse to one root show with one poster', () => {
  const items: MetaPreview[] = Array.from(
    { length: 10 },
    (_, index) =>
      ({
        id: `tt1234567:${index + 1}:1`,
        type: 'series',
        name: `Kitchen Nightmares Season ${index + 1}`,
        poster:
          index === 4
            ? 'https://img.example/kitchen-nightmares.jpg'
            : undefined,
        season: index + 1,
        episode: 1,
      }) as MetaPreview
  );

  const normalized = normalizeSeriesCatalogItems(items, 'series');

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].id, 'tt1234567');
  assert.equal(normalized[0].name, 'Kitchen Nightmares');
  assert.equal(
    normalized[0].poster,
    'https://img.example/kitchen-nightmares.jpg'
  );
  assert.equal((normalized[0] as any).season, undefined);
  assert.equal((normalized[0] as any).episode, undefined);
});

test('series normalization supports TVDB and TMDB without changing movies', () => {
  const series = normalizeSeriesCatalogItems(
    [
      { id: 'tvdb:81189:1:1', type: 'series', name: 'Show', poster: null },
      {
        id: 'tvdb:81189:10:1',
        type: 'series',
        name: 'Show',
        poster: 'tvdb.jpg',
      },
      {
        id: 'tmdb:1399:1:1',
        type: 'series',
        name: 'Other Show',
        poster: 'tmdb.jpg',
      },
    ],
    'series'
  );
  assert.deepEqual(
    series.map((item) => item.id),
    ['tvdb:81189', 'tmdb:1399']
  );
  assert.equal(series[0].poster, 'tvdb.jpg');

  const movies: MetaPreview[] = [
    { id: 'tt1234567:1:1', type: 'movie', name: 'Movie', poster: 'movie.jpg' },
  ];
  assert.deepEqual(normalizeSeriesCatalogItems(movies, 'movie'), movies);
});

test('catalog dedup merges provider variants and keeps the richest fields', () => {
  const result = deduplicateCatalogItems([
    {
      id: 'tvdb:81189',
      type: 'series',
      name: 'Kitchen Nightmares (2007)',
      releaseInfo: '2007-',
      poster: null,
      description: 'A cooking show.',
      country: 'US',
    },
    {
      id: 'tt0988818',
      type: 'series',
      name: 'Kitchen Nightmares',
      releaseInfo: 2007,
      poster: 'https://img.example/kitchen.jpg',
      description: 'Gordon Ramsay visits struggling restaurants.',
      genres: ['Reality'],
      trailers: [{ source: 'yt', type: 'Trailer', video_id: 'abc' }],
      imdb_id: 'tt0988818',
      country: 'US',
    },
  ] as MetaPreview[]);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'tt0988818');
  assert.equal(result[0].poster, 'https://img.example/kitchen.jpg');
  assert.equal(
    result[0].description,
    'Gordon Ramsay visits struggling restaurants.'
  );
  assert.deepEqual(result[0].genres, ['Reality']);
  assert.equal(result[0].trailers?.length, 1);
});

test('catalog dedup does not merge same-title reboots with conflicting identity facts', () => {
  const result = deduplicateCatalogItems([
    {
      id: 'tt1111111',
      type: 'series',
      name: 'The Office',
      releaseInfo: 2001,
      country: 'GB',
    },
    {
      id: 'tt2222222',
      type: 'series',
      name: 'The Office',
      releaseInfo: 2005,
      country: 'US',
    },
  ] as MetaPreview[]);

  assert.deepEqual(
    result.map((item) => item.id),
    ['tt1111111', 'tt2222222']
  );
});

test('catalog dedup does not merge distinct records from one provider in the same year', () => {
  const result = deduplicateCatalogItems([
    { id: 'tmdb:101', type: 'series', name: 'The Bridge', releaseInfo: 2013 },
    { id: 'tmdb:202', type: 'series', name: 'The Bridge', releaseInfo: 2013 },
  ] as MetaPreview[]);

  assert.deepEqual(
    result.map((item) => item.id),
    ['tmdb:101', 'tmdb:202']
  );
});

test('catalog dedup does not let a sparse record bridge conflicting reboots', () => {
  const result = deduplicateCatalogItems([
    { id: 'tvdb:301', type: 'series', name: 'The Bridge' },
    { id: 'tt3010001', type: 'series', name: 'The Bridge', releaseInfo: 2013 },
    { id: 'tt3010002', type: 'series', name: 'The Bridge', releaseInfo: 2024 },
  ] as MetaPreview[]);

  assert.deepEqual(
    result.map((item) => item.id),
    ['tt3010001', 'tt3010002']
  );
  assert.equal(result[0]?.releaseInfo, 2013);
});

test('catalog dedup uses explicit cross-provider IDs when titles differ', () => {
  const result = deduplicateCatalogItems([
    {
      id: 'tmdb:123',
      type: 'series',
      name: 'The Great Kitchen Rescue',
      tmdb_id: 123,
      poster: 'tmdb.jpg',
    },
    {
      id: 'tvdb:456',
      type: 'series',
      name: 'Kitchen Rescue',
      tvdb_id: 456,
      tmdb_id: 123,
      description: 'Long description',
    },
  ] as MetaPreview[]);

  assert.equal(result.length, 1);
  assert.equal(result[0].tmdb_id, 123);
  assert.equal(result[0].description, 'Long description');
});
