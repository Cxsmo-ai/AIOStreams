import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearDeepbridProbeCacheForTests,
  hasSuccessfulDeepbridProbe,
  isDeepbridProbeQuarantined,
  rememberFailedDeepbridProbe,
  rememberSuccessfulDeepbridProbe,
} from './probe-cache.js';

test('Deepbrid probe cache admits successful probes and refreshes recency', () => {
  clearDeepbridProbeCacheForTests();
  const key = 'https://cdn.example/video.mkv\u0000mkv';
  assert.equal(hasSuccessfulDeepbridProbe(key), false);
  rememberSuccessfulDeepbridProbe(key);
  assert.equal(hasSuccessfulDeepbridProbe(key), true);
  clearDeepbridProbeCacheForTests();
  assert.equal(hasSuccessfulDeepbridProbe(key), false);
});

test('repeated failures briefly quarantine a probe without suppressing a transient failure', () => {
  clearDeepbridProbeCacheForTests();
  const key = 'profile-scoped-hash';

  rememberFailedDeepbridProbe(key);
  rememberFailedDeepbridProbe(key);
  assert.equal(isDeepbridProbeQuarantined(key), false);

  rememberFailedDeepbridProbe(key);
  assert.equal(isDeepbridProbeQuarantined(key), true);
  rememberSuccessfulDeepbridProbe(key);
  assert.equal(isDeepbridProbeQuarantined(key), false);
  assert.equal(hasSuccessfulDeepbridProbe(key), true);
});

test('probe failures must fall inside the same fixed 60-second window', () => {
  clearDeepbridProbeCacheForTests();
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const key = 'fixed-window';
    rememberFailedDeepbridProbe(key);
    now += 59_000;
    rememberFailedDeepbridProbe(key);
    now += 59_000;
    rememberFailedDeepbridProbe(key);

    assert.equal(isDeepbridProbeQuarantined(key), false);
  } finally {
    Date.now = originalNow;
    clearDeepbridProbeCacheForTests();
  }
});

test('quarantine expiry starts a clean failure window and account keys stay isolated', () => {
  clearDeepbridProbeCacheForTests();
  const originalNow = Date.now;
  let now = 5_000;
  Date.now = () => now;
  try {
    const accountA = 'account-a-capability';
    const accountB = 'account-b-capability';
    for (let attempt = 0; attempt < 2; attempt++) {
      rememberFailedDeepbridProbe(accountA);
      rememberFailedDeepbridProbe(accountB);
    }
    rememberFailedDeepbridProbe(accountA);
    assert.equal(isDeepbridProbeQuarantined(accountA), true);
    assert.equal(isDeepbridProbeQuarantined(accountB), false);

    now += 30_001;
    assert.equal(isDeepbridProbeQuarantined(accountA), false);
    rememberFailedDeepbridProbe(accountA);
    rememberFailedDeepbridProbe(accountA);
    assert.equal(isDeepbridProbeQuarantined(accountA), false);
  } finally {
    Date.now = originalNow;
    clearDeepbridProbeCacheForTests();
  }
});
