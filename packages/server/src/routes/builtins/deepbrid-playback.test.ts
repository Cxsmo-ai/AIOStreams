import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEEPBRID_HLS_HEADERS_TO_REMOVE,
  isDeepbridRedirectStatus,
  isDeepbridHlsPlaylistResponse,
  rewriteDeepbridHlsPlaylist,
  shouldForwardDeepbridConditionalHeaders,
  shouldForwardDeepbridRange,
} from './deepbrid-playback.js';

test('does not classify 304 as a redirect and strips stale playlist representation headers', () => {
  assert.equal(isDeepbridRedirectStatus(301), true);
  assert.equal(isDeepbridRedirectStatus(302), true);
  assert.equal(isDeepbridRedirectStatus(307), true);
  assert.equal(isDeepbridRedirectStatus(308), true);
  assert.equal(isDeepbridRedirectStatus(304), false);
  assert.deepEqual(DEEPBRID_HLS_HEADERS_TO_REMOVE, [
    'ETag',
    'Last-Modified',
    'Content-Length',
    'Content-Range',
    'Accept-Ranges',
  ]);
});

test('treats the top-level HLS endpoint as a playlist despite generic content type', () => {
  assert.equal(
    isDeepbridHlsPlaylistResponse(
      'hls',
      '/cast_hls',
      'application/octet-stream'
    ),
    true
  );
  assert.equal(
    isDeepbridHlsPlaylistResponse(
      'hls-asset',
      '/nested/index.m3u8',
      'text/plain'
    ),
    true
  );
  assert.equal(
    isDeepbridHlsPlaylistResponse(
      'hls-asset',
      '/nested/playlist-token',
      'application/vnd.apple.mpegurl'
    ),
    true
  );
  assert.equal(
    isDeepbridHlsPlaylistResponse('hls-asset', '/segment.ts', 'video/mp2t'),
    false
  );
});

test('suppresses Range for HLS playlists but retains it for segments and other modes', () => {
  assert.equal(shouldForwardDeepbridRange('hls', '/cast_hls'), false);
  assert.equal(shouldForwardDeepbridRange('hls-asset', '/index.m3u8'), false);
  assert.equal(
    shouldForwardDeepbridRange(
      'hls-asset',
      '/nested/playlist-token',
      'application/vnd.apple.mpegurl'
    ),
    false
  );
  assert.equal(shouldForwardDeepbridRange('hls-asset', '/seg-1.ts'), true);
  assert.equal(shouldForwardDeepbridRange('direct', '/file.mkv'), true);
  assert.equal(shouldForwardDeepbridRange('remux', '/cast_remux'), true);
  assert.equal(shouldForwardDeepbridConditionalHeaders('hls'), false);
  assert.equal(shouldForwardDeepbridConditionalHeaders('hls-asset'), false);
  assert.equal(shouldForwardDeepbridConditionalHeaders('direct'), true);
  assert.equal(shouldForwardDeepbridConditionalHeaders('remux'), true);
});

test('rewrites relative, absolute, and URI-attribute HLS assets', () => {
  const localized: string[] = [];
  const result = rewriteDeepbridHlsPlaylist(
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin"\n#EXTINF:6,\nsegments/001.ts\nhttps://cdn.myfast.link/segments/002.ts',
    'https://streaming-2.myfast.link:8443/hls/index.m3u8',
    (url) => {
      localized.push(url);
      return `/local/${localized.length}`;
    }
  );

  assert.deepEqual(localized, [
    'https://streaming-2.myfast.link:8443/hls/keys/key.bin',
    'https://streaming-2.myfast.link:8443/hls/segments/001.ts',
    'https://cdn.myfast.link/segments/002.ts',
  ]);
  assert.equal(
    result,
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="/local/1"\n#EXTINF:6,\n/local/2\n/local/3'
  );
});

test('rejects malformed playlists and unsafe non-HTTPS assets', () => {
  assert.throws(() =>
    rewriteDeepbridHlsPlaylist(
      'not a playlist',
      'https://example.org/a.m3u8',
      () => '/x'
    )
  );
  assert.throws(() =>
    rewriteDeepbridHlsPlaylist(
      '#EXTM3U\nhttp://example.org/segment.ts',
      'https://example.org/a.m3u8',
      () => '/x'
    )
  );
  assert.throws(() =>
    rewriteDeepbridHlsPlaylist(
      '#EXTM3U\nhttps://user:password@example.org/segment.ts',
      'https://example.org/a.m3u8',
      () => '/x'
    )
  );
});
