import assert from 'node:assert/strict';
import test from 'node:test';
import { isRemoteTorrentUrlFetchable } from './stremthru.js';

test('allows HTTPS torrent URLs on public-looking DNS names', () => {
  assert.equal(
    isRemoteTorrentUrlFetchable('https://torrents.example.org/release.torrent'),
    true
  );
});

test('rejects single-label container hostnames that a remote debrid cannot resolve', () => {
  assert.equal(
    isRemoteTorrentUrlFetchable('http://harbrr/download/123.torrent'),
    false
  );
});

test('rejects local and reserved host suffixes', () => {
  for (const host of [
    'localhost',
    'indexer.local',
    'indexer.internal',
    'indexer.lan',
    'indexer.home.arpa',
    'indexer.test',
    'tracker.onion',
  ]) {
    assert.equal(
      isRemoteTorrentUrlFetchable(`https://${host}/file.torrent`),
      false,
      host
    );
  }
});

test('rejects literal IP endpoints and non-HTTP URLs', () => {
  for (const url of [
    'http://127.0.0.1/file.torrent',
    'http://10.0.0.5/file.torrent',
    'http://[::1]/file.torrent',
    'magnet:?xt=urn:btih:abcdef',
    'not a url',
  ]) {
    assert.equal(isRemoteTorrentUrlFetchable(url), false, url);
  }
});
