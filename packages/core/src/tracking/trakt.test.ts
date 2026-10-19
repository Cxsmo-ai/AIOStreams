import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pollTraktDeviceToken,
  requestTraktApi,
  requestTraktDeviceCode,
} from './trakt.js';

const app = {
  clientId: 'test-client-id',
  clientSecret: 'test-app-secret',
  redirectUri: 'urn:ietf:wg:oauth:2.0:oob',
};

function response(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('Trakt device authorization requests only the server app client id', async () => {
  let url = '';
  let init: RequestInit | undefined;
  const fetchMock = (async (input: RequestInfo | URL, options?: RequestInit) => {
    url = String(input);
    init = options;
    return response(200, {
      device_code: 'opaque-device-code',
      user_code: 'ABCD-EFGH',
      verification_url: 'https://trakt.tv/activate',
      expires_in: 600,
      interval: 5,
    });
  }) as typeof fetch;

  const result = await requestTraktDeviceCode(app, fetchMock);
  assert.equal(url, 'https://api.trakt.tv/oauth/device/code');
  assert.deepEqual(JSON.parse(String(init?.body)), { client_id: 'test-client-id' });
  assert.equal(result.userCode, 'ABCD-EFGH');
  assert.equal(result.verificationUri, 'https://trakt.tv/activate');
});

test('Trakt device flow rejects verification URLs outside its HTTPS activation page', async () => {
  const fetchMock = (async () =>
    response(200, {
      device_code: 'opaque-device-code',
      user_code: 'ABCD-EFGH',
      verification_url: 'https://trakt.tv.attacker.example/activate',
    })) as typeof fetch;
  await assert.rejects(requestTraktDeviceCode(app, fetchMock), /untrusted verification URL/);
});

test('Trakt device polling handles documented pending and rate-limit responses', async () => {
  const pending = await pollTraktDeviceToken(
    'opaque-device-code',
    app,
    (async () => response(400, { error: 'authorization_pending' })) as typeof fetch
  );
  assert.deepEqual(pending, { status: 'pending', retryAfter: 5 });

  const throttled = await pollTraktDeviceToken(
    'opaque-device-code',
    app,
    (async () => response(429, { error: 'slow_down' })) as typeof fetch
  );
  assert.deepEqual(throttled, { status: 'pending', retryAfter: 10 });
});

test('Trakt device polling sends the configured app secret only server-side', async () => {
  let body: Record<string, unknown> = {};
  const fetchMock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return response(200, {
      access_token: 'access-value',
      refresh_token: 'refresh-value',
      expires_in: 604800,
    });
  }) as typeof fetch;
  const result = await pollTraktDeviceToken('opaque-device-code', app, fetchMock);
  assert.equal(body.client_secret, app.clientSecret);
  assert.equal(body.client_id, app.clientId);
  assert.deepEqual(result.status, 'authorized');
  if (result.status === 'authorized') {
    assert.equal(result.token.accessToken, 'access-value');
    assert.equal(result.token.refreshToken, 'refresh-value');
    assert.ok(result.token.tokenExpiresAt > Date.now());
  }
});

test('Trakt device polling rejects denial and invalid-device responses', async () => {
  const fetchMock = (async () =>
    response(410, { error: 'expired_token' })) as typeof fetch;
  await assert.rejects(
    pollTraktDeviceToken('opaque-device-code', app, fetchMock),
    /failed, expired, or was denied/
  );
});

test('Trakt API path validation occurs before loading credentials or making a request', async () => {
  await assert.rejects(
    requestTraktApi('not-a-reference', '//attacker.example/api'),
    /Invalid Trakt API path/
  );
});
