import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeHarbrrDownloadUrl } from './api.js';

const baseUrl = 'https://harbrr.example/';
test('normalizes Harbrr management download links without adding credentials', () => {
  const link = normalizeHarbrrDownloadUrl(
    'https://harbrr.example/api/indexers/private-tracker/download/token123',
    baseUrl
  );

  assert.equal(
    link,
    'https://harbrr.example/api/indexers/private-tracker/download/token123'
  );
});

test('supports relative Harbrr links and preserves existing query parameters', () => {
  assert.equal(
    normalizeHarbrrDownloadUrl(
      '/api/indexers/private-tracker/download/token123',
      baseUrl
    ),
    'https://harbrr.example/api/indexers/private-tracker/download/token123'
  );

  assert.equal(
    normalizeHarbrrDownloadUrl(
      'https://harbrr.example/api/indexers/private-tracker/download/token123?apikey=caller-key',
      baseUrl
    ),
    'https://harbrr.example/api/indexers/private-tracker/download/token123'
  );
});

test('does not add Harbrr credentials to unrelated or external links', () => {
  assert.equal(
    normalizeHarbrrDownloadUrl(
      'https://tracker.example/download/file.torrent',
      baseUrl
    ),
    'https://tracker.example/download/file.torrent'
  );
  assert.equal(
    normalizeHarbrrDownloadUrl(
      'https://harbrr.example/api/indexers/private-tracker/search',
      baseUrl
    ),
    'https://harbrr.example/api/indexers/private-tracker/search'
  );
});
