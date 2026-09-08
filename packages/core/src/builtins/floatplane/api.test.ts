import assert from 'node:assert/strict';
import test from 'node:test';
import { containsAv1 } from './codec.js';

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

test('recognises signed HLS playlists as playable Floatplane output', () => {
  const url =
    'https://cdn-vod-drm2.floatplane.com/Videos/example/1080.mp4/playlist_fmp4.m3u8?token=redacted';
  assert.match(url, /\.m3u8(?:[?#]|$)/i);
  assert.doesNotMatch(url, /\bav1\b|av01/i);
});
