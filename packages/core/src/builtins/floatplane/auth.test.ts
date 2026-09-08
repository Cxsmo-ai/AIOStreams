import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { FloatplaneClient, type FloatplaneAuthState } from './api.js';

function authState(): FloatplaneAuthState {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    accessToken: 'access-before-refresh',
    refreshToken: 'refresh-before-refresh',
    tokenExpiresAt: Date.now() - 1,
    dpopPrivateJwk: pair.privateKey.export({ format: 'jwk' }),
    dpopPublicJwk: pair.publicKey.export({ format: 'jwk' }),
    tokenEndpoint: 'https://auth.floatplane.test/token',
    issuer: 'https://auth.floatplane.test/realms/floatplane',
  };
}

test('shares refresh and persists rotated auth across concurrent clients', async () => {
  const originalFetch = globalThis.fetch;
  const source = authState();
  const sessionKey = `auth-test-${Date.now()}-${Math.random()}`;
  let refreshCalls = 0;
  let apiCalls = 0;
  const persisted: FloatplaneAuthState[] = [];

  globalThis.fetch = (async (input, init) => {
    const endpoint = String(input);
    if (endpoint === source.tokenEndpoint) {
      refreshCalls += 1;
      assert.match(String(init?.body), /refresh_token=refresh-before-refresh/);
      return new Response(
        JSON.stringify({
          access_token: 'access-after-refresh',
          refresh_token: 'refresh-after-refresh',
          expires_in: 300,
        }),
        { status: 200, headers: { 'DPoP-Nonce': 'nonce-after-refresh' } }
      );
    }

    apiCalls += 1;
    assert.equal(
      new Headers(init?.headers).get('Authorization'),
      'DPoP access-after-refresh'
    );
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  try {
    const persist = (auth: FloatplaneAuthState) =>
      persisted.push(structuredClone(auth));
    const first = new FloatplaneClient(structuredClone(source), {
      sessionKey,
      onAuthChange: persist,
    });
    const second = new FloatplaneClient(structuredClone(source), {
      sessionKey,
      onAuthChange: persist,
    });

    await Promise.all([
      first.request('/api/v3/one'),
      second.request('/api/v3/two'),
    ]);

    assert.equal(refreshCalls, 1);
    assert.equal(apiCalls, 2);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].accessToken, 'access-after-refresh');
    assert.equal(persisted[0].refreshToken, 'refresh-after-refresh');
    assert.equal(persisted[0].dpopNonce, 'nonce-after-refresh');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
