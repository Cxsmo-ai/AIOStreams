import assert from 'node:assert/strict';
import test from 'node:test';
import { isMeteorPlaceholder } from './meteor-placeholder.js';

test('Meteor no-results and donate placeholders are identified', () => {
  assert.equal(
    isMeteorPlaceholder({
      externalUrl: 'https://meteor.test/status/video/no_results',
    }),
    true
  );
  assert.equal(
    isMeteorPlaceholder({ externalUrl: 'https://meteor.test/support' }),
    true
  );
  assert.equal(
    isMeteorPlaceholder({ externalUrl: 'https://meteor.test/watch/123' }),
    false
  );
  assert.equal(isMeteorPlaceholder({}), false);
});
