import assert from 'node:assert/strict';
import test from 'node:test';
import { securityHeadersMiddleware } from './security-headers.js';

test('sets baseline security headers and limits frame policy to HTML documents', () => {
  const headers = new Map<string, string>();
  let continued = false;
  securityHeadersMiddleware(
    { accepts: () => 'html' } as never,
    {
      setHeader(name: string, value: string) {
        headers.set(name.toLowerCase(), value);
        return this;
      },
    } as never,
    () => {
      continued = true;
    }
  );

  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(
    headers.get('referrer-policy'),
    'strict-origin-when-cross-origin'
  );
  assert.equal(headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(continued, true);
});

test('does not add a frame policy to API-style responses', () => {
  const headers = new Map<string, string>();
  securityHeadersMiddleware(
    { accepts: () => false } as never,
    {
      setHeader(name: string, value: string) {
        headers.set(name.toLowerCase(), value);
        return this;
      },
    } as never,
    () => undefined
  );
  assert.equal(headers.has('x-frame-options'), false);
});
