import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pollWeTrakrDeviceToken,
  requestWeTrakrApi,
  refreshWeTrakrToken,
  requestWeTrakrDeviceCode,
  WeTrakrApiError,
  WeTrakrRateLimitError,
} from './wetrakr.js';

const app = { clientId: 'test-client' };

function response(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('device link requests use the official HTTPS API version and return safe fields', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestUrl = String(input);
    requestInit = init;
    return response(200, {
      device_code: 'opaque-device-code',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://wetrakr.com/activate',
      expires_in: 600,
      interval: 5,
    });
  }) as typeof fetch;

  const device = await requestWeTrakrDeviceCode(
    app,
    fetchMock
  );

  assert.equal(requestUrl, 'https://api.wetrakr.com/oauth/device/code');
  assert.equal(
    new Headers(requestInit?.headers).get('wetrakr-api-version'),
    '1'
  );
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    client_id: 'test-client',
  });
  assert.equal(device.userCode, 'ABCD-EFGH');
  assert.equal(device.verificationUri, 'https://wetrakr.com/activate');
});

test('device linking rejects a verification URL outside the WeTrakr HTTPS origin', async () => {
  const fetchMock = (async () =>
    response(200, {
      device_code: 'opaque-device-code',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://wetrakr.com.attacker.example/activate',
    })) as typeof fetch;

  await assert.rejects(
    requestWeTrakrDeviceCode(
      app,
      fetchMock
    ),
    /untrusted verification URL/
  );
});

test('device polling treats authorization_pending as normal and applies server interval', async () => {
  const fetchMock = (async () =>
    response(400, {
      error: 'authorization_pending',
      interval: 7,
    })) as typeof fetch;
  const result = await pollWeTrakrDeviceToken(
    'opaque-device-code',
    app,
    fetchMock
  );
  assert.deepEqual(result, { status: 'pending', retryAfter: 7 });
});

test('device polling sends the opaque device code as the documented code field', async () => {
  let requestBody: Record<string, unknown> = {};
  const fetchMock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return response(400, { error: 'authorization_pending' });
  }) as typeof fetch;
  const result = await pollWeTrakrDeviceToken(
    'opaque-device-code',
    app,
    fetchMock
  );
  assert.deepEqual(requestBody, {
    client_id: 'test-client',
    code: 'opaque-device-code',
  });
  assert.deepEqual(result, { status: 'pending', retryAfter: 5 });
});

test('device polling does not mistake an undocumented HTTP 428 for pending authorization', async () => {
  const fetchMock = (async () =>
    response(428, { error: 'invalid_request' })) as typeof fetch;
  await assert.rejects(
    pollWeTrakrDeviceToken(
      'opaque-device-code',
      app,
      fetchMock
    ),
    /authorization failed or expired/
  );
});

test('device polling keeps the optional client secret server-side and returns normalized token data', async () => {
  let requestBody: Record<string, unknown> = {};
  const fetchMock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return response(200, {
      access_token: 'access-test',
      refresh_token: 'refresh-test',
      expires_in: 3600,
      token_type: 'Bearer',
    });
  }) as typeof fetch;
  const result = await pollWeTrakrDeviceToken(
    'opaque-device-code',
    { clientId: 'test-client', clientSecret: 'server-only-secret' },
    fetchMock
  );
  assert.equal(requestBody.client_secret, 'server-only-secret');
  assert.deepEqual(result.status, 'authorized');
  if (result.status !== 'authorized')
    throw new Error('Expected authorization result');
  assert.equal(result.token.accessToken, 'access-test');
  assert.equal(result.token.refreshToken, 'refresh-test');
  assert.ok(result.token.tokenExpiresAt > Date.now());
});

test('refresh uses the API key header and persists the rotated token in its result', async () => {
  let headers = new Headers();
  let body: Record<string, unknown> = {};
  const fetchMock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    headers = new Headers(init?.headers);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return response(200, {
      access_token: 'rotated-access',
      refresh_token: 'rotated-refresh',
      new_refresh_token: 'rotated-refresh',
      expires_in: 604800,
    });
  }) as typeof fetch;
  const refreshed = await refreshWeTrakrToken(
    {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      tokenExpiresAt: 0,
      applicationCredentials: app,
    },
    fetchMock
  );
  assert.equal(headers.get('wetrakr-api-key'), 'test-client');
  assert.equal(headers.get('wetrakr-api-version'), '1');
  assert.deepEqual(body, { refresh_token: 'old-refresh' });
  assert.equal(refreshed.accessToken, 'rotated-access');
  assert.equal(refreshed.refreshToken, 'rotated-refresh');
});

test('provider API rejects an invalid idempotency key before loading account credentials', async () => {
  await assert.rejects(
    requestWeTrakrApi(
      'missing-reference',
      '/sync/tracking',
      { method: 'POST', body: {}, idempotencyKey: 'contains whitespace ' },
      (async () => response(200, {})) as typeof fetch
    ),
    /Invalid WeTrakr idempotency key/
  );
});

test('provider API retries a GET once when Retry-After is short', async () => {
  const token = {
    accessToken: 'test-access',
    refreshToken: 'test-refresh',
    tokenExpiresAt: Date.now() + 3_600_000,
    applicationCredentials: app,
  };
  let attempts = 0;
  const fetchMock = (async () => {
    attempts += 1;
    return attempts === 1
      ? new Response('', { status: 429, headers: { 'retry-after': '0' } })
      : response(200, { records: [] });
  }) as typeof fetch;

  const result = await requestWeTrakrApi(
    'test-reference',
    '/sync/tracking',
    {},
    fetchMock,
    async () => token
  );
  assert.deepEqual(result.data, { records: [] });
  assert.equal(attempts, 2);
});

test('provider API errors report a route label without retaining list IDs', async () => {
  const token = {
    accessToken: 'test-access',
    refreshToken: 'test-refresh',
    tokenExpiresAt: Date.now() + 3_600_000,
    applicationCredentials: app,
  };
  const fetchMock = (async () =>
    response(404, { message: 'private upstream response must not be retained' })) as typeof fetch;

  await assert.rejects(
    requestWeTrakrApi(
      'test-reference',
      '/sync/lists/private-list-identifier/items',
      {},
      fetchMock,
      async () => token
    ),
    (error: unknown) => {
      assert.ok(error instanceof WeTrakrApiError);
      assert.equal(error.status, 404);
      assert.equal(error.endpoint, 'sync_lists_items');
      assert.equal(JSON.stringify(error).includes('private-list-identifier'), false);
      assert.equal(error.message.includes('private upstream response'), false);
      return true;
    }
  );
});

test('provider API errors retain only allowlisted privacy codes', async () => {
  const token = {
    accessToken: 'test-access',
    refreshToken: 'test-refresh',
    tokenExpiresAt: Date.now() + 3_600_000,
    applicationCredentials: app,
  };
  const fetchMock = (async () =>
    response(403, {
      error: 'PRIVATE',
      message: 'private upstream message must not be retained',
      details: 'private account detail must not be retained',
    })) as typeof fetch;

  await assert.rejects(
    requestWeTrakrApi(
      'test-reference',
      '/sync/likes/all',
      {},
      fetchMock,
      async () => token
    ),
    (error: unknown) => {
      assert.ok(error instanceof WeTrakrApiError);
      assert.equal(error.providerCode, 'PRIVATE');
      assert.equal(JSON.stringify(error).includes('private account detail'), false);
      assert.equal(error.message.includes('private upstream message'), false);
      return true;
    }
  );
});

test('provider API retries an idempotent write once with the same key', async () => {
  const token = {
    accessToken: 'test-access',
    refreshToken: 'test-refresh',
    tokenExpiresAt: Date.now() + 3_600_000,
    applicationCredentials: app,
  };
  const idempotencyKeys: string[] = [];
  let attempts = 0;
  const fetchMock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    attempts += 1;
    idempotencyKeys.push(
      new Headers(init?.headers).get('Idempotency-Key') ?? ''
    );
    return attempts === 1
      ? new Response('', { status: 429, headers: { 'retry-after': '0' } })
      : response(200, { accepted: true });
  }) as typeof fetch;

  const result = await requestWeTrakrApi(
    'test-reference',
    '/sync/tracking',
    {
      method: 'POST',
      body: { position: 1 },
      idempotencyKey: 'progress-commit-1',
    },
    fetchMock,
    async () => token
  );
  assert.deepEqual(result.data, { accepted: true });
  assert.equal(attempts, 2);
  assert.deepEqual(idempotencyKeys, ['progress-commit-1', 'progress-commit-1']);
});

test('provider API exposes long rate-limit delays without retrying or replaying a write', async () => {
  const token = {
    accessToken: 'test-access',
    refreshToken: 'test-refresh',
    tokenExpiresAt: Date.now() + 3_600_000,
    applicationCredentials: app,
  };
  let attempts = 0;
  const fetchMock = (async () => {
    attempts += 1;
    return new Response('', { status: 429, headers: { 'retry-after': '10' } });
  }) as typeof fetch;

  await assert.rejects(
    requestWeTrakrApi(
      'test-reference',
      '/sync/tracking',
      { method: 'POST', body: { position: 1 } },
      fetchMock,
      async () => token
    ),
    (error: unknown) => {
      assert.ok(error instanceof WeTrakrRateLimitError);
      assert.equal(error.retryAfterMs, 10_000);
      return true;
    }
  );
  assert.equal(attempts, 1);
});

test('provider API rejects an oversized declared response before buffering it', async () => {
  let bodyCancelled = false;
  const oversizedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0x7b]));
    },
    cancel() {
      bodyCancelled = true;
    },
  });
  const fetchMock = (async () =>
    new Response(oversizedBody, {
      status: 200,
      headers: { 'content-length': String(1024 * 1024 + 1) },
    })) as typeof fetch;

  await assert.rejects(
    requestWeTrakrApi(
      'test-reference',
      '/sync/tracking',
      {},
      fetchMock,
      async () => ({
        accessToken: 'test-access',
        refreshToken: 'test-refresh',
        tokenExpiresAt: Date.now() + 3_600_000,
        applicationCredentials: app,
      })
    ),
    /response exceeded the allowed size/
  );
  assert.equal(bodyCancelled, true);
});

test('provider API cancels a chunked response when streamed bytes exceed the cap', async () => {
  let bodyCancelled = false;
  let chunksRead = 0;
  const oversizedBody = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunksRead += 1;
      controller.enqueue(new Uint8Array(700 * 1024));
    },
    cancel() {
      bodyCancelled = true;
    },
  });
  const fetchMock = (async () =>
    new Response(oversizedBody, { status: 200 })) as typeof fetch;

  await assert.rejects(
    requestWeTrakrApi(
      'test-reference',
      '/sync/tracking',
      {},
      fetchMock,
      async () => ({
        accessToken: 'test-access',
        refreshToken: 'test-refresh',
        tokenExpiresAt: Date.now() + 3_600_000,
        applicationCredentials: app,
      })
    ),
    /response exceeded the allowed size/
  );
  assert.equal(bodyCancelled, true);
  // ReadableStream may prefetch one chunk beyond the reader's current demand.
  assert.ok(chunksRead < 10, `unexpectedly drained ${chunksRead} chunks`);
});
