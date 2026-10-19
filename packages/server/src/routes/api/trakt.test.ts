import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import express from 'express';
import { errorMiddleware } from '../../middlewares/errors.js';
import { createTraktRouter, type TraktRouterDependencies } from './trakt.js';

const servers: import('node:http').Server[] = [];
const reference = '11111111-1111-4111-8111-111111111111';
const appCredentials = { clientId: 'test-client', clientSecret: 'test-secret', redirectUri: 'urn:ietf:wg:oauth:2.0:oob' };

function auth(uuid: string): string {
  return `Basic ${Buffer.from(`${uuid}:pw-${uuid}`).toString('base64')}`;
}

async function testServer(dependencies: TraktRouterDependencies) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/trakt', createTraktRouter(dependencies));
  app.use(errorMiddleware);
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test listener');
  return `http://127.0.0.1:${address.port}/api/v1/trakt`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        )
    )
  );
});

function dependencies(overrides: Partial<TraktRouterDependencies> = {}): TraktRouterDependencies {
  return {
    authenticate: async (uuid, password) => {
      if (password !== `pw-${uuid}`) return null;
      const trackerProviders: Record<
        string,
        { authRef?: string; enabled?: boolean }
      > = {};
      if (uuid === 'alice') trackerProviders.trakt = { authRef: reference };
      return { trackerProviders };
    },
    requestDeviceCode: async () => ({
      deviceCode: 'opaque-device-code',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://trakt.tv/activate',
      expiresIn: 600,
      interval: 5,
    }),
    pollDeviceToken: async () => ({
      status: 'authorized',
      token: { accessToken: 'must-not-leak', refreshToken: 'secret-refresh', tokenExpiresAt: Date.now() + 60000 },
    }),
    storeToken: async () => reference,
    removeToken: async () => {},
    rateLimiter: (_req, _res, next) => next(),
    ...overrides,
  };
}

it('returns only a Trakt device code and verification link, never app secrets', async () => {
  let deviceRequests = 0;
  const base = await testServer(dependencies({
    requestDeviceCode: async () => {
      deviceRequests++;
      return {
        deviceCode: 'opaque-device-code',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://trakt.tv/activate',
        expiresIn: 600,
        interval: 5,
      };
    },
  }));
  const response = await fetch(`${base}/link/device`, {
    method: 'POST',
    headers: { authorization: auth('alice'), 'content-type': 'application/json' },
    body: JSON.stringify(appCredentials),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.userCode, 'ABCD-EFGH');
  assert.equal(body.verificationUri, 'https://trakt.tv/activate');
  assert.equal(Object.hasOwn(body, 'deviceCode'), false);
  assert.equal(deviceRequests, 1);
});

it('uses the initiating profile’s Trakt app credentials without returning them', async () => {
  let received: unknown;
  const profileCredentials = {
    clientId: 'profile-client',
    clientSecret: 'profile-secret',
    redirectUri: 'https://example.invalid/trakt/callback',
  };
  const base = await testServer(dependencies({
    requestDeviceCode: async (credentials) => {
      received = credentials;
      return {
        deviceCode: 'opaque-device-code',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://trakt.tv/activate',
        expiresIn: 600,
        interval: 5,
      };
    },
  }));
  const response = await fetch(`${base}/link/device`, {
    method: 'POST',
    headers: { authorization: auth('alice'), 'content-type': 'application/json' },
    body: JSON.stringify(profileCredentials),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(received, profileCredentials);
  const responseText = await response.text();
  assert.equal(responseText.includes('profile-secret'), false);
});

it('rejects Trakt linking without app credentials instead of falling back to server-wide keys', async () => {
  let requested = false;
  const base = await testServer(dependencies({
    requestDeviceCode: async () => {
      requested = true;
      throw new Error('must not be called');
    },
  }));
  const response = await fetch(`${base}/link/device`, {
    method: 'POST',
    headers: { authorization: auth('alice'), 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 400);
  assert.equal(requested, false);
});

it('scopes device authorization to the initiating account and returns only an opaque token reference', async () => {
  let tokenPolls = 0;
  const base = await testServer(dependencies({
    pollDeviceToken: async () => {
      tokenPolls++;
      return {
        status: 'authorized',
        token: { accessToken: 'must-not-leak', refreshToken: 'secret-refresh', tokenExpiresAt: Date.now() + 60000 },
      };
    },
  }));
  const started = await fetch(`${base}/link/device`, {
    method: 'POST',
    headers: { authorization: auth('alice'), 'content-type': 'application/json' },
    body: JSON.stringify(appCredentials),
  });
  const startBody = await started.json() as { state: string };
  const foreignPoll = await fetch(`${base}/link/status/${startBody.state}`, {
    headers: { authorization: auth('bob') },
  });
  assert.equal(foreignPoll.status, 404);
  assert.equal(tokenPolls, 0);

  const approved = await fetch(`${base}/link/status/${startBody.state}`, {
    headers: { authorization: auth('alice') },
  });
  assert.equal(approved.status, 200);
  const result = await approved.json() as Record<string, unknown>;
  assert.deepEqual(result, { status: 'authorized', authRef: reference });
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(result).includes('secret-refresh'), false);
  assert.equal(tokenPolls, 1);
});

it('only lets the account owner delete its linked Trakt token reference', async () => {
  let removed: string | null = null;
  const base = await testServer(dependencies({
    removeToken: async (authRef) => { removed = authRef; },
  }));
  const foreign = await fetch(`${base}/link/${reference}`, {
    method: 'DELETE',
    headers: { authorization: auth('bob') },
  });
  assert.equal(foreign.status, 404);
  assert.equal(removed, null);

  const owner = await fetch(`${base}/link/${reference}`, {
    method: 'DELETE',
    headers: { authorization: auth('alice') },
  });
  assert.equal(owner.status, 200);
  assert.equal(removed, reference);
});
