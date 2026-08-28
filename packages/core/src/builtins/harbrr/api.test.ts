import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeHarbrrDownloadUrl } from './api.js';

const baseUrl = 'https://harbrr.example/';
const apiKey = 'test-api-key';

test('authorizes Harbrr management download links for server-side grabs', () => {
  const link = authorizeHarbrrDownloadUrl(
    'https://harbrr.example/api/indexers/private-tracker/download/token123',
    baseUrl,
    apiKey
  );

  assert.equal(
    link,
    'https://harbrr.example/api/indexers/private-tracker/download/token123?apikey=test-api-key'
  );
});

test('supports relative Harbrr links and preserves an existing key', () => {
  assert.equal(
    authorizeHarbrrDownloadUrl(
      '/api/indexers/private-tracker/download/token123',
      baseUrl,
      apiKey
    ),
    'https://harbrr.example/api/indexers/private-tracker/download/token123?apikey=test-api-key'
  );

  assert.equal(
    authorizeHarbrrDownloadUrl(
      'https://harbrr.example/api/indexers/private-tracker/download/token123?apikey=caller-key',
      baseUrl,
      apiKey
    ),
    'https://harbrr.example/api/indexers/private-tracker/download/token123?apikey=caller-key'
  );
});

test('does not add Harbrr credentials to unrelated or external links', () => {
  assert.equal(
    authorizeHarbrrDownloadUrl(
      'https://tracker.example/download/file.torrent',
      baseUrl,
      apiKey
    ),
    'https://tracker.example/download/file.torrent'
  );
  assert.equal(
    authorizeHarbrrDownloadUrl(
      'https://harbrr.example/api/indexers/private-tracker/search',
      baseUrl,
      apiKey
    ),
    'https://harbrr.example/api/indexers/private-tracker/search'
  );
});
