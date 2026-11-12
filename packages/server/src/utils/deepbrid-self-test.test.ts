import assert from 'node:assert/strict';
import test from 'node:test';
import { runDeepbridLocalSelfTests } from './deepbrid-self-test.js';

test('Deepbrid offline dashboard checks exercise retry and parsers without secrets', async () => {
  const checks = await runDeepbridLocalSelfTests();
  assert.deepEqual(
    checks.map(({ id, status }) => ({ id, status })),
    [
      { id: 'rate-limit-retry', status: 'passed' },
      { id: 'release-parser', status: 'passed' },
      { id: 'archive-gap-parser', status: 'passed' },
    ]
  );
  assert.equal(
    checks.every(
      (check) => Number.isFinite(check.durationMs) && check.durationMs >= 0
    ),
    true
  );
  assert.doesNotMatch(
    JSON.stringify(checks),
    /synthetic rate limit|Example\.part/
  );
});
