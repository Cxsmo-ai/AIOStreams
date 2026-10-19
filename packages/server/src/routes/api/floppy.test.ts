import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import express from 'express';
import { errorMiddleware } from '../../middlewares/errors.js';
import { createFloppyRouter, type FloppyRouterDependencies } from './floppy.js';

const servers: import('node:http').Server[] = [];
const authRef = '11111111-1111-4111-8111-111111111111';

function auth(uuid: string, password = `pw-${uuid}`): string {
  return `Basic ${Buffer.from(`${uuid}:${password}`).toString('base64')}`;
}

async function testServer(dependencies: FloppyRouterDependencies) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/floppy', createFloppyRouter(dependencies));
  app.use(errorMiddleware);
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test listener');
  return `http://127.0.0.1:${address.port}/api/v1/floppy`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    )
  );
});

it('links Floppy per AIOStreams user without returning or persisting the submitted token in config', async () => {
  let submittedToken = '';
  let removed = '';
  const dependencies: FloppyRouterDependencies = {
    authenticate: async (uuid, password) =>
      (uuid === 'alice' || uuid === 'bob') && password === `pw-${uuid}`
        ? { trackerProviders: uuid === 'bob' ? { floppy: { authRef: '22222222-2222-4222-8222-222222222222' } } : undefined }
        : null,
    storeAccount: async (baseUrl, apiToken) => {
      assert.equal(baseUrl, 'https://floppy.example.com');
      submittedToken = apiToken;
      return authRef;
    },
    removeAccount: async (reference) => { removed = reference; },
    rateLimiter: (_req, _res, next) => next(),
  };
  const base = await testServer(dependencies);
  const linked = await fetch(`${base}/link`, {
    method: 'POST',
    headers: {
      authorization: auth('alice'),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ baseUrl: 'https://floppy.example.com', apiToken: 'private-token' }),
  });
  assert.equal(linked.status, 200);
  assert.deepEqual(await linked.json(), { success: true, authRef });
  assert.equal(submittedToken, 'private-token');

  const wrongOwner = await fetch(`${base}/link/${authRef}`, {
    method: 'DELETE',
    headers: { authorization: auth('bob') },
  });
  assert.equal(wrongOwner.status, 404);
  assert.equal(removed, '');
});

it('requires AIOStreams authentication before attempting an upstream link', async () => {
  let called = false;
  const base = await testServer({
    authenticate: async () => null,
    storeAccount: async () => { called = true; return authRef; },
    removeAccount: async () => {},
    rateLimiter: (_req, _res, next) => next(),
  });
  const response = await fetch(`${base}/link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseUrl: 'https://floppy.example.com', apiToken: 'token' }),
  });
  assert.equal(response.status, 401);
  assert.equal(called, false);
});
