import assert from 'node:assert/strict';
import test from 'node:test';
import { getNzbServiceItemId } from './debrid.js';

test('does not turn queued external NZB hashes into library ids', () => {
  assert.equal(
    getNzbServiceItemId(
      {},
      { id: 'external-nzb-hash', library: false }
    ),
    undefined
  );
});

test('preserves confirmed library ids and explicit library ids', () => {
  assert.equal(
    getNzbServiceItemId({}, { id: 'owned-upload-id', library: true }),
    'owned-upload-id'
  );
  assert.equal(
    getNzbServiceItemId(
      { serviceItemId: 'catalog-item-id' },
      { id: 'ignored-check-id', library: false }
    ),
    'catalog-item-id'
  );
});
