import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ParsedStream,
  StreamProxyConfig,
  UserData,
} from '../db/schemas.js';
import { evaluateProxyStream } from '../streams/proxifier.js';
import {
  applyTorboxPresentation,
  decorateTorboxStreams,
  torboxPresentationLines,
} from './torbox-presentation.js';

test('renders centralized cached, Cache & Play, and strict-track badges', () => {
  assert.deepEqual(
    torboxPresentationLines({
      service: 'TB',
      mode: 'stream',
      target: '1080p',
      cacheState: 'cached',
      cacheAndPlay: false,
      audio: 'English',
      subtitle: 'French',
      nativeFallback: true,
    }),
    ['⚡ TB · STREAM · 1080P MAX', '🔊 EN · 💬 FR · ↩ NATIVE IF TRACKS MISSING']
  );
  assert.equal(
    torboxPresentationLines({
      service: 'TB',
      mode: 'native',
      target: 'native',
      cacheState: 'uncached',
      cacheAndPlay: true,
      audio: 'auto',
      subtitle: 'off',
      nativeFallback: false,
    })[0],
    '⬇ TB · CACHE & PLAY · NATIVE'
  );
});

test('TorBox account toggles override global Cache & Play for TorBox only', () => {
  const stream = {
    type: 'usenet',
    resolution: '2160p',
    service: { id: 'torbox', cached: false },
  } as unknown as ParsedStream;
  const userData = {
    cacheAndPlay: { enabled: false, streamTypes: [] },
    services: [
      {
        id: 'torbox',
        enabled: true,
        credentials: {
          apiKey: 'test-token',
          playbackQuality: '1080p',
          audioLanguage: 'English',
          subtitleLanguage: 'off',
          usenetCacheAndPlay: 'true',
        },
      },
    ],
  } as unknown as UserData;
  const [decorated] = decorateTorboxStreams([stream], userData);
  assert.equal(decorated.torbox?.cacheAndPlay, true);
  assert.equal(decorated.torbox?.target, '1080p');
  assert.equal(
    (decorated as unknown as { resolution: string }).resolution,
    '2160p',
    'source resolution metadata must not be rewritten or upscaled'
  );
});

test('TorrentClaw to Unarr TorBox results replace only the AIO playback label', () => {
  const stream = {
    type: 'usenet',
    indexer: 'Unarr',
    addon: { preset: { type: 'torrentclaw' } },
    torbox: {
      service: 'TB',
      mode: 'native',
      target: 'native',
      cacheState: 'cached',
      cacheAndPlay: false,
      audio: 'auto',
      subtitle: 'off',
      nativeFallback: false,
    },
  } as unknown as ParsedStream;
  const formatted = applyTorboxPresentation(stream, {
    name: 'AIO TorrentClaw',
    description: '2160p · HEVC · Dolby Vision',
  });
  assert.equal(formatted.name, 'TB TorrentClaw');
  assert.match(formatted.description, /^⚡ TB · NATIVE/);
  assert.match(formatted.description, /2160p · HEVC · Dolby Vision/);
});

test('never routes TorBox native or HLS media through a configured proxy', () => {
  const stream = {
    url: 'https://api.torbox.app/v1/api/stream/playlist.m3u8',
    type: 'usenet',
    service: { id: 'torbox', cached: true },
    addon: { preset: { id: 'torrentclaw' } },
  } as unknown as ParsedStream;
  const proxy = {
    enabled: true,
    id: 'mediaflow',
    url: 'https://proxy.example.test',
  } as unknown as StreamProxyConfig;
  assert.equal(evaluateProxyStream(stream, proxy), 'skip');
});
