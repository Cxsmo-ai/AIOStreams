import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isNsfwContent,
  filterNsfwCatalogItems,
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
