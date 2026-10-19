import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDurationHint } from './duration-hint.js';

test('parses numeric seconds and common formatted duration hints as milliseconds', () => {
  assert.equal(parseDurationHint(5_400), 5_400_000);
  assert.equal(parseDurationHint('5400'), 5_400_000);
  assert.equal(parseDurationHint('1h 32m'), 5_520_000);
  assert.equal(parseDurationHint('42m 10s'), 2_530_000);
});

test('ignores missing, malformed, zero, negative, and non-finite duration hints', () => {
  for (const value of [undefined, null, '', 'unknown', '1h nonsense', 0, -1, Infinity])
    assert.equal(parseDurationHint(value), undefined);
});
