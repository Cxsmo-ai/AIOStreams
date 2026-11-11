import assert from 'node:assert/strict';
import test from 'node:test';
import { getDeepbridProgressiveDiagnostic } from './deepbrid-progressive-diagnostic.js';

function deepbridError(
  message: string,
  status?: number,
  code?: string,
  retryAfterMs?: number
): Error {
  return Object.assign(new Error(message), {
    name: 'DeepbridApiError',
    status,
    code,
    retryAfterMs,
  });
}

test('keeps safe Deepbrid API status metadata without error text', () => {
  const diagnostic = getDeepbridProgressiveDiagnostic(
    deepbridError(
      'secret api key https://provider.example/private',
      503,
      'api_15',
      1_000
    )
  );

  assert.deepEqual(diagnostic, {
    kind: 'deepbrid-api',
    errorName: 'DeepbridApiError',
    status: 503,
    code: 'api_15',
    retryAfterMs: 1_000,
  });
  assert.equal(JSON.stringify(diagnostic).includes('secret'), false);
  assert.equal(JSON.stringify(diagnostic).includes('provider.example'), false);
});

test('omits unknown codes and out-of-range metadata', () => {
  assert.deepEqual(
    getDeepbridProgressiveDiagnostic(
      deepbridError('do not log this', 200, 'token=secret', 900_000)
    ),
    { kind: 'deepbrid-api', errorName: 'DeepbridApiError' }
  );
});

test('classifies known transport failures without forwarding messages', () => {
  assert.deepEqual(
    getDeepbridProgressiveDiagnostic(new DOMException('secret URL', 'AbortError')),
    { kind: 'aborted', errorName: 'AbortError' }
  );
  assert.deepEqual(
    getDeepbridProgressiveDiagnostic(new TypeError('secret URL')),
    { kind: 'network-or-type', errorName: 'TypeError' }
  );
  assert.deepEqual(
    getDeepbridProgressiveDiagnostic(new Error('secret URL')),
    { kind: 'unexpected', errorName: 'Error' }
  );
});

test('exposes only allowlisted transport codes and safe cause names', () => {
  const error = Object.assign(new Error('secret URL'), { code: 'EPIPE' });
  error.cause = Object.assign(new Error('token=secret'), {
    code: 'UND_ERR_SOCKET',
  });

  assert.deepEqual(getDeepbridProgressiveDiagnostic(error), {
    kind: 'unexpected',
    errorName: 'Error',
    code: 'EPIPE',
    causeName: 'Error',
    causeCode: 'UND_ERR_SOCKET',
  });
  assert.equal(JSON.stringify(getDeepbridProgressiveDiagnostic(error)).includes('secret'), false);
});

test('classifies local upstream cooldowns without logging request details', () => {
  const error = Object.assign(new Error('private URL and token'), {
    name: 'RateLimitedError',
    retryAfterSeconds: 12,
  });

  assert.deepEqual(getDeepbridProgressiveDiagnostic(error), {
    kind: 'rate-limited',
    errorName: 'RateLimitedError',
    retryAfterSeconds: 12,
  });
  assert.equal(JSON.stringify(getDeepbridProgressiveDiagnostic(error)).includes('token'), false);
});
