import assert from 'node:assert/strict';
import test from 'node:test';
import { nzbUpload } from './upload.js';

test('NZB upload middleware can be registered before runtime config initializes', () => {
  assert.doesNotThrow(() => nzbUpload(['file']));
});
