import assert from 'node:assert/strict';
import test from 'node:test';
import { DebridError } from './base.js';
import {
  isolateDebridService,
  resetServiceFailureIsolationForTests,
  withServiceFailureIsolation,
} from './service-failure-isolation.js';

function authError(): DebridError {
  return new DebridError('credential rejected', {
    statusCode: 401,
    statusText: 'Unauthorized',
    code: 'UNAUTHORIZED',
    headers: {},
    body: null,
    type: 'upstream_error',
  });
}

function rateLimitError(): DebridError {
  return new DebridError('rate limit exceeded', {
    statusCode: 429,
    statusText: 'Too Many Requests',
    code: 'TOO_MANY_REQUESTS',
    headers: {},
    body: null,
    type: 'upstream_error',
  });
}

test.beforeEach(() => resetServiceFailureIsolationForTests());

test('confirmed auth failure opens only the matching credential circuit', async () => {
  let badCalls = 0;
  await assert.rejects(
    withServiceFailureIsolation('torbox', 'bad-token', async () => {
      badCalls++;
      throw authError();
    }),
    /credential rejected/
  );

  await assert.rejects(
    withServiceFailureIsolation('torbox', 'bad-token', async () => {
      badCalls++;
      return 'unexpected';
    }),
    /temporarily skipped/
  );
  assert.equal(badCalls, 1);

  const healthy = await withServiceFailureIsolation(
    'torbox',
    'replacement-token',
    async () => 'healthy'
  );
  assert.equal(healthy, 'healthy');
});

test('content errors do not open the service circuit', async () => {
  let calls = 0;
  const run = () =>
    withServiceFailureIsolation('torbox', 'token', async () => {
      calls++;
      throw new DebridError('release missing', {
        statusCode: 404,
        statusText: 'Not Found',
        code: 'NOT_FOUND',
        headers: {},
        body: null,
        type: 'api_error',
      });
    });
  await assert.rejects(run(), /release missing/);
  await assert.rejects(run(), /release missing/);
  assert.equal(calls, 2);
});

test('TorBox circuit never blocks another service', async () => {
  await assert.rejects(
    withServiceFailureIsolation('torbox', 'token', async () => {
      throw authError();
    })
  );
  const result = await withServiceFailureIsolation(
    'aiostreams',
    'native-token',
    async () => ['native-result']
  );
  assert.deepEqual(result, ['native-result']);
});

test('concurrent calls share one credential probe and never start after rejection', async () => {
  let probeCalls = 0;
  let operationCalls = 0;
  const service = isolateDebridService(
    {
      serviceName: 'torbox',
      capabilities: { torrents: true, usenet: false },
      async resolve() {
        operationCalls++;
        return 'unexpected';
      },
      async checkMagnets() {
        operationCalls++;
        return [];
      },
      async listMagnets() {
        operationCalls++;
        return [];
      },
      async addMagnet() {
        throw new Error('not used');
      },
      async addTorrent() {
        throw new Error('not used');
      },
      async generateTorrentLink() {
        throw new Error('not used');
      },
      async removeMagnet() {},
    },
    'torbox',
    'rejected-token',
    {
      credentialProbe: async () => {
        probeCalls++;
        await Promise.resolve();
        throw authError();
      },
    }
  );

  const results = await Promise.allSettled([
    service.listMagnets(),
    service.checkMagnets([]),
    service.resolve(
      { type: 'torrent', hash: '0'.repeat(40) },
      'video.mkv',
      false
    ),
  ]);
  assert.equal(probeCalls, 1);
  assert.equal(operationCalls, 0);
  assert.ok(results.every((result) => result.status === 'rejected'));
});

test('a rate-limited credential probe does not block the real operation', async () => {
  let probeCalls = 0;
  let operationCalls = 0;
  const service = isolateDebridService(
    {
      serviceName: 'torbox',
      capabilities: { torrents: true, usenet: false },
      async resolve() {
        operationCalls++;
        return 'playable';
      },
      async checkMagnets() {
        operationCalls++;
        return [];
      },
      async listMagnets() {
        operationCalls++;
        return [];
      },
      async addMagnet() {
        throw new Error('not used');
      },
      async addTorrent() {
        throw new Error('not used');
      },
      async generateTorrentLink() {
        throw new Error('not used');
      },
      async removeMagnet() {},
    },
    'torbox',
    'temporarily-rate-limited-token',
    {
      credentialProbe: async () => {
        probeCalls++;
        throw rateLimitError();
      },
    }
  );

  const results = await Promise.all([
    service.listMagnets(),
    service.checkMagnets([]),
  ]);
  assert.deepEqual(results, [[], []]);
  assert.equal(probeCalls, 1);
  assert.equal(operationCalls, 2);
});
