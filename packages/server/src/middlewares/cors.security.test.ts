import assert from 'node:assert/strict';
import test from 'node:test';
import { corsMiddleware } from './cors.js';

test('wildcard CORS does not claim browser credential support', () => {
  const headers = new Map<string, string>();
  corsMiddleware(
    {} as never,
    {
      setHeader(name: string, value: string) {
        headers.set(name.toLowerCase(), value);
        return this;
      },
    } as never,
    () => {}
  );

  assert.equal(headers.get('access-control-allow-origin'), '*');
  assert.equal(headers.has('access-control-allow-credentials'), false);
});
