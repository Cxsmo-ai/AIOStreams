
import assert from 'node:assert/strict';
import test from 'node:test';
import { isNsfwContent, filterNsfwCatalogItems } from './catalog.js';
import type { MetaPreview } from '../db/schemas.js';

test('isNsfwContent flags adult keywords in title, description, or genres', () => {
  assert.equal(isNsfwContent({ name: 'Clean Show', genres: ['Action', 'Drama'] }), false);
  assert.equal(isNsfwContent({ name: 'Secret Erotica Film', genres: ['Drama'] }), true);
  assert.equal(isNsfwContent({ name: 'Animation Special', genres: ['Hentai'] }), true);
  assert.equal(isNsfwContent({ name: 'Documentary', description: 'Explicit porn scene analysis', genres: ['Documentary'] }), true);
  assert.equal(isNsfwContent({ name: 'Adult Movie', isAdult: true }), true);
});

test('filterNsfwCatalogItems removes NSFW items while keeping clean ones', () => {
  const items: MetaPreview[] = [
    { id: 'tt1480669', type: 'series', name: 'Tower Prep', poster: 'https://img.com/tp.jpg' },
    { id: 'tt9999999', type: 'movie', name: 'Brazzers Special 18+', poster: 'https://img.com/xxx.jpg' },
    { id: 'tt0120338', type: 'movie', name: 'Titanic', poster: 'https://img.com/titanic.jpg' },
  ];
  const filtered = filterNsfwCatalogItems(items);
  assert.equal(filtered.length, 2);
  assert.deepEqual(filtered.map(i => i.name), ['Tower Prep', 'Titanic']);
});
