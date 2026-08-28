import assert from 'node:assert/strict';
import test from 'node:test';
import { CROSS_ORIGIN_SENSITIVE_HEADERS, makeUrlLogSafe } from './http.js';

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
