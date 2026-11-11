import assert from 'node:assert/strict';
import test from 'node:test';
import { subtitleLanguage } from './enrichment.js';

test('Jellyfin subtitle language aliases include Chinese source codes', () => {
  for (const code of ['zhe', 'ze']) {
    assert.equal(subtitleLanguage(code).name, 'Chinese');
    assert.equal(subtitleLanguage(code).code, 'zho');
  }
});
