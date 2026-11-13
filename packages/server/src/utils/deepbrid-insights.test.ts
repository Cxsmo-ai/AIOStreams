import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadDeepbridInsights,
  projectDeepbridInsightOutcome,
} from './deepbrid-insights.js';

test('keeps account usage successful when the limits request is premium-restricted', () => {
  const stats = projectDeepbridInsightOutcome({
    status: 'fulfilled',
    value: { downloads: 12 },
  });
  const limits = projectDeepbridInsightOutcome({
    status: 'rejected',
    reason: Object.assign(new Error('private provider response'), {
      status: 403,
      apiKey: 'never-return-this',
    }),
  });

  assert.deepEqual(stats, {
    status: 'available',
    data: { downloads: 12 },
  });
  assert.deepEqual(limits, {
    status: 'unavailable',
    reason: 'premium-required-or-forbidden',
  });
  assert.equal(
    JSON.stringify(limits).includes('private provider response'),
    false
  );
  assert.equal(JSON.stringify(limits).includes('never-return-this'), false);
});

test('maps other failure classes without exposing provider messages', () => {
  for (const [status, reason] of [
    [401, 'authentication'],
    [429, 'rate-limited'],
    [503, 'provider-unavailable'],
  ] as const) {
    assert.deepEqual(
      projectDeepbridInsightOutcome({
        status: 'rejected',
        reason: Object.assign(new Error('sensitive response body'), { status }),
      }),
      { status: 'unavailable', reason }
    );
  }
  assert.deepEqual(
    projectDeepbridInsightOutcome({
      status: 'rejected',
      reason: new Error('private url and token'),
    }),
    { status: 'unavailable', reason: 'provider-unavailable' }
  );
});

test('skips Premium-only quota endpoint for a documented free plan', async () => {
  const calls: string[] = [];
  const result = await loadDeepbridInsights(
    {
      getUser: async () => ({ premium: false }),
      getUserStats: async () => {
        calls.push('stats');
        return { downloads: 3 };
      },
      getApiKeyInfo: async () => {
        calls.push('api-key-info');
        return { totalRequests: 9 };
      },
      getApiKeyDevices: async () => {
        calls.push('api-key-devices');
        return { devices: [], truncated: false };
      },
      getHosts: async () => {
        calls.push('hosts');
        return { hosts: [], truncated: false };
      },
      getOfficialApps: async () => {
        calls.push('official-apps');
        return { apps: [], truncated: false };
      },
      getUserLimits: async () => {
        calls.push('limits');
        return { hosters: [] };
      },
    },
    1_000
  );

  assert.equal(result.plan, 'free');
  assert.deepEqual(result.accountDetails, {
    status: 'available',
    data: {},
  });
  assert.deepEqual(calls, [
    'stats',
    'api-key-info',
    'api-key-devices',
    'hosts',
    'official-apps',
  ]);
  assert.deepEqual(result.limits, {
    status: 'unavailable',
    reason: 'premium-required',
  });
  assert.deepEqual(result.stats, {
    status: 'available',
    data: { downloads: 3 },
  });
  assert.deepEqual(result.apiKeyActivity, {
    status: 'available',
    data: { totalRequests: 9 },
  });
  assert.deepEqual(result.apiKeyDevices, {
    status: 'available',
    data: { devices: [], truncated: false },
  });
  assert.deepEqual(result.hostStatus, {
    status: 'available',
    data: { hosts: [], truncated: false },
  });
  assert.deepEqual(result.officialApps, {
    status: 'available',
    data: { apps: [], truncated: false },
  });
});

test('loads limits for Premium and unknown plans while preserving separate stats', async () => {
  for (const premium of [true, undefined]) {
    const calls: Array<{ name: string; deadlineAtMs: number }> = [];
    const result = await loadDeepbridInsights(
      {
        getUser: async (options) => {
          calls.push({ name: 'user', deadlineAtMs: options.deadlineAtMs });
          if (premium === undefined) throw new Error('safe synthetic failure');
          return {
            premium,
            expiration: '2027-05-19',
            maxDownloads: 5,
            maxConnections: 2,
            fidelityPoints: 18,
          };
        },
        getUserStats: async (options) => {
          calls.push({ name: 'stats', deadlineAtMs: options.deadlineAtMs });
          throw Object.assign(new Error('private response'), { status: 429 });
        },
        getApiKeyInfo: async (options) => {
          calls.push({
            name: 'api-key-info',
            deadlineAtMs: options.deadlineAtMs,
          });
          return { totalRequests: 23 };
        },
        getApiKeyDevices: async (options, limit) => {
          calls.push({
            name: `api-key-devices-${limit}`,
            deadlineAtMs: options.deadlineAtMs,
          });
          return { devices: [], truncated: false };
        },
        getHosts: async (options) => {
          calls.push({ name: 'hosts', deadlineAtMs: options.deadlineAtMs });
          return { hosts: [], truncated: false };
        },
        getOfficialApps: async (options) => {
          calls.push({
            name: 'official-apps',
            deadlineAtMs: options.deadlineAtMs,
          });
          return { apps: [], truncated: false };
        },
        getUserLimits: async (options) => {
          calls.push({ name: 'limits', deadlineAtMs: options.deadlineAtMs });
          return { hosters: [], hostersTruncated: false };
        },
      },
      1_000
    );

    assert.equal(result.plan, premium ? 'premium' : 'unknown');
    assert.deepEqual(
      result.accountDetails,
      premium === undefined
        ? { status: 'unavailable', reason: 'provider-unavailable' }
        : {
            status: 'available',
            data: {
              expiration: '2027-05-19',
              maxDownloads: 5,
              maxConnections: 2,
              fidelityPoints: 18,
            },
          }
    );
    assert.deepEqual(
      calls.map(({ name }) => name),
      [
        'user',
        'stats',
        'api-key-info',
        'api-key-devices-50',
        'hosts',
        'official-apps',
        'limits',
      ]
    );
    assert.ok(calls.every(({ deadlineAtMs }) => deadlineAtMs === 21_000));
    assert.deepEqual(result.stats, {
      status: 'unavailable',
      reason: 'rate-limited',
    });
    assert.deepEqual(result.apiKeyActivity, {
      status: 'available',
      data: { totalRequests: 23 },
    });
    assert.deepEqual(result.apiKeyDevices, {
      status: 'available',
      data: { devices: [], truncated: false },
    });
    assert.deepEqual(result.hostStatus, {
      status: 'available',
      data: { hosts: [], truncated: false },
    });
    assert.deepEqual(result.officialApps, {
      status: 'available',
      data: { apps: [], truncated: false },
    });
    assert.deepEqual(result.limits, {
      status: 'available',
      data: { hosters: [], hostersTruncated: false },
    });
  }
});
