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
      assert.equal(init?.method, 'POST');
      return response({ results: [
        { type: 'movie', tmdb_id: 123, title: 'Clean Film', poster_path: '/clean.jpg' },
        { type: 'movie', tmdb_id: 456, title: 'Explicit XXX Film', poster_path: '/adult.jpg' },
      ] });
    }
    if (url.includes('/data/watchlist/get')) {
      assert.equal(init?.method, 'POST');
      assert.deepEqual(JSON.parse(String(init?.body)), {
        filterContentType: 'tv_show',
        sort: 'date',
      });
      return response({ results: [] });
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

function metadataMockFetch() {
  return (async (input: string | URL) => {
    const url = String(input);
    if (url.includes('identitytoolkit.googleapis.com')) {
      return response({ idToken: 'test-id-token', refreshToken: 'test-refresh', expiresIn: '3600' });
    }
    if (url.includes('/data/tv/19885')) {
      return response({ results: [{ tmdb_id: 19885, title: 'Sherlock', overview: 'Kurato summary' }] });
    }
    if (url.includes('/catalog/series/top/search=Sherlock.json')) {
      return response({ metas: [{ id: 'tt1475582', type: 'series', name: 'Sherlock', releaseInfo: '2010-2017' }] });
    }
    if (url.includes('/meta/series/tt1475582.json')) {
      return response({ meta: {
        id: 'tt1475582', type: 'series', name: 'Sherlock', poster: 'https://cinemeta.test/poster.jpg',
        background: 'https://cinemeta.test/background.jpg', logo: 'https://cinemeta.test/logo.png',
        description: 'A complete Cinemeta description.', genres: ['Crime', 'Drama', 'Mystery'],
        cast: ['Benedict Cumberbatch', 'Martin Freeman'], videos: [{ id: 'tt1475582:1:1', title: 'A Study in Pink', season: 1, episode: 1 }],
      } });
    }
    return response({});
  }) as typeof fetch;
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

test('Kurato uses the POST homepage contract and canonical TMDB artwork URLs', async () => {
  const mock = mockFetch();
  const addon = new KuratoAddon(config, mock.fetchFn);
  const items = await addon.getCatalog('movie', 'kurato-for-you-movie');
  assert.equal(items[0].poster, 'https://image.tmdb.org/t/p/w500/clean.jpg');
  assert.ok(mock.calls.some((url) => url.includes('/data/homepage/movies')));

  const search = await addon.getCatalog('movie', 'kurato-ai-discover-movie', 'search=space opera');
  assert.equal(search[0].poster, undefined);
});

test('Kurato maps TV homepage and watchlist requests to Kurato API values', async () => {
  const mock = mockFetch();
  const addon = new KuratoAddon(config, mock.fetchFn);
  await addon.getCatalog('series', 'kurato-for-you-series');
  await addon.getCatalog('series', 'kurato-watchlist-series');
  assert.ok(mock.calls.some((url) => url.includes('/data/homepage/tv')));
  assert.ok(mock.calls.some((url) => url.includes('/data/watchlist/get')));
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
  assert.equal(manifest.idPrefixes, undefined);
  assert.deepEqual(manifest.resources, ['catalog', 'meta']);
});

test('Kurato exposes collection contents and generated recommendation catalogs', async () => {
  const addon = new KuratoAddon(config, mockFetch().fetchFn);
  const generated = await addon.getCatalog('movie', 'kurato-generated-movie');
  const collections = await addon.getCatalog('movie', 'kurato-collections-movie', 'search=starter');
  assert.deepEqual(generated.map((item) => item.id), ['tmdb:321']);
  assert.deepEqual(collections.map((item) => item.id), ['tmdb:321']);
  assert.match(generated[0].description ?? '', /AI Starter Mix/);
});

test('Kurato enriches fallback metadata from Cinemeta while preserving the Kurato ID', async () => {
  const addon = new KuratoAddon(config, metadataMockFetch());
  const meta = await addon.getMeta('series', 'tmdb:19885');
  assert.equal(meta.id, 'tmdb:19885');
  assert.equal(meta.name, 'Sherlock');
  assert.equal(meta.logo, 'https://cinemeta.test/logo.png');
  assert.deepEqual(meta.genres, ['Crime', 'Drama', 'Mystery']);
  assert.equal(meta.videos?.length, 1);
});
