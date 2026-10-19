import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import express from 'express';
import { WeTrakrApiError, WeTrakrRateLimitError } from '@aiostreams/core';
import { errorMiddleware } from '../../middlewares/errors.js';
import {
  createWeTrakrRouter,
  type WeTrakrRouterDependencies,
} from './wetrakr.js';

const servers: import('node:http').Server[] = [];

function auth(uuid: string, password = `pw-${uuid}`): string {
  return `Basic ${Buffer.from(`${uuid}:${password}`).toString('base64')}`;
}

async function testServer(dependencies: WeTrakrRouterDependencies) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/wetrakr', createWeTrakrRouter(dependencies));
  app.use(errorMiddleware);
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No test listener');
  return `http://127.0.0.1:${address.port}/api/v1/wetrakr`;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          )
      )
  );
});

it('proxies WeTrakr account, history, search, and discover reads through the owned server-side link', async () => {
  const requested: Array<{ authRef: string; path: string }> = [];
  const dependencies: WeTrakrRouterDependencies = {
    authenticate: async (uuid, password) =>
      password === `pw-${uuid}` && uuid === 'alice'
        ? {
            trackerProviders: {
              wetrakr: {
                authRef: '11111111-1111-4111-8111-111111111111',
                enabled: true,
              },
            },
          }
        : {},
    requestDeviceCode: async () => ({
      deviceCode: 'device',
      userCode: 'CODE',
      verificationUri: 'https://wetrakr.com/activate',
      expiresIn: 600,
      interval: 5,
    }),
    pollDeviceToken: async () => ({ status: 'pending', retryAfter: 5 }),
    storeToken: async () => '11111111-1111-4111-8111-111111111111',
    removeToken: async () => {},
    requestApi: async (authRef, path) => {
      requested.push({ authRef, path });
      return {
        data: { results: [{ title: 'The Dark Knight' }] },
        headers: path.startsWith('/sync/lists')
          ? new Headers()
          : new Headers({
              'x-pagination-page-count': '3',
              'x-pagination-item-count': '21',
            }),
      };
    },
    database: () => ({ tx: async (fn: any) => fn({}) }) as any,
    rateLimiter: (_req, _res, next) => next(),
  };
  const base = await testServer(dependencies);
  const headers = { authorization: auth('alice') };

  const account = await fetch(`${base}/account`, { headers });
  assert.equal(account.status, 200);
  assert.equal(account.headers.get('cache-control'), 'no-store');
  assert.deepEqual(requested[0], {
    authRef: '11111111-1111-4111-8111-111111111111',
    path: '/account/settings',
  });
  const accountBody = (await account.json()) as {
    data: { results: Array<{ title: string }> };
    pagination: { pageCount: number; itemCount: number };
  };
  assert.equal(accountBody.data.results[0].title, 'The Dark Knight');
  assert.deepEqual(accountBody.pagination, { pageCount: 3, itemCount: 21 });

  const lists = await fetch(`${base}/account/lists`, { headers });
  assert.equal(lists.status, 200);
  const listBody = (await lists.json()) as Record<string, unknown>;
  assert.equal(Object.hasOwn(listBody, 'pagination'), false);

  const listItems = await fetch(
    `${base}/account/lists/25/items?page=2&limit=20`,
    {
      headers,
    }
  );
  assert.equal(listItems.status, 200);
  assert.equal(listItems.headers.get('cache-control'), 'no-store');
  const invalidListId = await fetch(`${base}/account/lists/not-a-list/items`, {
    headers,
  });
  assert.equal(invalidListId.status, 400);

  const history = await fetch(
    `${base}/account/history?target=episodes&page=2&limit=20`,
    { headers }
  );
  assert.equal(history.status, 200);
  const movieHistory = await fetch(
    `${base}/account/history?target=movies&page=1&limit=20`,
    { headers }
  );
  assert.equal(movieHistory.status, 200);
  const invalidHistoryTarget = await fetch(
    `${base}/account/history?target=all&page=1&limit=20`,
    { headers }
  );
  assert.equal(invalidHistoryTarget.status, 400);
  for (const facet of [
    'progress',
    'playing',
    'waiting',
    'planning',
    'dropped',
    'paused',
    'ratings',
    'favorites',
    'likes',
    'notes',
    'comments',
  ]) {
    const response = await fetch(
      `${base}/account/facets/${facet}?page=2&limit=20`,
      { headers }
    );
    assert.equal(
      response.status,
      200,
      `account facet ${facet} should be readable`
    );
  }
  const unknownFacet = await fetch(`${base}/account/facets/token?page=1`, {
    headers,
  });
  assert.equal(unknownFacet.status, 404);
  const unsupportedIgnoredSnapshot = await fetch(
    `${base}/account/facets/ignored?page=1&limit=20`,
    { headers }
  );
  assert.equal(unsupportedIgnoredSnapshot.status, 404);
  const search = await fetch(
    `${base}/catalog/search?q=The%20Dark%20Knight&filter_type=movie`,
    { headers }
  );
  assert.equal(search.status, 200);
  const discover = await fetch(
    `${base}/catalog/discover/trending?filter_type=show&page=3`,
    { headers }
  );
  assert.equal(discover.status, 200);
  const showDetails = await fetch(
    `${base}/catalog/show/1396?append=seasons%2Cepisodes`,
    { headers }
  );
  assert.equal(showDetails.status, 200);
  const listDetails = await fetch(`${base}/catalog/list/25?extended=preview`, {
    headers,
  });
  assert.equal(listDetails.status, 200);
  const unsafeAppend = await fetch(`${base}/catalog/show/1396?append=private`, {
    headers,
  });
  assert.equal(unsafeAppend.status, 400);
  const invalidMediaId = await fetch(`${base}/catalog/show/not-a-number`, {
    headers,
  });
  assert.equal(invalidMediaId.status, 400);
  assert.deepEqual(
    requested.map(({ authRef, path }) => [authRef, path]),
    [
      ['11111111-1111-4111-8111-111111111111', '/account/settings'],
      ['11111111-1111-4111-8111-111111111111', '/sync/lists?page=1&limit=50'],
      [
        '11111111-1111-4111-8111-111111111111',
        '/sync/lists/25/items?page=2&limit=20',
      ],
      [
        '11111111-1111-4111-8111-111111111111',
        '/sync/tracking/watched/history/episodes?page=2&limit=20',
      ],
      [
        '11111111-1111-4111-8111-111111111111',
        '/sync/tracking/watched/history/movies?page=1&limit=20',
      ],
      [
        '11111111-1111-4111-8111-111111111111',
        '/sync/tracking/watching/all?page=2&limit=20',
      ],
      ...[
        ['playing', '/sync/tracking/playing/all'],
        ['waiting', '/sync/tracking/waiting/all'],
        ['planning', '/sync/tracking/planning/all'],
        ['dropped', '/sync/tracking/dropped/all'],
        ['paused', '/sync/tracking/paused/all'],
      ].map(([, path]) => [
        '11111111-1111-4111-8111-111111111111',
        `${path}?page=2&limit=20`,
      ]),
      [
        '11111111-1111-4111-8111-111111111111',
        '/sync/ratings/all?page=2&limit=20',
      ],
      [
        '11111111-1111-4111-8111-111111111111',
        '/sync/favorites/all?page=2&limit=20',
      ],
      ['11111111-1111-4111-8111-111111111111', '/sync/likes/all?page=2&limit=20'],
      [
        '11111111-1111-4111-8111-111111111111',
        '/sync/notes/all?page=2&limit=20',
      ],
      [
        '11111111-1111-4111-8111-111111111111',
        '/sync/comments/all?include_replies=true&page=2&limit=20',
      ],
      [
        '11111111-1111-4111-8111-111111111111',
        '/search?page=1&limit=50&q=The+Dark+Knight&filter_type=movie',
      ],
      [
        '11111111-1111-4111-8111-111111111111',
        '/discover/trending?page=3&limit=50&filter_type=show',
      ],
      [
        '11111111-1111-4111-8111-111111111111',
        '/shows/1396?append=seasons%2Cepisodes',
      ],
      ['11111111-1111-4111-8111-111111111111', '/lists/25?extended=preview'],
    ]
  );

  const invalid = await fetch(
    `${base}/catalog/discover/../../link?filter_type=movie`,
    { headers }
  );
  assert.notEqual(invalid.status, 200);
  const unlinked = await fetch(`${base}/account`, {
    headers: { authorization: auth('bob') },
  });
  assert.equal(unlinked.status, 409);
});

it('creates private lists by default and safely proxies owned-list update/delete mutations', async () => {
  const calls: Array<{
    authRef: string;
    path: string;
    init?: { method?: string; body?: unknown };
  }> = [];
  const dependencies: WeTrakrRouterDependencies = {
    authenticate: async (uuid, password) =>
      password === `pw-${uuid}` && uuid === 'alice'
        ? {
            trackerProviders: {
              wetrakr: {
                authRef: '11111111-1111-4111-8111-111111111111',
                enabled: true,
              },
            },
          }
        : {},
    requestDeviceCode: async () => {
      throw new Error('unused');
    },
    pollDeviceToken: async () => {
      throw new Error('unused');
    },
    storeToken: async () => 'unused',
    removeToken: async () => {},
    requestApi: async (authRef, path, init) => {
      calls.push({ authRef, path, init });
      return { data: { id: 25 }, headers: new Headers() };
    },
    database: () => ({ tx: async (fn: any) => fn({}) }) as any,
    rateLimiter: (_req, _res, next) => next(),
  };
  const base = await testServer(dependencies);
  const headers = {
    authorization: auth('alice'),
    'content-type': 'application/json',
  };

  const created = await fetch(`${base}/account/lists`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: '  Rewatch  ',
      description: 'Picks',
      collaborators: ['not-supported'],
    }),
  });
  assert.equal(
    created.status,
    400,
    'unsupported fields must not be silently accepted'
  );
  assert.equal(calls.length, 0);

  const create = await fetch(`${base}/account/lists`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: '  Rewatch  ', description: 'Picks' }),
  });
  assert.equal(create.status, 200);
  assert.deepEqual(calls[0], {
    authRef: '11111111-1111-4111-8111-111111111111',
    path: '/sync/lists',
    init: {
      method: 'POST',
      body: { name: 'Rewatch', description: 'Picks', privacy: 'private' },
    },
  });

  const update = await fetch(`${base}/account/lists/25`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ name: 'Favorites', privacy: 'friends' }),
  });
  assert.equal(update.status, 200);
  assert.deepEqual(calls[1]?.init, {
    method: 'PUT',
    body: { name: 'Favorites', privacy: 'friends' },
  });
  assert.equal(calls[1]?.path, '/sync/lists/25');

  const invalid = await fetch(`${base}/account/lists/../25`, {
    method: 'DELETE',
    headers,
  });
  assert.notEqual(invalid.status, 200);
  assert.equal(calls.length, 2);

  const remove = await fetch(`${base}/account/lists/25`, {
    method: 'DELETE',
    headers,
  });
  assert.equal(remove.status, 200);
  assert.deepEqual(calls[2], {
    authRef: '11111111-1111-4111-8111-111111111111',
    path: '/sync/lists/25',
    init: { method: 'DELETE' },
  });
});

it('maps read failures to safe provider statuses instead of generic server errors', async () => {
  let failure: Error = new WeTrakrApiError(403);
  const dependencies: WeTrakrRouterDependencies = {
    authenticate: async (uuid, password) =>
      password === `pw-${uuid}` && uuid === 'alice'
        ? {
            trackerProviders: {
              wetrakr: {
                authRef: '11111111-1111-4111-8111-111111111111',
                enabled: true,
              },
            },
          }
        : null,
    requestDeviceCode: async () => {
      throw new Error('unused');
    },
    pollDeviceToken: async () => {
      throw new Error('unused');
    },
    storeToken: async () => 'unused',
    removeToken: async () => {},
    requestApi: async () => {
      throw failure;
    },
    database: () => ({ tx: async (fn: any) => fn({}) }) as any,
    rateLimiter: (_req, _res, next) => next(),
  };
  const base = await testServer(dependencies);
  const headers = { authorization: auth('alice') };

  const forbidden = await fetch(`${base}/account`, { headers });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await forbidden.json(), {
    error: 'WeTrakr API request failed (403)',
  });

  failure = new WeTrakrRateLimitError(2_500);
  const limited = await fetch(`${base}/account`, { headers });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '3');
  assert.equal(limited.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await limited.json(), {
    error: 'WeTrakr rate limit reached; retry after the indicated delay',
    retryAfterMs: 2_500,
  });
});

it('keeps mutation errors uncached, forwards safe status, and exposes retry timing', async () => {
  let failure: Error = new WeTrakrApiError(420);
  const dependencies: WeTrakrRouterDependencies = {
    authenticate: async (uuid, password) =>
      password === `pw-${uuid}` && uuid === 'alice'
        ? {
            trackerProviders: {
              wetrakr: {
                authRef: '11111111-1111-4111-8111-111111111111',
                enabled: true,
              },
            },
          }
        : {},
    requestDeviceCode: async () => {
      throw new Error('unused');
    },
    pollDeviceToken: async () => {
      throw new Error('unused');
    },
    storeToken: async () => 'unused',
    removeToken: async () => {},
    requestApi: async () => {
      throw failure;
    },
    database: () => ({ tx: async (fn: any) => fn({}) }) as any,
    rateLimiter: (_req, _res, next) => next(),
  };
  const base = await testServer(dependencies);
  const headers = {
    authorization: auth('alice'),
    'content-type': 'application/json',
  };
  const request = () =>
    fetch(`${base}/account/lists`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Quota test' }),
    });

  const planLimit = await request();
  assert.equal(planLimit.status, 420);
  assert.equal(planLimit.headers.get('cache-control'), 'no-store');
  assert.match(((await planLimit.json()) as { error: string }).error, /420/);

  failure = new WeTrakrRateLimitError(2_500);
  const rateLimited = await request();
  assert.equal(rateLimited.status, 429);
  assert.equal(rateLimited.headers.get('retry-after'), '3');
  assert.equal(rateLimited.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await rateLimited.json(), {
    error: 'WeTrakr rate limit reached; retry after the indicated delay',
    retryAfterMs: 2500,
  });
});

it('requires AIOStreams authentication and scopes device-link state to its owner', async () => {
  const removed: string[] = [];
  const importedRows: unknown[] = [];
  let receivedAppCredentials: unknown;
  const dependencies: WeTrakrRouterDependencies = {
    authenticate: async (uuid, password) =>
      password === `pw-${uuid}`
        ? uuid === 'alice'
          ? {
              trackerProviders: {
                wetrakr: { authRef: '11111111-1111-4111-8111-111111111111' },
              },
            }
          : {}
        : null,
    requestDeviceCode: async (credentials) => {
      receivedAppCredentials = credentials;
      return {
        deviceCode: 'opaque-device',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://wetrakr.com/activate',
        expiresIn: 600,
        interval: 5,
      };
    },
    pollDeviceToken: async () => ({
      status: 'authorized',
      token: {
        accessToken: 'a',
        refreshToken: 'r',
        tokenExpiresAt: Date.now() + 60_000,
      },
    }),
    storeToken: async () => '11111111-1111-4111-8111-111111111111',
    removeToken: async (reference) => {
      removed.push(reference);
    },
    requestApi: async (_reference, path) => ({
      data: path.startsWith('/sync/ratings/all')
        ? [
            {
              type: 'movie',
              id: 126,
              title: 'The Dark Knight',
              ids: { imdb: 'tt0468569' },
              rating: 9,
            },
          ]
        : [],
      headers: new Headers({ 'x-pagination-page-count': '1' }),
    }),
    database: () =>
      ({
        tx: async (fn: (tx: any) => Promise<unknown>) =>
          fn({
            exec: async (_sql: string, params: unknown[]) => {
              importedRows.push(JSON.parse(String(params[2])));
              return { rowCount: 1 };
            },
          }),
      }) as any,
    rateLimiter: (_req, _res, next) => next(),
  };
  const base = await testServer(dependencies);

  const unauthenticated = await fetch(`${base}/link/device`, {
    method: 'POST',
  });
  assert.equal(unauthenticated.status, 401);

  const started = await fetch(`${base}/link/device`, {
    method: 'POST',
    headers: {
      authorization: auth('alice'),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ clientId: 'profile-key', clientSecret: 'profile-secret' }),
  });
  assert.equal(started.status, 200);
  assert.deepEqual(receivedAppCredentials, { clientId: 'profile-key', clientSecret: 'profile-secret' });
  const startedText = await started.text();
  assert.equal(startedText.includes('profile-secret'), false);
  const { state } = JSON.parse(startedText) as { state: string };

  const wrongOwner = await fetch(`${base}/link/status/${state}`, {
    headers: { authorization: auth('bob') },
  });
  assert.equal(wrongOwner.status, 404);

  const status = await fetch(`${base}/link/status/${state}`, {
    headers: { authorization: auth('alice') },
  });
  assert.equal(status.status, 200);
  assert.equal(
    ((await status.json()) as { status: string }).status,
    'authorized'
  );

  const sync = await fetch(`${base}/sync/import`, {
    method: 'POST',
    headers: {
      authorization: auth('alice'),
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(sync.status, 200);
  const syncResult = (await sync.json()) as {
    imported: number;
    changed: number;
  };
  assert.equal(syncResult.imported, 1);
  assert.equal(syncResult.changed, 1);
  assert.equal(
    (importedRows[0] as { id: string }).id,
    'movie:imdb:tt0468569|rated'
  );

  const deniedDelete = await fetch(
    `${base}/link/11111111-1111-4111-8111-111111111111`,
    { method: 'DELETE', headers: { authorization: auth('bob') } }
  );
  assert.equal(deniedDelete.status, 404);
  assert.deepEqual(removed, []);

  const allowedDelete = await fetch(
    `${base}/link/11111111-1111-4111-8111-111111111111`,
    { method: 'DELETE', headers: { authorization: auth('alice') } }
  );
  assert.equal(allowedDelete.status, 200);
  assert.deepEqual(removed, ['11111111-1111-4111-8111-111111111111']);
});
