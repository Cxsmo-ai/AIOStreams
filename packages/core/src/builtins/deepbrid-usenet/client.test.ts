import assert from 'node:assert/strict';
import test from 'node:test';
import pLimit from 'p-limit';
import {
  getGlobalDispatcher,
  MockAgent,
  Response as UndiciResponse,
  setGlobalDispatcher,
} from 'undici';
import { initialiseConfig } from '../../config/index.js';
import { closeDb, initDb } from '../../db/db.js';
import {
  DeepbridApiError,
  DeepbridFinderClient,
  DeepbridFinderRequestMetrics,
  DeepbridOfficialClient,
  DeepbridApiRequestGateRegistry,
  BoundedRollingMinuteCounter,
  getDeepbridAttemptTimeoutMs,
  getDeepbridApiRequestGateMetrics,
  getDeepbridFinderRequestReport,
  normalizeDeepbridFinderNzbUrl,
  parseDeepbridFinderResult,
  validateDeepbridFolderUrl,
  runDeepbridApiRequest,
  withDeepbridRateLimitRetry,
} from './client.js';

test('Deepbrid folder URL validation permits only documented HTTPS host families', () => {
  assert.equal(
    validateDeepbridFolderUrl('https://mega.nz/folder/abc#key').toString(),
    'https://mega.nz/folder/abc#key'
  );
  assert.equal(
    validateDeepbridFolderUrl('https://www.gofile.io/d/abc').hostname,
    'www.gofile.io'
  );
  for (const value of [
    'http://mega.nz/folder/abc',
    'https://mega.nz.attacker.example/folder/abc',
    'https://attacker.example/?next=https://mega.nz',
    'https://user:pass@mega.nz/folder/abc',
    'https://terabox.com:444/s/abc',
  ]) {
    assert.throws(() => validateDeepbridFolderUrl(value), {
      code: 'invalid-folder-url',
    });
  }
});

test('folder resolution posts through the official client and classifies files without claiming playback', async () => {
  const client = Object.create(
    DeepbridOfficialClient.prototype
  ) as DeepbridOfficialClient & {
    requestJson: (
      path: string,
      options: { method?: string; body?: URLSearchParams }
    ) => Promise<Record<string, unknown>>;
  };
  let request:
    | { path: string; options: { method?: string; body?: URLSearchParams } }
    | undefined;
  client.requestJson = async (path, options) => {
    request = { path, options };
    return {
      error: 0,
      files: [
        {
          name: 'Example.Movie.1080p.mkv',
          size: 1_000,
          link: 'https://premium-dl.deepbrid.com/d/signed-fixture',
        },
        {
          name: 'readme.nfo',
          size: 64,
          link: 'https://premium-dl.deepbrid.com/d/info-fixture',
        },
        {
          name: 'ignored.txt',
          link: 'https://attacker.example/file',
        },
      ],
    };
  };

  const files = await client.resolveFolder('https://mega.nz/folder/example');
  assert.equal(request?.path, '/generate/folder');
  assert.equal(request?.options.method, 'POST');
  assert.equal(
    request?.options.body?.get('link'),
    'https://mega.nz/folder/example'
  );
  assert.deepEqual(
    files.map(({ name, playableCandidate, status }) => ({
      name,
      playableCandidate,
      status,
    })),
    [
      {
        name: 'Example.Movie.1080p.mkv',
        playableCandidate: true,
        status: 'candidate',
      },
      { name: 'readme.nfo', playableCandidate: false, status: 'non-video' },
      {
        name: 'ignored.txt',
        playableCandidate: false,
        status: 'unreachable',
      },
    ]
  );
});

test('Finder search rejects malformed successful response shapes', async () => {
  for (const response of [{}, { items: null }, { items: {} }]) {
    const client = Object.create(
      DeepbridFinderClient.prototype
    ) as DeepbridFinderClient;
    (client as any).getJson = async () => response;
    await assert.rejects(client.searchPage('sample title'), {
      name: 'DeepbridApiError',
      code: 'invalid-search-shape',
    });
  }
});

test('preserves safe Finder NZB URLs and rejects unsafe origins', () => {
  const parsed = parseDeepbridFinderResult({
    token: 'finder-token',
    title: 'A verified release',
    nzb_url: '/usenet/finder/nzb/verified.nzb',
  });

  assert.equal(
    parsed?.nzbUrl,
    'https://www.deepbrid.com/usenet/finder/nzb/verified.nzb'
  );
  assert.equal(
    parseDeepbridFinderResult({
      token: 'finder-token',
      title: 'Unsafe release',
      nzb_url: 'https://attacker.example/private.nzb',
    })?.nzbUrl,
    undefined
  );
  assert.equal(
    normalizeDeepbridFinderNzbUrl('http://www.deepbrid.com/private.nzb'),
    undefined
  );
});

test('shares one paced API gate across Deepbrid client instances', async () => {
  let active = 0;
  let maximumActive = 0;
  const starts: number[] = [];
  const registry = new DeepbridApiRequestGateRegistry({
    maxEntries: 1,
    requestsPerMinute: 150,
    createLimiter: () => pLimit(3),
  });

  await Promise.all(
    Array.from({ length: 6 }, () =>
      registry.run('credential-hash-concurrent', async () => {
        starts.push(Date.now());
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 900));
        active--;
        return new UndiciResponse('{}', {
          headers: {
            'x-ratelimit-limit': '250',
            'x-ratelimit-remaining': '200',
          },
        });
      })
    )
  );

  assert.ok(maximumActive > 1);
  assert.ok(maximumActive <= 3);
  for (let index = 1; index < starts.length; index++) {
    assert.ok(starts[index] - starts[index - 1] >= 400);
  }
  assert.ok(
    registry.snapshot('credential-hash-concurrent')
      .maxRequestsInRollingMinute <= 150
  );
});

test('a 429 cooldown pauses already-queued account requests', async () => {
  const registry = new DeepbridApiRequestGateRegistry({
    maxEntries: 1,
    requestsPerMinute: 150,
    createLimiter: () => pLimit(3),
  });
  const starts: number[] = [];
  const responses = await Promise.all(
    Array.from({ length: 3 }, (_, index) =>
      registry.run('credential-hash-cooldown', async () => {
        starts.push(Date.now());
        if (index === 0) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return new UndiciResponse('{}', {
            status: 429,
            headers: {
              'retry-after': '1',
              'x-ratelimit-limit': '250',
              'x-ratelimit-remaining': '0',
            },
          });
        }
        return new UndiciResponse('{}', {
          headers: {
            'x-ratelimit-limit': '250',
            'x-ratelimit-remaining': '200',
          },
        });
      })
    )
  );

  assert.equal(responses[0].status, 429);
  assert.ok(starts[1] - starts[0] >= 1_000);
  assert.ok(starts[2] - starts[1] >= 400);
});

test('measures aggregate rolling request rate and queue wait across API clients', async () => {
  const apiKey = `gate-metrics-${Date.now()}-${Math.random()}`;
  await Promise.all(
    Array.from({ length: 3 }, () =>
      runDeepbridApiRequest(apiKey, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      })
    )
  );

  const metrics = getDeepbridApiRequestGateMetrics(apiKey);
  assert.equal(metrics.maxRequestsInRollingMinute, 3);
  assert.equal(metrics.queueWait.samples, 3);
  assert.ok(metrics.queueWait.p95Ms > 0);
  assert.deepEqual(
    getDeepbridApiRequestGateMetrics(`${apiKey}-other`).queueWait,
    {
      samples: 0,
      p50Ms: 0,
      p95Ms: 0,
      maxMs: 0,
    }
  );
});

test('request-gate registry evicts idle credentials after the retention window', async () => {
  let now = 10_000;
  const registry = new DeepbridApiRequestGateRegistry({
    maxEntries: 2,
    idleTtlMs: 100,
    now: () => now,
  });

  await registry.run('credential-hash-old', async () => 'done');
  assert.equal(registry.size, 1);
  now += 101;

  assert.equal(registry.pruneIdle(), 1);
  assert.equal(registry.size, 0);
  assert.equal(
    registry.snapshot('credential-hash-old').maxRequestsInRollingMinute,
    0
  );
});

test('request-gate adapts to provider quota headers and honors Retry-After', async () => {
  let now = 10_000;
  const starts: number[] = [];
  const registry = new DeepbridApiRequestGateRegistry({
    maxEntries: 1,
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds;
    },
  });

  const successfulResponse = () =>
    new UndiciResponse('{}', {
      headers: {
        'x-ratelimit-limit': '250',
        'x-ratelimit-remaining': '200',
      },
    });
  await registry.run('credential-hash-paced', async () => {
    starts.push(now);
    return successfulResponse();
  });
  await registry.run('credential-hash-paced', async () => {
    starts.push(now);
    return successfulResponse();
  });
  await registry.run('credential-hash-paced', async () => {
    starts.push(now);
    return successfulResponse();
  });

  // The first request uses the safe unknown-account default; subsequent slots
  // use 75% of the observed premium quota, leaving 25% for other clients.
  assert.equal(starts[2] - starts[1], 321);
  assert.equal(
    registry.snapshot('credential-hash-paced').requestStartLimitPerMinute,
    187
  );
  assert.equal(
    registry.snapshot('credential-hash-paced').observedProviderLimit,
    250
  );

  await registry.run('credential-hash-paced', async () => {
    starts.push(now);
    return new UndiciResponse('{}', {
      status: 429,
      headers: {
        'retry-after': '3',
        'x-ratelimit-limit': '250',
        'x-ratelimit-remaining': '0',
      },
    });
  });
  const beforeCooldownRequest = now;
  await registry.run('credential-hash-paced', async () => {
    starts.push(now);
    return successfulResponse();
  });

  assert.ok(starts[4] - beforeCooldownRequest >= 3_000);
  assert.equal(
    registry.snapshot('credential-hash-paced').cooldownRemainingMs,
    0
  );
});

test('request gate stays below lower provider quotas after observing their headers', async () => {
  let now = 1_000;
  const starts: number[] = [];
  const registry = new DeepbridApiRequestGateRegistry({
    maxEntries: 1,
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds;
    },
  });
  const response = () =>
    new UndiciResponse('{}', {
      headers: {
        'x-ratelimit-limit': '100',
        'x-ratelimit-remaining': '80',
      },
    });

  await registry.run('credential-hash-lower-quota', async () => {
    starts.push(now);
    return response();
  });
  await registry.run('credential-hash-lower-quota', async () => {
    starts.push(now);
    return response();
  });

  assert.equal(starts[1] - starts[0], 800);
  assert.equal(
    registry.snapshot('credential-hash-lower-quota').requestStartLimitPerMinute,
    75
  );
});

test('unknown account request pacing uses the documented free-tier reserve', async () => {
  let now = 1_000;
  const starts: number[] = [];
  const registry = new DeepbridApiRequestGateRegistry({
    maxEntries: 1,
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds;
    },
  });

  await registry.run('credential-hash-unknown-tier', async () => {
    starts.push(now);
    return new UndiciResponse('{}');
  });
  await registry.run('credential-hash-unknown-tier', async () => {
    starts.push(now);
    return new UndiciResponse('{}');
  });

  assert.equal(starts[1] - starts[0], 800);
  assert.equal(
    registry.snapshot('credential-hash-unknown-tier')
      .requestStartLimitPerMinute,
    75
  );
});

test('Deepbrid network timeout starts after the account gate queue wait', async () => {
  const apiKey = `queued-timeout-${Date.now()}-${Math.random()}`;
  const originalDispatcher = getGlobalDispatcher();
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  mockAgent
    .get('https://www.deepbrid.com')
    .intercept({ path: /\/api\/v1\/usenet\/finder\/search\?.*/, method: 'GET' })
    .reply(200, JSON.stringify({ items: [] }), {
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-limit': '250',
        'x-ratelimit-remaining': '249',
      },
    });
  setGlobalDispatcher(mockAgent);
  await initDb('sqlite::memory:');
  await initialiseConfig();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const blocker = new Promise<void>((resolve) => (release = resolve));
  const priorSigningSecret = process.env.DEEPBRID_FINDER_SIGNING_SECRET;
  process.env.DEEPBRID_FINDER_SIGNING_SECRET = 'test-only-signing-secret';

  const active = runDeepbridApiRequest(apiKey, async () => {
    entered();
    await blocker;
  });
  try {
    await started;
    const client = new DeepbridFinderClient(apiKey, 250);
    const pendingPage = client.searchPage('queued timeout coverage');
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();

    const page = await pendingPage;
    await active;
    assert.equal(page.rawCount, 0);
  } finally {
    release();
    setGlobalDispatcher(originalDispatcher);
    await mockAgent.close();
    if (priorSigningSecret === undefined) {
      delete process.env.DEEPBRID_FINDER_SIGNING_SECRET;
    } else {
      process.env.DEEPBRID_FINDER_SIGNING_SECRET = priorSigningSecret;
    }
    await active;
    await closeDb();
  }
});

test('queued Finder request does not hit the API after its parent deadline', async () => {
  const apiKey = `queued-deadline-${Date.now()}-${Math.random()}`;
  const originalDispatcher = getGlobalDispatcher();
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  mockAgent
    .get('https://www.deepbrid.com')
    .intercept({ path: /\/api\/v1\/usenet\/finder\/search\?.*/, method: 'GET' })
    .reply(200, JSON.stringify({ items: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  setGlobalDispatcher(mockAgent);
  await initDb('sqlite::memory:');
  await initialiseConfig();
  let startedCount = 0;
  let signalAllStarted!: () => void;
  let release!: () => void;
  const allStarted = new Promise<void>(
    (resolve) => (signalAllStarted = resolve)
  );
  const blocker = new Promise<void>((resolve) => (release = resolve));
  const priorSigningSecret = process.env.DEEPBRID_FINDER_SIGNING_SECRET;
  process.env.DEEPBRID_FINDER_SIGNING_SECRET = 'test-only-signing-secret';

  const active = Array.from({ length: 3 }, () =>
    runDeepbridApiRequest(apiKey, async () => {
      startedCount++;
      if (startedCount === 3) signalAllStarted();
      await blocker;
    })
  );

  try {
    await allStarted;
    const client = new DeepbridFinderClient(apiKey, 5_000);
    const pendingPage = client.searchPage('expired queued deadline', {
      timeoutMs: 5_000,
      deadlineAtMs: Date.now() + 500,
    });
    const pageOutcome = pendingPage.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    await new Promise((resolve) => setTimeout(resolve, 650));
    const settledBeforeCapacity = await Promise.race([
      pageOutcome.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    assert.equal(
      settledBeforeCapacity,
      true,
      'an expired request should not remain blocked behind the shared gate'
    );
    release();

    await Promise.all(active);
    const outcome = await pageOutcome;
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.ok(outcome.error instanceof Error);
      assert.equal(outcome.error.name, 'DeepbridApiError');
      assert.equal((outcome.error as DeepbridApiError).code, 'retry-exhausted');
      assert.equal(
        (outcome.error as DeepbridApiError).retryExhaustionReason,
        'wrapper_budget_before_attempt'
      );
    }
  } finally {
    release();
    setGlobalDispatcher(originalDispatcher);
    await mockAgent.close();
    if (priorSigningSecret === undefined) {
      delete process.env.DEEPBRID_FINDER_SIGNING_SECRET;
    } else {
      process.env.DEEPBRID_FINDER_SIGNING_SECRET = priorSigningSecret;
    }
    await Promise.all(active);
    await closeDb();
  }
});

test('local retry budget expires while waiting in a shared account cooldown', async () => {
  const apiKey = `queued-local-budget-${Date.now()}-${Math.random()}`;
  const originalDispatcher = getGlobalDispatcher();
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const controller = new AbortController();
  let networkStarts = 0;
  mockAgent
    .get('https://www.deepbrid.com')
    .intercept({ path: /\/api\/v1\/usenet\/finder\/search\?.*/, method: 'GET' })
    .reply(
      200,
      () => {
        networkStarts++;
        return JSON.stringify({ items: [] });
      },
      { headers: { 'content-type': 'application/json' } }
    );
  const priorSigningSecret = process.env.DEEPBRID_FINDER_SIGNING_SECRET;
  process.env.DEEPBRID_FINDER_SIGNING_SECRET = 'test-only-signing-secret';

  // Seed the account-wide gate with a short provider cooldown. A search request
  // with a 250 ms per-attempt timeout has a 1.5 s local retry budget, so it
  // must expire before the gate releases it after two seconds.
  await runDeepbridApiRequest(
    apiKey,
    async () =>
      new UndiciResponse('{}', {
        status: 429,
        headers: {
          'retry-after': '2',
          'x-ratelimit-limit': '250',
          'x-ratelimit-remaining': '0',
        },
      })
  );

  const client = new DeepbridFinderClient(apiKey, 250);
  const pageOutcome = client
    .searchPage('local budget cooldown coverage', {
      timeoutMs: 250,
      signal: controller.signal,
    })
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      pageOutcome,
      new Promise<{ ok: false; error: Error }>((resolve) => {
        watchdog = setTimeout(
          () =>
            resolve({ ok: false, error: new Error('local-budget-timeout') }),
          2_200
        );
      }),
    ]);

    assert.equal(outcome.ok, false);
    assert.ok(outcome.error instanceof Error);
    assert.notEqual(outcome.error.message, 'local-budget-timeout');
    assert.equal((outcome.error as DeepbridApiError).code, 'retry-exhausted');
    assert.equal(
      (outcome.error as DeepbridApiError).retryExhaustionReason,
      'wrapper_budget_before_attempt'
    );
    assert.equal(networkStarts, 0);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    controller.abort(new Error('test cleanup'));
    setGlobalDispatcher(originalDispatcher);
    await mockAgent.close();
    if (priorSigningSecret === undefined) {
      delete process.env.DEEPBRID_FINDER_SIGNING_SECRET;
    } else {
      process.env.DEEPBRID_FINDER_SIGNING_SECRET = priorSigningSecret;
    }
    await pageOutcome;
  }
});

test('Finder signature correction cannot start after the original local deadline', async () => {
  const apiKey = `signature-local-deadline-${Date.now()}-${Math.random()}`;
  const originalDispatcher = getGlobalDispatcher();
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  let networkStarts = 0;
  mockAgent
    .get('https://www.deepbrid.com')
    .intercept({ path: /\/api\/v1\/usenet\/finder\/search\?.*/, method: 'GET' })
    .reply(
      200,
      () => {
        networkStarts++;
        return JSON.stringify({ error: 15, message: 'clock skew' });
      },
      {
        headers: {
          'content-type': 'application/json',
          date: new Date(Date.now() + 60_000).toUTCString(),
          'retry-after': '2',
          'x-ratelimit-limit': '250',
          'x-ratelimit-remaining': '0',
        },
      }
    );
  setGlobalDispatcher(mockAgent);
  const priorSigningSecret = process.env.DEEPBRID_FINDER_SIGNING_SECRET;
  process.env.DEEPBRID_FINDER_SIGNING_SECRET = 'test-only-signing-secret';
  await initDb('sqlite::memory:');
  await initialiseConfig();
  const client = new DeepbridFinderClient(apiKey, 250);
  const controller = new AbortController();
  const pageOutcome = client
    .searchPage('signature correction deadline coverage', {
      timeoutMs: 250,
      signal: controller.signal,
    })
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      pageOutcome,
      new Promise<{ ok: false; error: Error }>((resolve) => {
        watchdog = setTimeout(
          () =>
            resolve({ ok: false, error: new Error('signature-test-timeout') }),
          2_200
        );
      }),
    ]);

    assert.equal(outcome.ok, false);
    assert.ok(outcome.error instanceof Error);
    assert.notEqual(outcome.error.message, 'signature-test-timeout');
    assert.equal(
      (outcome.error as DeepbridApiError).code,
      'retry-exhausted',
      `name=${outcome.error.name}; requests=${networkStarts}; cooldownMs=${getDeepbridApiRequestGateMetrics(apiKey).cooldownRemainingMs}`
    );
    assert.equal(
      (outcome.error as DeepbridApiError).retryExhaustionReason,
      'signature_correction_budget'
    );
    assert.equal(networkStarts, 1);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    controller.abort(new Error('test cleanup'));
    setGlobalDispatcher(originalDispatcher);
    await mockAgent.close();
    if (priorSigningSecret === undefined) {
      delete process.env.DEEPBRID_FINDER_SIGNING_SECRET;
    } else {
      process.env.DEEPBRID_FINDER_SIGNING_SECRET = priorSigningSecret;
    }
    await pageOutcome;
    await closeDb();
  }
});

test('official client honors a caller deadline while queued in the account gate', async () => {
  const apiKey = `official-queued-deadline-${Date.now()}-${Math.random()}`;
  const originalDispatcher = getGlobalDispatcher();
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  await runDeepbridApiRequest(
    apiKey,
    async () =>
      new UndiciResponse('{}', {
        status: 429,
        headers: {
          'retry-after': '2',
          'x-ratelimit-limit': '250',
          'x-ratelimit-remaining': '0',
        },
      })
  );

  const client = new DeepbridOfficialClient(apiKey, 5_000);
  const controller = new AbortController();
  const pageOutcome = client
    .getUser({ deadlineAtMs: Date.now() + 500, signal: controller.signal })
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      pageOutcome,
      new Promise<{ ok: false; error: Error }>((resolve) => {
        watchdog = setTimeout(
          () => resolve({ ok: false, error: new Error('deadline-timeout') }),
          1_200
        );
      }),
    ]);

    assert.equal(outcome.ok, false);
    assert.ok(outcome.error instanceof Error);
    assert.notEqual(outcome.error.message, 'deadline-timeout');
    assert.equal((outcome.error as DeepbridApiError).code, 'retry-exhausted');
    assert.equal(
      (outcome.error as DeepbridApiError).retryExhaustionReason,
      'request_gate_deadline'
    );
  } finally {
    if (watchdog) clearTimeout(watchdog);
    controller.abort(new Error('test cleanup'));
    setGlobalDispatcher(originalDispatcher);
    await mockAgent.close();
    await pageOutcome;
  }
});

test('already-expired queued gate admission settles and drains without starting work', async () => {
  const apiKey = `already-expired-queue-${Date.now()}-${Math.random()}`;
  const registry = new DeepbridApiRequestGateRegistry({
    createLimiter: () => pLimit(3),
  });
  let startedCount = 0;
  let signalAllStarted!: () => void;
  let release!: () => void;
  const allStarted = new Promise<void>(
    (resolve) => (signalAllStarted = resolve)
  );
  const blocker = new Promise<void>((resolve) => (release = resolve));
  const active = Array.from({ length: 3 }, () =>
    registry.run(apiKey, async () => {
      startedCount++;
      if (startedCount === 3) signalAllStarted();
      await blocker;
    })
  );
  let expiredWorkStarted = false;

  try {
    await allStarted;
    const expired = registry.run(
      apiKey,
      async () => {
        expiredWorkStarted = true;
        return 'must-not-run';
      },
      undefined,
      Date.now() - 1
    );
    const outcome = expired.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error })
    );
    const settled = await Promise.race([
      outcome,
      new Promise<{ ok: true }>((resolve) =>
        setTimeout(() => resolve({ ok: true }), 100)
      ),
    ]);

    assert.equal(
      settled.ok,
      false,
      'expired admission must reject immediately'
    );
    if (!settled.ok) {
      assert.ok(settled.error instanceof DeepbridApiError);
      assert.equal(settled.error.code, 'retry-exhausted');
      assert.equal(
        settled.error.retryExhaustionReason,
        'request_gate_deadline'
      );
    }

    release();
    await Promise.all(active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(expiredWorkStarted, false);
  } finally {
    release();
    await Promise.all(active);
  }
});

test('Deepbrid account API timeout starts after shared quota queue wait', async () => {
  const apiKey = `official-queued-timeout-${Date.now()}-${Math.random()}`;
  const originalDispatcher = getGlobalDispatcher();
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  mockAgent
    .get('https://www.deepbrid.com')
    .intercept({ path: '/api/v1/user', method: 'GET' })
    .reply(200, JSON.stringify({ user: { id: 'test-account' } }), {
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-limit': '250',
        'x-ratelimit-remaining': '249',
      },
    });
  setGlobalDispatcher(mockAgent);

  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const blocker = new Promise<void>((resolve) => (release = resolve));
  const active = runDeepbridApiRequest(apiKey, async () => {
    entered();
    await blocker;
  });

  try {
    await started;
    const client = new DeepbridOfficialClient(apiKey, 250);
    const pendingUser = client.getUser();
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();

    const user = await pendingUser;
    await active;
    assert.equal(user.id, 'test-account');
  } finally {
    release();
    setGlobalDispatcher(originalDispatcher);
    await mockAgent.close();
    await active;
  }
});

test('Deepbrid account history lists secret-free rows and only deletes explicitly selected IDs', async () => {
  const apiKey = `official-history-${Date.now()}-${Math.random()}`;
  const originalDispatcher = getGlobalDispatcher();
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  const pool = mockAgent.get('https://www.deepbrid.com');
  pool
    .intercept({
      path: '/api/v1/downloads?limit=2&offset=4',
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    .reply(
      200,
      JSON.stringify({
        error: 0,
        data: [
          {
            id: 11,
            filename: 'Example.mkv',
            size: '1.2 GB',
            date: '2026-11-01',
            original: 'https://private.invalid/path?token=must-not-leak',
            download: 'https://private.invalid/signed-download',
          },
          { id: 12, filename: 'Other.mkv' },
        ],
      }),
      { headers: { 'content-type': 'application/json' } }
    );
  pool
    .intercept({
      path: '/api/v1/downloads/delete?ids=11%2C12',
      method: 'DELETE',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    .reply(
      200,
      JSON.stringify({ error: 0, deleted: 1, ids: [11], not_found: [12] }),
      { headers: { 'content-type': 'application/json' } }
    );
  pool
    .intercept({
      path: '/api/v1/usenet/uploads/delete?ids=22',
      method: 'DELETE',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    .reply(
      200,
      JSON.stringify({ error: 0, deleted: 1, ids: [22], not_found: [] }),
      { headers: { 'content-type': 'application/json' } }
    );
  setGlobalDispatcher(mockAgent);

  try {
    const client = new DeepbridOfficialClient(apiKey);
    const history = await client.listDownloads({ limit: 2, offset: 4 });
    assert.deepEqual(history, [
      { id: '11', filename: 'Example.mkv', size: '1.2 GB', date: '2026-11-01' },
      { id: '12', filename: 'Other.mkv', size: undefined, date: undefined },
    ]);
    assert.equal(JSON.stringify(history).includes('private.invalid'), false);
    await assert.rejects(client.deleteDownloads(['11', '12']), {
      code: 'history-delete-confirmation-required',
    });
    await assert.rejects(
      client.deleteUploads(
        Array.from({ length: 101 }, (_, index) => index + 1),
        {
          confirm: true,
        }
      ),
      { code: 'invalid-history-ids' }
    );
    assert.deepEqual(
      await client.deleteDownloads(['11', '12'], { confirm: true }),
      {
        deleted: 1,
        ids: ['11'],
        notFound: ['12'],
      }
    );
    assert.deepEqual(await client.deleteUploads([22], { confirm: true }), {
      deleted: 1,
      ids: ['22'],
      notFound: [],
    });
    mockAgent.assertNoPendingInterceptors();
  } finally {
    setGlobalDispatcher(originalDispatcher);
    await mockAgent.close();
  }
});

test('Deepbrid download history accepts documented list envelope variants safely', async () => {
  const responses = [
    { items: [{ id: 1, filename: 'Items.mkv' }] },
    { downloads: [{ id: '2', filename: 'Downloads.mkv' }] },
    { data: { items: [{ id: 3, filename: 'Nested.mkv' }] } },
  ];
  const client = Object.create(
    DeepbridOfficialClient.prototype
  ) as DeepbridOfficialClient & {
    requestJson: () => Promise<Record<string, unknown>>;
  };

  for (const [index, response] of responses.entries()) {
    client.requestJson = async () => response;
    assert.deepEqual(await client.listDownloads(), [
      {
        id: String(index + 1),
        filename: ['Items.mkv', 'Downloads.mkv', 'Nested.mkv'][index],
        size: undefined,
        date: undefined,
      },
    ]);
  }
});

test('download history pagination uses raw provider count when invalid rows are filtered', async () => {
  const client = Object.create(
    DeepbridOfficialClient.prototype
  ) as DeepbridOfficialClient & {
    requestJson: () => Promise<Record<string, unknown>>;
  };
  const providerRows = Array.from({ length: 50 }, (_, index) => ({
    id: index === 17 ? 'not-an-id' : index + 1,
    filename: `Release ${index + 1}.mkv`,
  }));
  client.requestJson = async () => ({ items: providerRows });

  const page = await client.listDownloadsPage({ limit: 50, offset: 0 });
  assert.equal(page.providerCount, 50);
  assert.equal(page.entries.length, 49);
  assert.equal(
    page.entries.some((entry) => entry.id === 'not-an-id'),
    false
  );
  assert.equal(page.hasNext, true);
});

test('Deepbrid history DELETE is not automatically replayed after an uncertain 503', async () => {
  const apiKey = `history-delete-once-${Date.now()}-${Math.random()}`;
  const originalDispatcher = getGlobalDispatcher();
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  mockAgent
    .get('https://www.deepbrid.com')
    .intercept({
      path: '/api/v1/downloads/delete?ids=47',
      method: 'DELETE',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    .reply(503, JSON.stringify({ error: 503, message: 'try again' }), {
      headers: { 'content-type': 'application/json' },
    });
  setGlobalDispatcher(mockAgent);

  try {
    await assert.rejects(
      new DeepbridOfficialClient(apiKey).deleteDownloads(['47'], {
        confirm: true,
      }),
      { code: 'http-error' }
    );
    mockAgent.assertNoPendingInterceptors();
  } finally {
    setGlobalDispatcher(originalDispatcher);
    await mockAgent.close();
  }
});

test('Deepbrid upload history omits records whose identifiers cannot be safely deleted', async () => {
  const client = Object.create(
    DeepbridOfficialClient.prototype
  ) as DeepbridOfficialClient & {
    requestJson: () => Promise<Record<string, unknown>>;
  };
  client.requestJson = async () => ({
    data: {
      items: [
        { id: 8, title: 'Usable.nzb', source_url: 'https://private.invalid/a' },
        { id: 'opaque/id', title: 'Not safely selectable.nzb' },
      ],
    },
  });

  const uploads = await client.listUploads();
  assert.deepEqual(uploads, [
    {
      id: '8',
      title: 'Usable.nzb',
      source: '',
      sourceUrl: 'https://private.invalid/a',
      hash: undefined,
      addedAt: undefined,
    },
  ]);
  assert.equal(JSON.stringify(uploads).includes('private.invalid'), true);
});

test('request-gate capacity never evicts active credentials and rejects overflow safely', async () => {
  let now = 1_000;
  const registry = new DeepbridApiRequestGateRegistry({
    maxEntries: 1,
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds;
    },
  });
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const hold = new Promise<void>((resolve) => (release = resolve));
  const active = registry.run('credential-hash-active', async () => {
    entered();
    await hold;
    return 'finished';
  });

  await started;
  await assert.rejects(
    registry.run('credential-hash-overflow', async () => 'must-not-run'),
    { name: 'DeepbridApiError', status: 503, code: 'request-gate-capacity' }
  );
  assert.equal(registry.size, 1);
  assert.equal(
    registry.snapshot('credential-hash-active').currentRequestsInRollingMinute,
    1
  );

  release();
  assert.equal(await active, 'finished');
  assert.equal(
    await registry.run('credential-hash-next', async () => 'next'),
    'next'
  );
  assert.equal(registry.size, 1);
  assert.equal(
    registry.snapshot('credential-hash-active').maxRequestsInRollingMinute,
    0
  );
});

test('request-gate capacity preserves queued requests on an existing credential', async () => {
  let now = 1_000;
  const registry = new DeepbridApiRequestGateRegistry({
    maxEntries: 1,
    createLimiter: () => pLimit(1),
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds;
    },
  });
  let active = 0;
  let maximumActive = 0;
  let firstStarted!: () => void;
  let releaseFirst!: () => void;
  const started = new Promise<void>((resolve) => (firstStarted = resolve));
  const blocker = new Promise<void>((resolve) => (releaseFirst = resolve));

  const first = registry.run('credential-hash-queued', async () => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    firstStarted();
    await blocker;
    active--;
    return 'first';
  });
  await started;

  const second = registry.run('credential-hash-queued', async () => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    active--;
    return 'second';
  });
  await assert.rejects(
    registry.run('credential-hash-overflow', async () => 'must-not-run'),
    { code: 'request-gate-capacity' }
  );
  assert.equal(registry.size, 1);

  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.equal(maximumActive, 1);
  assert.equal(
    registry.snapshot('credential-hash-queued').maxRequestsInRollingMinute,
    2
  );

  assert.equal(
    await registry.run('credential-hash-after-queue', async () => 'admitted'),
    'admitted'
  );
  assert.equal(registry.size, 1);
});

test('bounded rolling request counter expires old entries and marks saturated counts as lower bounds', () => {
  const counter = new BoundedRollingMinuteCounter(3);
  counter.record(1_000);
  counter.record(2_000);
  counter.record(3_000);
  assert.deepEqual(counter.snapshot(3_000), {
    currentRequests: 3,
    currentIsLowerBound: false,
    maxRequests: 3,
    maxIsLowerBound: false,
  });

  counter.record(4_000);
  assert.deepEqual(counter.snapshot(4_000), {
    currentRequests: 4,
    currentIsLowerBound: true,
    maxRequests: 4,
    maxIsLowerBound: true,
  });

  assert.deepEqual(counter.snapshot(61_000), {
    currentRequests: 3,
    currentIsLowerBound: false,
    maxRequests: 4,
    maxIsLowerBound: true,
  });
  assert.equal(counter.snapshot(64_000).currentRequests, 0);
});

test('bounded rolling request counter stays bounded under a sustained high-volume window', () => {
  const counter = new BoundedRollingMinuteCounter(128);
  for (let request = 0; request < 5_000; request++) {
    counter.record(10_000 + request);
  }

  assert.deepEqual(counter.snapshot(15_000), {
    currentRequests: 129,
    currentIsLowerBound: true,
    maxRequests: 129,
    maxIsLowerBound: true,
  });
});

test('rejects successful completion at the retry deadline', async () => {
  let currentTimeMs = 1_000;
  let starts = 0;

  await assert.rejects(
    withDeepbridRateLimitRetry(
      async () => {
        starts++;
        currentTimeMs = 1_250;
        return { items: [] };
      },
      {
        timeoutMs: 250,
        attemptTimeoutMs: 250,
        now: () => currentTimeMs,
        maxRetries: 0,
        maxTransportRetries: 0,
      }
    ),
    (error: unknown) => {
      assert.ok(error instanceof DeepbridApiError);
      assert.equal(error.code, 'retry-exhausted');
      assert.equal(
        error.retryExhaustionReason,
        'wrapper_completed_after_deadline'
      );
      return true;
    }
  );

  assert.equal(starts, 1);
});

test('preserves successful completion before the retry deadline', async () => {
  let currentTimeMs = 1_000;

  const result = await withDeepbridRateLimitRetry(
    async () => {
      currentTimeMs = 1_249;
      return { items: ['ok'] };
    },
    {
      timeoutMs: 250,
      attemptTimeoutMs: 250,
      now: () => currentTimeMs,
      maxRetries: 0,
      maxTransportRetries: 0,
    }
  );

  assert.deepEqual(result, { items: ['ok'] });
});

test('retries the shared local cooldown inside the original request budget', async () => {
  let now = 1_000;
  const timeouts: number[] = [];
  const waits: number[] = [];

  const result = await withDeepbridRateLimitRetry(
    async (timeoutMs) => {
      timeouts.push(timeoutMs);
      if (timeouts.length === 1) {
        throw Object.assign(new Error('private request details'), {
          name: 'RateLimitedError',
          retryAfterSeconds: 8,
        });
      }
      return 'page';
    },
    {
      timeoutMs: 20_000,
      now: () => now,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
    }
  );

  assert.equal(result, 'page');
  assert.deepEqual(waits, [8_000]);
  assert.deepEqual(timeouts, [20_000, 12_000]);
});

test('retries an HTTP 429 using its bounded Retry-After metadata', async () => {
  let now = 0;
  const waits: number[] = [];
  const actualWaits: number[] = [];
  let calls = 0;

  const result = await withDeepbridRateLimitRetry(
    async () => {
      calls++;
      if (calls === 1)
        throw new DeepbridApiError('rate limited', 429, 'http-error', 2_500);
      return 'page';
    },
    {
      timeoutMs: 10_000,
      now: () => now,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
      onCooldownWait: (milliseconds) => actualWaits.push(milliseconds),
    }
  );

  assert.equal(result, 'page');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2_500]);
  assert.deepEqual(actualWaits, [2_500]);
});

test('retries one transport timeout within a separate bounded attempt budget', async () => {
  let now = 0;
  let calls = 0;
  const attemptTimeouts: number[] = [];
  const retryEvents: boolean[] = [];
  const cooldownWaits: number[] = [];
  const timeout = new Error('private timeout detail');
  timeout.name = 'TimeoutError';

  const result = await withDeepbridRateLimitRetry(
    async (timeoutMs) => {
      calls++;
      attemptTimeouts.push(timeoutMs);
      if (calls === 1) {
        now += 7_000;
        throw timeout;
      }
      return 'page';
    },
    {
      timeoutMs: 14_250,
      attemptTimeoutMs: 7_000,
      maxTransportRetries: 1,
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds;
      },
      onTransportRetry: (recovered) => retryEvents.push(recovered),
      onCooldownWait: (milliseconds) => cooldownWaits.push(milliseconds),
    }
  );

  assert.equal(result, 'page');
  assert.equal(calls, 2);
  assert.deepEqual(attemptTimeouts, [7_000, 7_000]);
  assert.deepEqual(retryEvents, [false, true]);
  assert.deepEqual(cooldownWaits, []);
});

test('recovers after two consecutive Finder transport timeouts within budget', async () => {
  let now = 0;
  let calls = 0;
  const attemptTimeouts: number[] = [];
  const retryEvents: boolean[] = [];
  const timeout = new Error('private timeout detail');
  timeout.name = 'TimeoutError';

  const result = await withDeepbridRateLimitRetry(
    async (timeoutMs) => {
      calls++;
      attemptTimeouts.push(timeoutMs);
      if (calls < 3) {
        now += 7_000;
        throw timeout;
      }
      return 'page';
    },
    {
      timeoutMs: 21_750,
      attemptTimeoutMs: 7_000,
      maxTransportRetries: 2,
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds;
      },
      onTransportRetry: (recovered) => retryEvents.push(recovered),
    }
  );

  assert.equal(result, 'page');
  assert.equal(calls, 3);
  assert.deepEqual(attemptTimeouts, [7_000, 7_000, 7_000]);
  assert.deepEqual(retryEvents, [false, false, true]);
});

test('recovers after three consecutive Finder transport timeouts within budget', async () => {
  let now = 0;
  let calls = 0;
  const attemptTimeouts: number[] = [];
  const retryEvents: boolean[] = [];
  const timeout = new Error('private timeout detail');
  timeout.name = 'TimeoutError';

  const result = await withDeepbridRateLimitRetry(
    async (timeoutMs) => {
      calls++;
      attemptTimeouts.push(timeoutMs);
      if (calls < 4) {
        now += 7_000;
        throw timeout;
      }
      return 'page';
    },
    {
      timeoutMs: 30_750,
      attemptTimeoutMs: 7_000,
      maxTransportRetries: 3,
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds;
      },
      onTransportRetry: (recovered) => retryEvents.push(recovered),
    }
  );

  assert.equal(result, 'page');
  assert.equal(calls, 4);
  assert.deepEqual(attemptTimeouts, [7_000, 7_000, 7_000, 7_000]);
  assert.deepEqual(retryEvents, [false, false, false, true]);
});

test('caps transport retries at three and returns the last timeout', async () => {
  let now = 0;
  let calls = 0;
  const retryEvents: boolean[] = [];
  const timeout = new Error('private timeout detail');
  timeout.name = 'TimeoutError';

  await assert.rejects(
    withDeepbridRateLimitRetry(
      async () => {
        calls++;
        now += 7_000;
        throw timeout;
      },
      {
        timeoutMs: 30_750,
        attemptTimeoutMs: 7_000,
        maxTransportRetries: 3,
        now: () => now,
        wait: async (milliseconds) => {
          now += milliseconds;
        },
        onTransportRetry: (recovered) => retryEvents.push(recovered),
      }
    ),
    timeout
  );

  assert.equal(calls, 4);
  assert.deepEqual(retryEvents, [false, false, false]);
});

test('allows two additional bounded content timeout retries when requested', async () => {
  let now = 0;
  let calls = 0;
  const retryEvents: boolean[] = [];
  const timeout = new Error('private timeout detail');
  timeout.name = 'TimeoutError';

  const result = await withDeepbridRateLimitRetry(
    async (timeoutMs) => {
      calls++;
      assert.equal(timeoutMs, 7_000);
      if (calls <= 5) {
        now += 7_000;
        throw timeout;
      }
      now += 100;
      return 'content';
    },
    {
      timeoutMs: 50_000,
      attemptTimeoutMs: 7_000,
      maxTransportRetries: 5,
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds;
      },
      onTransportRetry: (recovered) => retryEvents.push(recovered),
    }
  );

  assert.equal(result, 'content');
  assert.equal(calls, 6);
  assert.deepEqual(retryEvents, [false, false, false, false, false, true]);
});

test('keeps mixed cooldown and transport retries within the finite operation budget', async () => {
  let now = 0;
  let calls = 0;
  const timeout = new Error('private timeout detail');
  timeout.name = 'TimeoutError';
  const rateLimited = new DeepbridApiError(
    'private rate limit detail',
    429,
    'http-error',
    250
  );
  const failures = [timeout, rateLimited, timeout, rateLimited, timeout];
  const retryEvents: boolean[] = [];
  const cooldownWaits: number[] = [];

  const result = await withDeepbridRateLimitRetry(
    async () => {
      now += 100;
      const failure = failures[calls++];
      if (failure) throw failure;
      return 'page';
    },
    {
      timeoutMs: 5_750,
      attemptTimeoutMs: 1_000,
      maxRetries: 2,
      maxTransportRetries: 3,
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds;
      },
      onTransportRetry: (recovered) => retryEvents.push(recovered),
      onCooldownWait: (milliseconds) => cooldownWaits.push(milliseconds),
    }
  );

  assert.equal(result, 'page');
  assert.equal(calls, 6);
  assert.deepEqual(retryEvents, [false, false, false, true]);
  assert.deepEqual(cooldownWaits, [250, 250]);
});

test('does not retry when a custom wait resolves after parent cancellation', async () => {
  const controller = new AbortController();
  const cancellation = new Error('cancelled');
  const timeout = new Error('private timeout detail');
  timeout.name = 'TimeoutError';
  let calls = 0;

  await assert.rejects(
    withDeepbridRateLimitRetry(
      async () => {
        calls++;
        throw timeout;
      },
      {
        timeoutMs: 20_000,
        maxTransportRetries: 3,
        signal: controller.signal,
        wait: async () => {
          controller.abort(cancellation);
          // A custom scheduler may resolve instead of rejecting on abort.
        },
      }
    ),
    cancellation
  );

  assert.equal(calls, 1);
});

test('does not start a timeout retry without enough remaining request budget', async () => {
  let now = 0;
  let calls = 0;
  const timeout = new Error('private timeout detail');
  timeout.name = 'TimeoutError';

  await assert.rejects(
    withDeepbridRateLimitRetry(
      async () => {
        calls++;
        now += 800;
        throw timeout;
      },
      {
        timeoutMs: 1_000,
        now: () => now,
        wait: async () => assert.fail('retry must fit within remaining budget'),
      }
    ),
    timeout
  );

  assert.equal(calls, 1);
});

test('never starts a timeout retry beyond the parent resolver deadline', async () => {
  let now = 0;
  let calls = 0;
  const timeout = new Error('private timeout detail');
  timeout.name = 'TimeoutError';

  await assert.rejects(
    withDeepbridRateLimitRetry(
      async () => {
        calls++;
        now += 7_000;
        throw timeout;
      },
      {
        timeoutMs: 21_750,
        attemptTimeoutMs: 7_000,
        deadlineAtMs: 14_999,
        now: () => now,
        wait: async (milliseconds) => {
          now += milliseconds;
        },
      }
    ),
    timeout
  );

  assert.equal(calls, 2);
  assert.ok(now <= 14_999);
});

test('clamps the network timeout against the parent deadline after queue wait', () => {
  assert.equal(getDeepbridAttemptTimeoutMs(7_000, 3_500, 1_000), 2_500);
  assert.equal(getDeepbridAttemptTimeoutMs(7_000, 1_249, 1_000), undefined);
  assert.equal(getDeepbridAttemptTimeoutMs(7_000, undefined, 1_000), 7_000);
});

test('does not start a third request when cancelled between timeout retries', async () => {
  const controller = new AbortController();
  let calls = 0;
  let waits = 0;
  const timeout = new Error('private timeout detail');
  timeout.name = 'TimeoutError';
  const cancelled = new Error('cancelled');

  await assert.rejects(
    withDeepbridRateLimitRetry(
      async () => {
        calls++;
        throw timeout;
      },
      {
        timeoutMs: 21_750,
        attemptTimeoutMs: 7_000,
        signal: controller.signal,
        wait: async () => {
          waits++;
          if (waits === 2) {
            controller.abort(cancelled);
            throw cancelled;
          }
        },
      }
    ),
    cancelled
  );

  assert.equal(calls, 2);
  assert.equal(waits, 2);
});

test('does not route authentication or server errors through timeout retries', async () => {
  for (const status of [401, 403, 500]) {
    const failure = new DeepbridApiError(
      'redacted failure',
      status,
      'http-error'
    );
    let calls = 0;
    let transportRetries = 0;

    await assert.rejects(
      withDeepbridRateLimitRetry(
        async () => {
          calls++;
          throw failure;
        },
        {
          timeoutMs: 21_750,
          onTransportRetry: () => transportRetries++,
          wait: async () => assert.fail(`unexpected retry for HTTP ${status}`),
        }
      ),
      failure
    );

    assert.equal(calls, 1);
    assert.equal(transportRetries, 0);
  }
});

test('does not retry aborted or unclassified transport failures', async () => {
  for (const failure of [
    Object.assign(new Error('caller cancelled'), { name: 'AbortError' }),
    Object.assign(new Error('private socket detail'), {
      cause: { code: 'UND_ERR_SOCKET' },
    }),
  ]) {
    let calls = 0;
    await assert.rejects(
      withDeepbridRateLimitRetry(
        async () => {
          calls++;
          throw failure;
        },
        {
          timeoutMs: 5_000,
          wait: async () => assert.fail('unexpected retry wait'),
        }
      ),
      failure
    );
    assert.equal(calls, 1);
  }
});

test('does not retry unrelated failures', async () => {
  const failure = new Error('do not expose');
  let calls = 0;

  await assert.rejects(
    withDeepbridRateLimitRetry(
      async () => {
        calls++;
        throw failure;
      },
      { timeoutMs: 5_000, wait: async () => assert.fail('unexpected wait') }
    ),
    failure
  );
  assert.equal(calls, 1);
});

test('does not wait past the request deadline for a cooldown', async () => {
  const failure = Object.assign(new Error('cooldown'), {
    name: 'RateLimitedError',
    retryAfterSeconds: 8,
  });
  let calls = 0;

  await assert.rejects(
    withDeepbridRateLimitRetry(
      async () => {
        calls++;
        throw failure;
      },
      { timeoutMs: 5_000, wait: async () => assert.fail('unexpected wait') }
    ),
    failure
  );
  assert.equal(calls, 1);
});

test('does not begin another attempt after cancellation', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  let calls = 0;

  await assert.rejects(
    withDeepbridRateLimitRetry(
      async () => {
        calls++;
        return 'unexpected';
      },
      { timeoutMs: 5_000, signal: controller.signal }
    ),
    /cancelled/
  );
  assert.equal(calls, 0);
});

test('summarizes numeric Finder API rate-limit and gate metrics without request data', () => {
  const metrics = new DeepbridFinderRequestMetrics();
  metrics.recordStart('search', 1_000, 1_025);
  metrics.recordResponse(
    200,
    new Headers({
      'x-ratelimit-limit': '250',
      'x-ratelimit-remaining': '202',
    }),
    81
  );
  metrics.recordStart('content', 2_000, 2_080);
  metrics.recordResponse(
    429,
    new Headers({
      'x-ratelimit-limit': '250',
      'x-ratelimit-remaining': '0',
      'retry-after': '2',
    }),
    410
  );
  metrics.recordStart('content', 3_000, 3_050);
  metrics.recordTransportFailure(
    'other',
    new Error('sensitive request details must never be retained', {
      cause: { code: 'UND_ERR_SOCKET' },
    })
  );
  metrics.recordTransportRetry('other', false);
  metrics.recordTransportRetry('other', true);
  metrics.recordRetryWait(1_750);

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.attempts, 3);
  assert.deepEqual(snapshot.attemptsByKind, {
    search: 1,
    content: 2,
    other: 0,
  });
  assert.deepEqual(snapshot.responses, {
    success: 1,
    rateLimited: 1,
    clientError: 0,
    serverError: 0,
    other: 0,
    transportFailure: 1,
  });
  assert.deepEqual(snapshot.transportFailuresByKind, {
    search: 0,
    content: 0,
    other: 1,
  });
  assert.deepEqual(snapshot.transportFailureClasses, {
    aborted: 0,
    timeout: 0,
    connection: 1,
    other: 0,
  });
  assert.deepEqual(snapshot.transportRetryAttemptsByKind, {
    search: 0,
    content: 0,
    other: 1,
  });
  assert.deepEqual(snapshot.transportRetryRecoveriesByKind, {
    search: 0,
    content: 0,
    other: 1,
  });
  assert.equal(snapshot.queueWait.p50Ms, 50);
  assert.equal(snapshot.queueWait.p95Ms, 80);
  assert.equal(snapshot.responseHeaders.p50Ms, 81);
  assert.equal(snapshot.responseHeaders.p95Ms, 410);
  assert.equal(snapshot.maxFinderRequestsInRollingMinute, 3);
  assert.deepEqual(snapshot.rateLimit, {
    observations: 2,
    latestLimit: 250,
    minimumRemaining: 0,
  });
  assert.deepEqual(snapshot.advertisedRetryAfter, {
    observations: 1,
    totalMs: 2_000,
    maxMs: 2_000,
  });
  assert.deepEqual(snapshot.actualRetryWait, {
    observations: 1,
    totalMs: 1_750,
    maxMs: 1_750,
  });
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /https?:\/\/|Bearer\s|Authorization|apiKey|finder\/search|finder\/content/i
  );
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /sensitive request details|UND_ERR_SOCKET/
  );
});

test('separates cold Finder page timing from warm and stale cache usage', () => {
  const metrics = new DeepbridFinderRequestMetrics();
  metrics.recordFreshSearchCacheHit(2);
  metrics.recordFreshSearchCacheHit(4);
  metrics.recordColdSearchFetch(180);
  metrics.recordColdSearchFetch(420);
  metrics.recordColdSearchFetchFailure();
  metrics.recordStaleSearchCacheFallback();

  const snapshot = metrics.snapshot();
  assert.deepEqual(snapshot.searchCache, {
    freshHits: 2,
    coalescedRequests: 0,
    staleRateLimitFallbacks: 1,
    coldFetches: 2,
    coldFetchFailures: 1,
    freshLookup: { samples: 2, p50Ms: 2, p95Ms: 4, maxMs: 4 },
    coldFetch: { samples: 2, p50Ms: 180, p95Ms: 420, maxMs: 420 },
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /url|apiKey|token|secret/i);
});

test('coalesces an identical in-flight Finder page while keeping caller cancellation independent', async () => {
  const apiKey = `coalesced-search-${Date.now()}-${Math.random()}`;
  const otherApiKey = `isolated-search-${Date.now()}-${Math.random()}`;
  const query = `coalesced-${Date.now()}-${Math.random()}`;
  const priorSigningSecret = process.env.DEEPBRID_FINDER_SIGNING_SECRET;
  process.env.DEEPBRID_FINDER_SIGNING_SECRET = 'test-only-signing-secret';
  const originalDispatcher = getGlobalDispatcher();
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  mockAgent
    .get('https://www.deepbrid.com')
    .intercept({
      path: `/api/v1/usenet/finder/search?q=${encodeURIComponent(query)}&offset=0&limit=50`,
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    .reply(
      200,
      JSON.stringify({
        items: [{ token: 'fixture-result', title: 'Fixture' }],
      }),
      {
        headers: {
          'content-type': 'application/json',
          date: new Date().toUTCString(),
        },
      }
    )
    .delay(80);
  mockAgent
    .get('https://www.deepbrid.com')
    .intercept({
      path: `/api/v1/usenet/finder/search?q=${encodeURIComponent(query)}&offset=0&limit=50`,
      method: 'GET',
      headers: { authorization: `Bearer ${otherApiKey}` },
    })
    .reply(
      200,
      JSON.stringify({
        items: [{ token: 'other-fixture', title: 'Other Profile' }],
      }),
      {
        headers: {
          'content-type': 'application/json',
          date: new Date().toUTCString(),
        },
      }
    )
    .delay(80);
  setGlobalDispatcher(mockAgent);

  try {
    await initDb('sqlite::memory:');
    await initialiseConfig();
    const client = new DeepbridFinderClient(apiKey);
    const overlappingClient = new DeepbridFinderClient(apiKey);
    const isolatedClient = new DeepbridFinderClient(otherApiKey);
    const abandoned = new AbortController();
    const retained = new AbortController();
    const abandonedRequest = client.searchPage(query, {
      timeoutMs: 800,
      signal: abandoned.signal,
    });
    const deadlineRequest = overlappingClient.searchPage(query, {
      timeoutMs: 1_200,
      deadlineAtMs: Date.now() + 15,
    });
    const retainedRequest = overlappingClient.searchPage(query, {
      timeoutMs: 20_000,
      signal: retained.signal,
    });
    const isolatedRequest = isolatedClient.searchPage(query);
    abandoned.abort();

    await assert.rejects(abandonedRequest, { name: 'AbortError' });
    await assert.rejects(deadlineRequest, { code: 'retry-exhausted' });
    const result = await retainedRequest;
    assert.equal(result.results[0]?.title, 'Fixture');
    const isolatedResult = await isolatedRequest;
    assert.equal(isolatedResult.results[0]?.title, 'Other Profile');
    const report = client.getRequestMetrics();
    const overlappingReport = overlappingClient.getRequestMetrics();
    const isolatedReport = isolatedClient.getRequestMetrics();
    assert.equal(report.attemptsByKind.search, 1);
    assert.equal(overlappingReport.attemptsByKind.search, 0);
    assert.equal(overlappingReport.searchCache.coalescedRequests, 2);
    assert.equal(isolatedReport.attemptsByKind.search, 1);
    assert.equal(isolatedReport.searchCache.coalescedRequests, 0);
    assert.equal(
      getDeepbridFinderRequestReport(apiKey).attemptsByKind.search,
      1,
      'separate client instances should contribute to one account-level latency report'
    );
    assert.equal(
      getDeepbridFinderRequestReport(otherApiKey).attemptsByKind.search,
      1,
      'different API keys must keep metrics isolated'
    );
    assert.doesNotMatch(
      JSON.stringify({ report, overlappingReport, isolatedReport }),
      /fixture-result|other-fixture|apiKey|token/i
    );
    mockAgent.assertNoPendingInterceptors();
  } finally {
    setGlobalDispatcher(originalDispatcher);
    await mockAgent.close();
    await closeDb();
    if (priorSigningSecret === undefined) {
      delete process.env.DEEPBRID_FINDER_SIGNING_SECRET;
    } else {
      process.env.DEEPBRID_FINDER_SIGNING_SECRET = priorSigningSecret;
    }
  }
});

test('Finder request report measures actual cold fetch and warm cache hit separately', async () => {
  const apiKey = `cache-metrics-${Date.now()}-${Math.random()}`;
  const query = `metrics-${Date.now()}-${Math.random()}`;
  const priorSigningSecret = process.env.DEEPBRID_FINDER_SIGNING_SECRET;
  process.env.DEEPBRID_FINDER_SIGNING_SECRET = 'test-only-signing-secret';
  const originalDispatcher = getGlobalDispatcher();
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  mockAgent
    .get('https://www.deepbrid.com')
    .intercept({
      path: `/api/v1/usenet/finder/search?q=${encodeURIComponent(query)}&offset=0&limit=50`,
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    .reply(
      200,
      JSON.stringify({
        items: [{ token: 'safe-test', title: 'Test release' }],
      }),
      {
        headers: {
          'content-type': 'application/json',
          date: new Date().toUTCString(),
        },
      }
    );
  setGlobalDispatcher(mockAgent);

  try {
    await initDb('sqlite::memory:');
    await initialiseConfig();
    const client = new DeepbridFinderClient(apiKey);
    await client.searchPage(query);
    await client.searchPage(query);
    const report = client.getRequestMetrics();
    assert.equal(report.searchCache.coldFetches, 1);
    assert.equal(report.searchCache.freshHits, 1);
    assert.equal(report.searchCache.coldFetch.samples, 1);
    assert.equal(report.searchCache.freshLookup.samples, 1);
    assert.equal(report.attemptsByKind.search, 1);
    await assert.rejects(
      client.searchPage(query, { deadlineAtMs: Date.now() - 1 }),
      { code: 'retry-exhausted' }
    );
    assert.equal(client.getRequestMetrics().searchCache.freshHits, 1);
    assert.doesNotMatch(
      JSON.stringify(report),
      /https?:\/\/|Bearer\s|safe-test/
    );
    mockAgent.assertNoPendingInterceptors();
  } finally {
    setGlobalDispatcher(originalDispatcher);
    await mockAgent.close();
    await closeDb();
    if (priorSigningSecret === undefined) {
      delete process.env.DEEPBRID_FINDER_SIGNING_SECRET;
    } else {
      process.env.DEEPBRID_FINDER_SIGNING_SECRET = priorSigningSecret;
    }
  }
});

test('classifies transport timeout and abort failures without retaining error data', () => {
  const metrics = new DeepbridFinderRequestMetrics();
  const timeout = new Error('timeout detail must not persist');
  timeout.name = 'TimeoutError';
  metrics.recordTransportFailure('search', timeout);
  metrics.recordTransportFailure('content', { code: 'ABORT_ERR' });

  const snapshot = metrics.snapshot();
  assert.deepEqual(snapshot.transportFailureClasses, {
    aborted: 1,
    timeout: 1,
    connection: 0,
    other: 0,
  });
  assert.deepEqual(snapshot.transportFailuresByKind, {
    search: 1,
    content: 1,
    other: 0,
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /timeout detail|ABORT_ERR/);
});
