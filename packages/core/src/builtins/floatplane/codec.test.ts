import assert from 'node:assert/strict';
import test from 'node:test';
import {
  containsAv1,
  filterPlayableFloatplanePlaylists,
  probeFloatplanePlaylist,
} from './codec.js';

test('rejects AV1 codec markers from Floatplane delivery objects', () => {
  assert.equal(containsAv1({ codec: 'av01.0.08M.08' }), true);
  assert.equal(containsAv1({ videoCodec: 'AV1' }), true);
  assert.equal(
    containsAv1({ url: 'https://cdn.example/video-av01.m3u8' }),
    true
  );
});

test('keeps H.264, HEVC, and VP9 delivery objects eligible', () => {
  assert.equal(containsAv1({ codec: 'avc1.640028' }), false);
  assert.equal(containsAv1({ codec: 'hvc1.2.4.L153.B0' }), false);
  assert.equal(containsAv1({ codec: 'vp09.00.51.08' }), false);
});

test('rejects a signed playlist that the CDN no longer authorizes', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('Forbidden', { status: 403 })) as typeof fetch;
  try {
    assert.equal(
      await probeFloatplanePlaylist(
        'https://cdn-vod-drm2.floatplane.com/Videos/expired/1080.mp4/playlist_fmp4.m3u8?token=redacted'
      ),
      'invalid'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('keeps only CDN-accepted playlists when a delivery has mixed links', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const value = String(input);
    return value.includes('/good/')
      ? new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1', {
          status: 200,
          headers: { 'content-type': 'application/vnd.apple.mpegurl' },
        })
      : new Response('Not Found', { status: 404 });
  }) as typeof fetch;
  try {
    const result = await filterPlayableFloatplanePlaylists([
      { url: 'https://cdn-vod-drm2.floatplane.com/good/playlist.m3u8' },
      { url: 'https://cdn-vod-drm2.floatplane.com/bad/playlist.m3u8' },
    ]);
    assert.deepEqual(result, [
      { url: 'https://cdn-vod-drm2.floatplane.com/good/playlist.m3u8' },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
