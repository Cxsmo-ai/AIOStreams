import assert from 'node:assert/strict';
import test from 'node:test';
import { KuratoAddon } from './addon.js';

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch() {
  const calls: string[] = [];
  let signIns = 0;
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('identitytoolkit.googleapis.com')) {
      signIns += 1;
      return response({ idToken: 'test-id-token', refreshToken: 'test-refresh', expiresIn: '3600' });
    }
    if (url.includes('/data/homepage/')) {
      return response({ results: [
        { type: 'movie', tmdb_id: 123, title: 'Clean Film', poster_path: '/clean.jpg' },
        { type: 'movie', tmdb_id: 456, title: 'Explicit XXX Film', poster_path: '/adult.jpg' },
      ] });
    }
    if (url.includes('/data/discover/')) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.query, 'space opera');
      assert.equal(url.endsWith('/data/discover/movies'), true);
      return response({ results: [
        { content: { contentType: 'movie', tmdb_id: 789, title: 'Space Opera' } },
        { content: { contentType: 'book', id: 999, title: 'Wrong media' } },
      ] });
    }
    if (url.includes('/data/collect/collections')) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.includeGenerated, true);
      const collections = [
        {
          id: 'generated-1',
          name: 'AI Starter Mix',
          isGenerated: true,
          contents: [{ contentType: 'movie', tmdb_id: 321, title: 'Generated Film' }],
        },
        {
          id: 'owned-1',
          name: 'My Collection',
          isGenerated: false,
          contents: [{ contentType: 'movie', tmdb_id: 654, title: 'Collected Film' }],
        },
      ];
      return response({
        collections: body.query
          ? collections.filter((item) => item.name.toLowerCase().includes(body.query.toLowerCase()))
          : collections,
      });
    }
    return response({});
  }) as typeof fetch;
  return { calls, fetchFn, get signIns() { return signIns; } };
}

const config = {
  email: 'test@example.com',
  password: 'not-a-real-password',
  baseUrl: 'https://app.kurato.com',
  pageSize: 50,
  includeWatchlist: true,
};

test('Kurato maps personalized catalogs, filters adult items, and reuses auth', async () => {
  const mock = mockFetch();
  const addon = new KuratoAddon(config, mock.fetchFn);
  const first = await addon.getCatalog('movie', 'kurato-for-you-movie');
  const second = await addon.getCatalog('movie', 'kurato-for-you-movie');
  assert.deepEqual(first.map((item) => item.id), ['tmdb:123']);
  assert.deepEqual(second.map((item) => item.name), ['Clean Film']);
  assert.equal(mock.signIns, 1);
});

test('Kurato routes Stremio search extras to the authenticated search endpoint', async () => {
  const mock = mockFetch();
  const addon = new KuratoAddon(config, mock.fetchFn);
  const results = await addon.getCatalog('movie', 'kurato-for-you-movie', 'search=space opera');
  assert.deepEqual(results.map((item) => item.id), ['tmdb:789']);
  assert.ok(mock.calls.some((url) => url.includes('/data/discover/movies')));
});

test('Kurato can omit watchlist catalogs without affecting personalized catalogs', () => {
  const manifest = new KuratoAddon({ ...config, includeWatchlist: false }, mockFetch().fetchFn).getManifest();
  assert.equal(manifest.catalogs?.some((catalog) => catalog.id.includes('watchlist')), false);
  assert.equal(manifest.catalogs?.length, 8);
});

test('Kurato exposes collection contents and generated recommendation catalogs', async () => {
  const addon = new KuratoAddon(config, mockFetch().fetchFn);
  const generated = await addon.getCatalog('movie', 'kurato-generated-movie');
  const collections = await addon.getCatalog('movie', 'kurato-collections-movie', 'search=starter');
  assert.deepEqual(generated.map((item) => item.id), ['tmdb:321']);
  assert.deepEqual(collections.map((item) => item.id), ['tmdb:321']);
  assert.match(generated[0].description ?? '', /AI Starter Mix/);
});
