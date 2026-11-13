import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DeepbridOfficialClient,
  parseDeepbridApiKeyInfo,
  parseDeepbridApiKeyDevices,
  parseDeepbridHosts,
  parseDeepbridUserLimits,
  parseDeepbridUserStats,
} from './client.js';

test('official account client uses only the documented stats and limits routes', async () => {
  const client = new DeepbridOfficialClient('synthetic-api-key');
  const paths: string[] = [];
  const responses: Record<string, Record<string, unknown>> = {
    '/user/stats': { downloads: 1, bandwidth_bytes: 1024 },
    '/apikey/info': { total_requests: 10, total_links: 3 },
    '/apikey/devices?limit=50': {
      total: 1,
      devices: [{ device_name: 'Kodi', request_count: 4 }],
    },
    '/user/limits': {
      limits_enabled: true,
      hosters: [{ domain: 'example.com', type: 'links', limit: 2, used: 1 }],
    },
  };
  (
    client as unknown as {
      requestJson: (path: string) => Promise<Record<string, unknown>>;
    }
  ).requestJson = async (path) => {
    paths.push(path);
    return responses[path]!;
  };

  assert.deepEqual(await client.getUserStats(), {
    downloads: 1,
    bandwidthBytes: 1024,
  });
  assert.deepEqual(await client.getApiKeyInfo(), {
    totalRequests: 10,
    totalLinks: 3,
  });
  assert.deepEqual(await client.getApiKeyDevices(), {
    total: 1,
    devices: [{ deviceName: 'Kodi', requestCount: 4 }],
    truncated: false,
  });
  assert.deepEqual(await client.getUserLimits(), {
    enabled: true,
    hostersTruncated: false,
    hosters: [
      {
        domain: 'example.com',
        type: 'links',
        limit: 2,
        used: 1,
        remaining: 1,
      },
    ],
  });
  assert.deepEqual(paths, [
    '/user/stats',
    '/apikey/info',
    '/apikey/devices?limit=50',
    '/user/limits',
  ]);
});

test('projects documented Deepbrid usage stats and discards unknown fields', () => {
  assert.deepEqual(
    parseDeepbridUserStats({
      downloads: 42,
      bandwidth: '15.30 GB',
      bandwidth_bytes: 16_424_337_408,
      torrents: 5,
      remote: 3,
      email: 'private@example.invalid',
      apikey: 'must-not-escape',
      url: 'https://private.invalid/path',
    }),
    {
      downloads: 42,
      bandwidthBytes: 16_424_337_408,
      bandwidthDisplay: '15.30 GB',
      torrents: 5,
      remote: 3,
    }
  );
});

test('projects API key activity while dropping the API key, IP, and malformed fields', () => {
  assert.deepEqual(
    parseDeepbridApiKeyInfo({
      total_requests: '12450',
      total_links: 3201,
      last_used_at: '2026-02-27 14:22:00',
      created_at: '2026-01-01 00:00:00',
      regenerated_at: null,
      apikey: 'secret-value',
      last_ip: '203.0.113.10',
      user_agent: 'private-client',
    }),
    {
      totalRequests: 12450,
      totalLinks: 3201,
      lastUsedAt: '2026-02-27 14:22:00',
      createdAt: '2026-01-01 00:00:00',
    }
  );
  const serialized = JSON.stringify(
    parseDeepbridApiKeyInfo({ apikey: 'secret-value', last_ip: '203.0.113.10' })
  );
  assert.equal(serialized.includes('secret-value'), false);
  assert.equal(serialized.includes('203.0.113.10'), false);
});

test('projects API device audit without IP addresses and caps the returned device list', () => {
  const devices = Array.from({ length: 55 }, (_, index) => ({
    ip_address: `192.0.2.${index}`,
    device_name: `Client ${index}\nInjected`,
    user_agent: 'Example/1.0',
    first_seen_at: '2026-01-15 10:30:00',
    last_seen_at: '2026-02-27 14:22:00',
    request_count: index,
    api_key: 'must-not-escape',
  }));
  const projected = parseDeepbridApiKeyDevices({ total: 55, devices });
  assert.equal(projected.total, 55);
  assert.equal(projected.devices.length, 50);
  assert.equal(projected.truncated, true);
  assert.deepEqual(projected.devices[0], {
    deviceName: 'Client 0 Injected',
    userAgent: 'Example/1.0',
    firstSeenAt: '2026-01-15 10:30:00',
    lastSeenAt: '2026-02-27 14:22:00',
    requestCount: 0,
  });
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes('192.0.2.'), false);
  assert.equal(serialized.includes('must-not-escape'), false);
});

test('accepts nested stats while ignoring invalid and unsafe values', () => {
  assert.deepEqual(
    parseDeepbridUserStats({
      data: {
        downloads: -1,
        bandwidth_bytes: Number.MAX_SAFE_INTEGER + 1,
        torrents: 'not-a-count',
        remote: '4',
        bandwidth: '  1.00 GB\nprivate detail  ',
      },
      apikey: 'must-not-escape',
    }),
    { bandwidthDisplay: '1.00 GB private detail', remote: 4 }
  );
});

test('projects bounded per-hoster link and byte limits without leaking fields', () => {
  assert.deepEqual(
    parseDeepbridUserLimits({
      limits_enabled: true,
      reset: 'daily',
      hosters: [
        { domain: 'MEGA.nz', type: 'links', limit: 5, used: 3, remaining: 2 },
        {
          domain: 'turbobit.net',
          type: 'bandwidth',
          limit: 10_737_418_240,
          used: 2_147_483_648,
          remaining: 8_589_934_592,
          limit_str: '10.00 GB',
          used_str: '2.00 GB',
          remaining_str: '8.00 GB',
          api_key: 'must-not-escape',
          download: 'https://private.invalid/link',
        },
        { domain: 'https://evil.invalid', type: 'links', limit: 5, used: 1 },
        { domain: 'broken.invalid', type: 'unknown', limit: 5, used: 1 },
      ],
      api_key: 'must-not-escape',
    }),
    {
      enabled: true,
      reset: 'daily',
      hostersTruncated: false,
      hosters: [
        {
          domain: 'mega.nz',
          type: 'links',
          limit: 5,
          used: 3,
          remaining: 2,
        },
        {
          domain: 'turbobit.net',
          type: 'bandwidth',
          limit: 10_737_418_240,
          used: 2_147_483_648,
          remaining: 8_589_934_592,
          limitDisplay: '10.00 GB',
          usedDisplay: '2.00 GB',
          remainingDisplay: '8.00 GB',
        },
      ],
    }
  );
});

test('derives missing remaining quota safely and handles malformed limits', () => {
  assert.deepEqual(
    parseDeepbridUserLimits({
      limits_enabled: false,
      hosters: [
        { domain: 'example.com', type: 'links', limit: 4, used: 7 },
        { domain: 'example.net', type: 'bandwidth', limit: 1.5, used: 0 },
        null,
      ],
      ignored: 'private',
    }),
    {
      enabled: false,
      hostersTruncated: false,
      hosters: [
        {
          domain: 'example.com',
          type: 'links',
          limit: 4,
          used: 7,
          remaining: 0,
        },
      ],
    }
  );
});

test('reports when the hoster projection cap truncates provider data', () => {
  const rows = Array.from({ length: 301 }, (_, index) => ({
    domain: `host${index}.example`,
    type: 'links',
    limit: 4,
    used: 1,
  }));
  const result = parseDeepbridUserLimits({ hosters: rows });
  assert.equal(result.hosters.length, 300);
  assert.equal(result.hostersTruncated, true);
});

test('projects the public host-status endpoint without arbitrary fields', () => {
  assert.deepEqual(
    parseDeepbridHosts([
      { 'Mega.nz': 'up' },
      { 'turbobit.net': 'down (2026-03-01)' },
      { 'not a host': 'up' },
      { 'evil.example': 'up', api_key: 'must-not-escape' },
      { 'mega.nz': 'down' },
    ]),
    {
      truncated: false,
      hosts: [
        { domain: 'mega.nz', status: 'up', online: true },
        {
          domain: 'turbobit.net',
          status: 'down (2026-03-01)',
          online: false,
        },
        { domain: 'evil.example', status: 'up', online: true },
      ],
    }
  );

  const oversized = parseDeepbridHosts(
    Array.from({ length: 501 }, (_, index) => ({
      [`host${index}.example`]: 'up',
    }))
  );
  assert.equal(oversized.hosts.length, 500);
  assert.equal(oversized.truncated, true);
  assert.equal(JSON.stringify(oversized).includes('api_key'), false);
});

test('official client calls the public hosts endpoint and parses its response', async () => {
  const client = new DeepbridOfficialClient('synthetic-api-key');
  let called = '';
  (
    client as unknown as {
      requestJson: (path: string) => Promise<Record<string, unknown>>;
    }
  ).requestJson = async (path) => {
    called = path;
    return { hosts: [{ 'example.com': 'up' }] };
  };
  assert.deepEqual(await client.getHosts(), {
    hosts: [{ domain: 'example.com', status: 'up', online: true }],
    truncated: false,
  });
  assert.equal(called, '/hosts');
});

test('recognizes the documented subscription type without retaining raw fields', async () => {
  const client = new DeepbridOfficialClient('synthetic-api-key');
  const records = [
    { type: 'premium', apikey: 'must-not-escape' },
    { type: 'free', email: 'private@example.invalid' },
    { type: 'other' },
    { type: 'premium', is_premium: false },
  ];
  let index = 0;
  (
    client as unknown as {
      requestJson: (path: string) => Promise<Record<string, unknown>>;
    }
  ).requestJson = async (path) => {
    assert.equal(path, '/user');
    return records[index++]!;
  };

  assert.equal((await client.getUser()).premium, true);
  assert.equal((await client.getUser()).premium, false);
  assert.equal((await client.getUser()).premium, undefined);
  const booleanWins = await client.getUser();
  assert.equal(booleanWins.premium, false);
  assert.equal('raw' in booleanWins, false);
});

test('projects documented account expiry and ceilings without raw API fields', async () => {
  const client = new DeepbridOfficialClient('synthetic-api-key');
  (
    client as unknown as {
      requestJson: (path: string) => Promise<Record<string, unknown>>;
    }
  ).requestJson = async () => ({
    type: 'premium',
    expiration: '2027-05-19',
    maxDownloads: '5',
    maxConnections: 2,
    fidelity_points: 18,
    email: 'private@example.invalid',
    apikey: 'must-not-escape',
    last_ip: '203.0.113.4',
  });

  const user = await client.getUser();
  assert.deepEqual(user, {
    id: undefined,
    username: undefined,
    email: 'private@example.invalid',
    premium: true,
    expiration: '2027-05-19',
    maxDownloads: 5,
    maxConnections: 2,
    fidelityPoints: 18,
  });
  const serialized = JSON.stringify(user);
  assert.equal(serialized.includes('must-not-escape'), false);
  assert.equal(serialized.includes('203.0.113.4'), false);
});
