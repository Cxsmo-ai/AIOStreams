import assert from 'node:assert/strict';
import test from 'node:test';
import { attachSession } from './auth.js';

test('malformed percent-encoded session cookies are treated as unauthenticated', () => {
  const req = {
    headers: { cookie: 'aiostreams.session=%ZZ' },
  } as never;
  let nextCalls = 0;

  assert.doesNotThrow(() =>
    attachSession(req, {} as never, () => {
      nextCalls++;
    })
  );
  assert.equal(nextCalls, 1);
  assert.equal((req as { user?: unknown }).user, undefined);
});
