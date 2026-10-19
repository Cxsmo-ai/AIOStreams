import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CROSS_ORIGIN_SENSITIVE_HEADERS,
  isPrivateUrlRequestBlocked,
  makeUrlLogSafe,
  resolveTorboxSearchInternalHeaders,
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
});
