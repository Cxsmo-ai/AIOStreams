import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteDriver } from '../db/driver/sqlite.js';
import { wetrakrRequestQuota } from '../db/migrations/900011_wetrakr_request_quota.js';
import { reserveWeTrakrRequest, WETRAKR_QUOTA } from './wetrakr-quota.js';

async function createDb(): Promise<SqliteDriver> {
  const db = new SqliteDriver(':memory:');
  for (const statement of wetrakrRequestQuota.up.sqlite
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)) {
    await db.exec(statement);
  }
  return db;
}

test('shares GET and write budgets across calls using the same app key', async () => {
  const db = await createDb();
  try {
    const now = 1_800_000_000_000;
    for (let i = 0; i < WETRAKR_QUOTA.getsPerMinute; i += 1)
      assert.equal(
        (
          await reserveWeTrakrRequest('shared-client', 'get', {
            database: db,
            now,
          })
        ).allowed,
        true
      );
    const blockedGet = await reserveWeTrakrRequest('shared-client', 'get', {
      database: db,
      now,
    });
    assert.equal(blockedGet.allowed, false);
    assert.equal(blockedGet.reason, 'get_minute');
    assert.ok((blockedGet.retryAfterMs ?? 0) > 0);

    assert.equal(
      (
        await reserveWeTrakrRequest('shared-client', 'write', {
          database: db,
          now,
        })
      ).allowed,
      true
    );
  } finally {
    await db.close();
  }
});

test('atomically caps concurrent writes below the provider limit', async () => {
  const db = await createDb();
  try {
    const now = 1_800_000_000_000;
    const decisions = await Promise.all(
      Array.from({ length: WETRAKR_QUOTA.writesPerMinute + 12 }, () =>
        reserveWeTrakrRequest('concurrent-client', 'write', {
          database: db,
          now,
        })
      )
    );
    assert.equal(
      decisions.filter(({ allowed }) => allowed).length,
      WETRAKR_QUOTA.writesPerMinute
    );
    assert.equal(
      decisions.filter(({ reason }) => reason === 'write_minute').length,
      12
    );
  } finally {
    await db.close();
  }
});

test('refuses requests before the configured rolling daily ceiling and releases them after expiry', async () => {
  const db = await createDb();
  try {
    const now = 1_800_000_000_000;
    assert.equal(
      (
        await reserveWeTrakrRequest('daily-client', 'write', {
          database: db,
          now,
        })
      ).allowed,
      true
    );
    const [{ client_hash: clientHash }] = await db.query<{
      client_hash: string;
    }>('SELECT client_hash FROM wetrakr_quota_clients');
    for (let i = 1; i < WETRAKR_QUOTA.requestsPer24Hours; i += 1)
      await db.exec(
        'INSERT INTO wetrakr_quota_requests (request_id, client_hash, requested_at_ms, request_kind) VALUES (?, ?, ?, ?)',
        [`seed-${i}`, clientHash, now, 'write']
      );

    const blocked = await reserveWeTrakrRequest('daily-client', 'get', {
      database: db,
      now,
    });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, 'daily');

    const released = await reserveWeTrakrRequest('daily-client', 'get', {
      database: db,
      now: now + 24 * 60 * 60 * 1000 + 1,
    });
    assert.equal(released.allowed, true);
  } finally {
    await db.close();
  }
});

test('isolates request budgets by app key without storing raw client IDs', async () => {
  const db = await createDb();
  try {
    const now = 1_800_000_000_000;
    assert.equal(
      (await reserveWeTrakrRequest('client-a', 'write', { database: db, now }))
        .allowed,
      true
    );
    assert.equal(
      (await reserveWeTrakrRequest('client-b', 'write', { database: db, now }))
        .allowed,
      true
    );
    const rows = await db.query<{ client_hash: string }>(
      'SELECT client_hash FROM wetrakr_quota_clients'
    );
    assert.equal(rows.length, 2);
    assert.equal(
      rows.some(
        (row) =>
          row.client_hash === 'client-a' || row.client_hash === 'client-b'
      ),
      false
    );
  } finally {
    await db.close();
  }
});
