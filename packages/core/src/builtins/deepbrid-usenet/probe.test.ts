import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDeepbridContentRangeTotal } from './probe.js';

test('Deepbrid probe extracts an authoritative ranged body size', () => {
  assert.equal(
    parseDeepbridContentRangeTotal('bytes 0-63/4294967296'),
    4_294_967_296
  );
});

test('Deepbrid probe rejects unknown, malformed, and unsafe totals', () => {
  assert.equal(parseDeepbridContentRangeTotal('bytes 0-63/*'), undefined);
  assert.equal(parseDeepbridContentRangeTotal('bytes 64-127/1024'), undefined);
  assert.equal(
    parseDeepbridContentRangeTotal('bytes 0-63/not-a-size'),
    undefined
  );
});
