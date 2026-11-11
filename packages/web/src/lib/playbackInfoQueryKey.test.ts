import assert from 'node:assert/strict';
import test from 'node:test';
import { playbackInfoQueryKey } from './playbackInfoQueryKey';

test('kept playback info never shares a cache key with a fresh version listing', () => {
  const key = ['config', 'profile-1'];
  const fresh = playbackInfoQueryKey(key, 'item-1');
  const kept = playbackInfoQueryKey(key, 'item-1', undefined, undefined, true);

  assert.notDeepEqual(fresh, kept);
  assert.equal(fresh.at(-1), 'fresh');
  assert.equal(kept.at(-1), 'kept');
});

test('playback cache keys remain isolated by source, purpose, and config', () => {
  const base = playbackInfoQueryKey(['config-1'], 'item-1', 'source-1');

  assert.notDeepEqual(
    base,
    playbackInfoQueryKey(['config-1'], 'item-1', 'source-2')
  );
  assert.notDeepEqual(
    base,
    playbackInfoQueryKey(['config-1'], 'item-1', 'source-1', 'download')
  );
  assert.notDeepEqual(
    base,
    playbackInfoQueryKey(['config-2'], 'item-1', 'source-1')
  );
});
