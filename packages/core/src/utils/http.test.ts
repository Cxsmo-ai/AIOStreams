import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { getGlobalDispatcher, Headers, MockAgent, setGlobalDispatcher } from 'undici';
import { settingsStore } from '../config/index.js';
import { SettingsRepository } from '../db/repositories/settings.js';
import {
  CROSS_ORIGIN_SENSITIVE_HEADERS,
  isPrivateUrlRequestBlocked,
  makeUrlLogSafe,
  resolveTorboxSearchInternalHeaders,
  makeRequest,
  parseRetryAfter,
  RateLimitedError,
  cooldownKey,
} from './http.js';

test('makeUrlLogSafe masks provider-specific query credentials', () => {
  const safe = makeUrlLogSafe(
    'https://indexer.example/getnzb/item.nzb?i=123&r=secret-value&apikey=another-secret'
  );
  assert.equal(safe.includes('secret-value'), false);
  assert.equal(safe.includes('another-secret'), false);
  assert.match(safe, /[?&]r=<redacted>/);
  assert.match(safe, /[?&]apikey=<redacted>/);
});

test('drops API keys when a torrent download redirects across origins', () => {
  assert.ok(CROSS_ORIGIN_SENSITIVE_HEADERS.includes('x-api-key'));
});

test('internal-only headers are omitted after a request leaves the server origin', () => {
  const privateHeaders = {
    'x-aiostreams-torbox-search-config': '{"secret":"test"}',
  };
  const internal = resolveTorboxSearchInternalHeaders(
    new URL('http://127.0.0.1:3000/builtins/torbox-search/id/manifest.json'),
    privateHeaders,
    'http://127.0.0.1:3000'
  );
  const redirected = resolveTorboxSearchInternalHeaders(
    new URL('https://attacker.example/collect'),
    privateHeaders,
    'http://127.0.0.1:3000'
  );

  assert.equal(
    internal.get('x-aiostreams-torbox-search-config'),
    '{"secret":"test"}'
  );
  assert.equal(redirected.has('x-aiostreams-torbox-search-config'), false);

  const unrelatedInternalRoute = resolveTorboxSearchInternalHeaders(
    new URL('http://127.0.0.1:3000/builtins/gdrive/manifest.json'),
    privateHeaders,
    'http://127.0.0.1:3000'
  );
  assert.equal(
    unrelatedInternalRoute.has('x-aiostreams-torbox-search-config'),
    false
  );
});

test('private URL policy blocks local targets by default but preserves the exact internal origin', () => {
  const internalOrigin = 'http://127.0.0.1:3000';
  assert.equal(
    isPrivateUrlRequestBlocked(
      new URL('http://127.0.0.1:8080/manifest.json'),
      false,
      internalOrigin
    ),
    true
  );
  assert.equal(
    isPrivateUrlRequestBlocked(
      new URL('http://127.0.0.1:3000/builtins/torbox-search/id/manifest.json'),
      false,
      internalOrigin
    ),
    false
  );
  assert.equal(
    isPrivateUrlRequestBlocked(
      new URL('http://10.0.0.7/manifest.json'),
      true,
      internalOrigin
    ),
    false
  );
describe('parseRetryAfter', () => {
  test('parses delay-seconds', () => {
    assert.equal(parseRetryAfter('120'), 120);
  });

  test('parses an HTTP-date', (t) => {
    mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 1) });
    t.after(() => mock.timers.reset());
    const future = new Date(Date.UTC(2026, 0, 1, 0, 1));
    assert.equal(parseRetryAfter(future.toUTCString()), 60);
  });

  test('returns undefined for missing or invalid values', () => {
    assert.equal(parseRetryAfter(null), undefined);
    assert.equal(parseRetryAfter(''), undefined);
    assert.equal(parseRetryAfter('not a date'), undefined);
  });

  test('rejects non-standard delay-seconds values', () => {
    assert.equal(parseRetryAfter('1e6'), undefined);
    assert.equal(parseRetryAfter('0x10'), undefined);
    assert.equal(parseRetryAfter('1.5'), undefined);
    assert.equal(parseRetryAfter('-1'), undefined);
    assert.equal(parseRetryAfter('+1'), undefined);
  });
});

describe('RateLimitedError', () => {
  test('formats a human-readable retry-after duration', () => {
    const error = new RateLimitedError(90);
    assert.equal(error.name, 'RateLimitedError');
    assert.equal(error.message, 'Too Many Requests (retry after 1m 30s)');
  });
});

describe('cooldownKey', () => {
  const key = (url: string, headers: Record<string, string> = {}) =>
    cooldownKey(new URL(url), new Headers(headers), '').key;

  test('shares the key across paths and searches with the same API key', () => {
    assert.equal(
      key('https://indexer.test/api?t=search&q=a&apikey=one'),
      key('https://indexer.test/getnzb?id=b&apikey=one')
    );
  });

  test('separates different API keys in query, header and userinfo', () => {
    assert.notEqual(
      key('https://indexer.test/api?apikey=one'),
      key('https://indexer.test/api?apikey=two')
    );
    assert.notEqual(
      key('https://indexer.test/api', { 'X-Api-Key': 'one' }),
      key('https://indexer.test/api', { 'X-Api-Key': 'two' })
    );
    assert.notEqual(
      key('https://one:pass@indexer.test/api'),
      key('https://two:pass@indexer.test/api')
    );
  });

  test('treats userinfo like the Authorization header it becomes', () => {
    assert.equal(
      key('https://user:pass@indexer.test/api'),
      key('https://indexer.test/api', {
        Authorization: `Basic ${Buffer.from('user:pass').toString('base64')}`,
      })
    );
  });

  test('separates forwarded client IPs', () => {
    assert.notEqual(
      key('https://addon.test/stream', { 'X-Forwarded-For': '1.1.1.1' }),
      key('https://addon.test/stream', { 'X-Forwarded-For': '2.2.2.2' })
    );
  });

  test('separates egresses', () => {
    const url = new URL('https://indexer.test/api');
    assert.notEqual(
      cooldownKey(url, new Headers(), '0').key,
      cooldownKey(url, new Headers(), '1').key
    );
  });
});

describe('makeRequest', () => {
  test('skips the network while an endpoint is cooling down', async (t) => {
    mock.method(SettingsRepository, 'getAll', async () => []);
    mock.method(SettingsRepository, 'getVersion', async () => 0);
    await settingsStore.initialise();
    const agent = new MockAgent();
    agent.disableNetConnect();
    const previous = getGlobalDispatcher();
    setGlobalDispatcher(agent);
    t.after(() => setGlobalDispatcher(previous));
    let hits = 0;
    agent
      .get('https://indexer.test')
      .intercept({ path: '/api?apikey=one' })
      .reply(() => {
        hits++;
        return {
          statusCode: 429,
          responseOptions: { headers: { 'Retry-After': '60' } },
        };
      })
      .persist();

    const response = await makeRequest('https://indexer.test/api?apikey=one', {
      timeout: 1000,
    });
    assert.equal(response.status, 429);
    await assert.rejects(
      makeRequest('https://indexer.test/api?apikey=one', { timeout: 1000 }),
      RateLimitedError
    );
    assert.equal(hits, 1);
  });
});
