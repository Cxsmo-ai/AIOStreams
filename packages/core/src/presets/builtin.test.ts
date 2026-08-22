import assert from 'node:assert/strict';
import test from 'node:test';

import { filterBuiltinServiceIds } from './builtin-services.js';

test('built-in addon configs exclude integration-only services', () => {
  assert.deepEqual(
    filterBuiltinServiceIds([
      'torrentclaw',
      'deepbrid',
      'torbox',
      'torrentclaw',
    ]),
    ['deepbrid', 'torbox']
  );
});

test('built-in addon configs preserve supported service order and uniqueness', () => {
  assert.deepEqual(
    filterBuiltinServiceIds([
      'aiostreams',
      'torbox',
      'deepbrid',
      'torbox',
      'stremio_nntp',
    ]),
    ['aiostreams', 'torbox', 'deepbrid', 'stremio_nntp']
  );
});
