import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldAutoWrapTorrentClaw } from './torrentClawAutoWrap.js';

const supportedServiceIds = ['realdebrid', 'torbox', 'deepbrid'];

test('auto-wraps TorrentClaw when a compatible provider is enabled', () => {
  assert.equal(
    shouldAutoWrapTorrentClaw({
      presetType: 'torrentclaw',
      supportsP2P: true,
      supportedServiceIds,
      enabledServiceIds: ['torbox'],
    }),
    true
  );
});

test('does not auto-wrap when no compatible provider is enabled', () => {
  assert.equal(
    shouldAutoWrapTorrentClaw({
      presetType: 'torrentclaw',
      supportsP2P: true,
      supportedServiceIds,
      enabledServiceIds: ['easynews'],
    }),
    false
  );
  assert.equal(
    shouldAutoWrapTorrentClaw({
      presetType: 'torrentclaw',
      supportsP2P: true,
      supportedServiceIds,
      enabledServiceIds: [],
    }),
    false
  );
});

test('does not change other presets or non-P2P TorrentClaw configurations', () => {
  assert.equal(
    shouldAutoWrapTorrentClaw({
      presetType: 'comet',
      supportsP2P: true,
      supportedServiceIds,
      enabledServiceIds: ['torbox'],
    }),
    false
  );
  assert.equal(
    shouldAutoWrapTorrentClaw({
      presetType: 'torrentclaw',
      supportsP2P: false,
      supportedServiceIds,
      enabledServiceIds: ['torbox'],
    }),
    false
  );
});
