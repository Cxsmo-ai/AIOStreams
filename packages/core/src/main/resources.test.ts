import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getSubtitles,
  shouldFilterLateStreamsForBlocklist,
  shouldResolveGlobalDeepbrid,
} from './resources.js';
import { countDeepbridFinderStreams } from '../streams/deepbrid-observability.js';

test('runs the late blocklist pass for global Deepbrid copies', () => {
  assert.equal(shouldFilterLateStreamsForBlocklist(false, true, false), true);
});

test('keeps the late blocklist pass for meta and service-wrapped results', () => {
  assert.equal(shouldFilterLateStreamsForBlocklist(true, false, false), true);
  assert.equal(shouldFilterLateStreamsForBlocklist(false, false, true), true);
});

test('skips the late blocklist pass when no late results exist', () => {
  assert.equal(shouldFilterLateStreamsForBlocklist(false, false, false), false);
});

test('defers external Deepbrid resolution from provisional snapshots to final processing', () => {
  assert.equal(shouldResolveGlobalDeepbrid(true), false);
  assert.equal(shouldResolveGlobalDeepbrid(false), true);
});

test('Finder survival attribution is based on origin addon, not service badge', () => {
  const nativeFinder = {
    addon: { identifier: 'deepbrid-usenet' },
    service: undefined,
  };
  const externalCopy = {
    addon: { identifier: 'newznab' },
    service: { id: 'deepbrid', cached: false },
  };

  assert.equal(countDeepbridFinderStreams([nativeFinder, externalCopy]), 1);
});
