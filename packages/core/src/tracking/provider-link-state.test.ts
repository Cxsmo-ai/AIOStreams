import assert from 'node:assert/strict';
import test from 'node:test';
import type { DbDriver } from '../db/driver/types.js';
import { SqliteDriver } from '../db/driver/sqlite.js';
import {
  changedTrackerProviderLinks,
  clearTrackerProviderLinkState,
  isCurrentTrackerProviderLink,
  saveTrackerProviderLinkState,
  withTrackerProviderLinkLock,
  withTrackerProviderLinkLocks,
} from './provider-link-state.js';

async function makeLinkStateDb(): Promise<SqliteDriver> {
  const db = new SqliteDriver(':memory:');
  await db.exec('CREATE TABLE users (uuid TEXT PRIMARY KEY)');
  await db.exec(
    'CREATE TABLE tracker_provider_outbox (user_uuid TEXT, provider_id TEXT, record_id TEXT, PRIMARY KEY(user_uuid, provider_id, record_id))'
  );
  await db.exec(
    'CREATE TABLE tracker_scrobble_outbox (user_uuid TEXT, provider_id TEXT, event_id TEXT, PRIMARY KEY(user_uuid, provider_id, event_id))'
  );
  await db.exec(
    'CREATE TABLE tracker_provider_records (user_uuid TEXT, provider_id TEXT, record_id TEXT, PRIMARY KEY(user_uuid, provider_id, record_id))'
  );
  await db.exec(
    'CREATE TABLE tracker_provider_facets (user_uuid TEXT, provider_id TEXT, facet_id TEXT, PRIMARY KEY(user_uuid, provider_id, facet_id))'
  );
  await db.exec(
    'CREATE TABLE tracker_provider_sync_state (user_uuid TEXT, provider_id TEXT, PRIMARY KEY(user_uuid, provider_id))'
  );
  await db.exec(
    'CREATE TABLE tracker_records (user_uuid TEXT, record_id TEXT, PRIMARY KEY(user_uuid, record_id))'
  );
  await db.exec(
    'CREATE TABLE tracker_provider_link_state (user_uuid TEXT, provider_id TEXT, auth_ref TEXT, generation INTEGER, updated_at_ms INTEGER, PRIMARY KEY(user_uuid, provider_id))'
  );
  await db.exec("INSERT INTO users (uuid) VALUES ('profile-a'), ('profile-b')");
  return db;
}

test('tracker link changes are provider-local and ignore enabled-only changes', () => {
  assert.deepEqual(
    changedTrackerProviderLinks(
      { floppy: { authRef: 'old-floppy' }, wetrakr: { authRef: 'same' } },
      { floppy: { authRef: 'new-floppy' }, wetrakr: { authRef: 'same' } }
    ),
    ['floppy']
  );
  assert.deepEqual(
    changedTrackerProviderLinks(
      { wetrakr: { authRef: 'same' } },
      { wetrakr: { authRef: 'same' } }
    ),
    []
  );
  assert.deepEqual(
    changedTrackerProviderLinks({ floppy: { authRef: 'old-floppy' } }, {}),
    ['floppy']
  );
});

test('link generation checks use row locks only on PostgreSQL', async () => {
  const sqliteCalls: string[] = [];
  const sqlite = {
    dialect: 'sqlite',
    exec: async (sql: string) => {
      sqliteCalls.push(sql);
      return { rowCount: 1 };
    },
    maybeOne: async () => ({ auth_ref: 'current', generation: 2 }),
  } as unknown as DbDriver;
  assert.equal(
    await isCurrentTrackerProviderLink(
      sqlite,
      'profile-a',
      'floppy',
      'current',
      2,
      true
    ),
    true
  );
  assert.deepEqual(sqliteCalls, []);

  const postgresCalls: string[] = [];
  const postgres = {
    dialect: 'postgres',
    maybeOne: async (sql: string) => {
      postgresCalls.push(sql);
      return { auth_ref: 'current', generation: 2 };
    },
  } as unknown as DbDriver;
  assert.equal(
    await isCurrentTrackerProviderLink(
      postgres,
      'profile-a',
      'floppy',
      'current',
      2,
      true
    ),
    true
  );
  assert.match(postgresCalls[0]!, /FOR UPDATE$/);
});

test('profile/provider locks serialize relinking behind an in-flight delivery', async () => {
  let signalEntered!: () => void;
  let releaseDelivery!: () => void;
  const entered = new Promise<void>((resolve) => (signalEntered = resolve));
  const blocked = new Promise<void>((resolve) => (releaseDelivery = resolve));
  const order: string[] = [];

  const delivery = withTrackerProviderLinkLock(
    'profile-a',
    'floppy',
    async () => {
      order.push('delivery-start');
      signalEntered();
      await blocked;
      order.push('delivery-end');
    }
  );
  await entered;
  const relink = withTrackerProviderLinkLocks(
    'profile-a',
    ['floppy'],
    async () => void order.push('relink')
  );
  await Promise.resolve();
  assert.deepEqual(order, ['delivery-start']);

  releaseDelivery();
  await Promise.all([delivery, relink]);
  assert.deepEqual(order, ['delivery-start', 'delivery-end', 'relink']);
});

test('profile/provider locks do not serialize unrelated profiles or providers', async () => {
  const entered = new Set<string>();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const first = withTrackerProviderLinkLock('profile-a', 'floppy', async () => {
    entered.add('a/floppy');
    await blocked;
  });
  while (!entered.has('a/floppy')) await Promise.resolve();
  await Promise.all([
    withTrackerProviderLinkLock('profile-a', 'wetrakr', async () => {
      entered.add('a/wetrakr');
    }),
    withTrackerProviderLinkLock('profile-b', 'floppy', async () => {
      entered.add('b/floppy');
    }),
  ]);
  assert.deepEqual([...entered].sort(), ['a/floppy', 'a/wetrakr', 'b/floppy']);
  release();
  await first;
});

test('relink cleanup removes only provider sync state and retains canonical history', async () => {
  const statements: Array<{ sql: string; params?: readonly unknown[] }> = [];
  const tx = {
    exec: async (sql: string, params?: readonly unknown[]) => {
      statements.push({ sql: String(sql), params });
      return { rowCount: 1 };
    },
  } as DbDriver;

  await clearTrackerProviderLinkState(tx, 'config-a', 'wetrakr');

  assert.deepEqual(
    statements.map(({ sql }) => sql.match(/DELETE FROM ([a-z_]+)/)?.[1]),
    [
      'tracker_provider_outbox',
      'tracker_scrobble_outbox',
      'tracker_provider_records',
      'tracker_provider_facets',
      'tracker_provider_sync_state',
    ]
  );
  assert.ok(
    statements.every(
      ({ sql, params }) =>
        sql.includes('WHERE user_uuid = ? AND provider_id = ?') &&
        params?.[0] === 'config-a' &&
        params[1] === 'wetrakr'
    )
  );
  assert.ok(statements.every(({ sql }) => !sql.includes('tracker_records ')));
  await assert.rejects(
    clearTrackerProviderLinkState(tx, 'config-a', 'wetrakr; DROP TABLE users'),
    /Invalid tracker provider id/
  );
});

test('database-backed relink is isolated by saved config and provider', async () => {
  const db = await makeLinkStateDb();
  try {
    for (const table of [
      'tracker_provider_outbox',
      'tracker_scrobble_outbox',
      'tracker_provider_records',
      'tracker_provider_facets',
      'tracker_provider_sync_state',
      'tracker_records',
    ]) {
      if (table === 'tracker_records') {
        await db.exec(
          'INSERT INTO tracker_records (user_uuid, record_id) VALUES (?, ?)',
          ['profile-a', 'canonical-history']
        );
        continue;
      }
      const idColumn =
        table === 'tracker_scrobble_outbox'
          ? 'event_id'
          : table === 'tracker_provider_facets'
            ? 'facet_id'
            : table === 'tracker_provider_sync_state'
              ? null
              : 'record_id';
      const values = idColumn ? `, ${idColumn}` : '';
      if (idColumn) {
        await db.exec(
          `INSERT INTO ${table} (user_uuid, provider_id${values}) VALUES (?, ?, ?)`,
          ['profile-a', 'wetrakr', 'wetrakr-item']
        );
        await db.exec(
          `INSERT INTO ${table} (user_uuid, provider_id${values}) VALUES (?, ?, ?)`,
          ['profile-a', 'floppy', 'floppy-item']
        );
        await db.exec(
          `INSERT INTO ${table} (user_uuid, provider_id${values}) VALUES (?, ?, ?)`,
          ['profile-b', 'wetrakr', 'other-profile-item']
        );
      } else {
        await db.exec(
          `INSERT INTO ${table} (user_uuid, provider_id) VALUES (?, ?)`,
          ['profile-a', 'wetrakr']
        );
      }
    }
    await db.tx(async (tx) => {
      await saveTrackerProviderLinkState(
        tx,
        'profile-a',
        'wetrakr',
        'auth-old',
        false,
        100
      );
      await clearTrackerProviderLinkState(tx, 'profile-a', 'wetrakr');
      await saveTrackerProviderLinkState(
        tx,
        'profile-a',
        'wetrakr',
        'auth-new',
        true,
        200
      );
    });

    assert.equal(
      await db.count(
        'SELECT COUNT(*) FROM tracker_provider_outbox WHERE user_uuid = ? AND provider_id = ?',
        ['profile-a', 'wetrakr']
      ),
      0
    );
    assert.equal(
      await db.count(
        'SELECT COUNT(*) FROM tracker_provider_outbox WHERE user_uuid = ? AND provider_id = ?',
        ['profile-a', 'floppy']
      ),
      1
    );
    assert.equal(
      await db.count(
        'SELECT COUNT(*) FROM tracker_provider_outbox WHERE user_uuid = ? AND provider_id = ?',
        ['profile-b', 'wetrakr']
      ),
      1
    );
    assert.equal(
      await db.count(
        'SELECT COUNT(*) FROM tracker_records WHERE user_uuid = ?',
        ['profile-a']
      ),
      1,
      'canonical merged history is retained'
    );
    assert.equal(
      await isCurrentTrackerProviderLink(
        db,
        'profile-a',
        'wetrakr',
        'auth-old',
        1
      ),
      false
    );
    assert.equal(
      await isCurrentTrackerProviderLink(
        db,
        'profile-a',
        'wetrakr',
        'auth-new',
        2
      ),
      true
    );
    const generation = await db.maybeOne<{ generation: number }>(
      'SELECT generation FROM tracker_provider_link_state WHERE user_uuid = ? AND provider_id = ?',
      ['profile-a', 'wetrakr']
    );
    assert.equal(generation?.generation, 2);
    await db.tx((tx) =>
      saveTrackerProviderLinkState(
        tx,
        'profile-a',
        'wetrakr',
        'auth-old',
        true,
        300
      )
    );
    assert.equal(
      await isCurrentTrackerProviderLink(
        db,
        'profile-a',
        'wetrakr',
        'auth-old',
        2
      ),
      false,
      'reusing an earlier authRef must not revive its old generation'
    );
    assert.equal(
      await isCurrentTrackerProviderLink(
        db,
        'profile-a',
        'wetrakr',
        'auth-old',
        3
      ),
      true
    );
  } finally {
    await db.close();
  }
});

test('link state and outbox cleanup roll back together on failure', async () => {
  const db = await makeLinkStateDb();
  try {
    await db.exec(
      'INSERT INTO tracker_provider_outbox (user_uuid, provider_id, record_id) VALUES (?, ?, ?)',
      ['profile-a', 'floppy', 'keep-until-commit']
    );
    await db.exec(
      'INSERT INTO tracker_provider_records (user_uuid, provider_id, record_id) VALUES (?, ?, ?)',
      ['profile-a', 'floppy', 'snapshot-to-fail']
    );
    await db.exec(
      "CREATE TRIGGER fail_provider_snapshot_delete BEFORE DELETE ON tracker_provider_records BEGIN SELECT RAISE(ABORT, 'forced rollback'); END"
    );
    await assert.rejects(
      db.tx(async (tx) => {
        await clearTrackerProviderLinkState(tx, 'profile-a', 'floppy');
        await saveTrackerProviderLinkState(
          tx,
          'profile-a',
          'floppy',
          'new-ref',
          true
        );
      }),
      /forced rollback/
    );
    assert.equal(
      await db.count(
        'SELECT COUNT(*) FROM tracker_provider_outbox WHERE user_uuid = ? AND provider_id = ?',
        ['profile-a', 'floppy']
      ),
      1
    );
    assert.equal(
      await db.count(
        'SELECT COUNT(*) FROM tracker_provider_link_state WHERE user_uuid = ? AND provider_id = ?',
        ['profile-a', 'floppy']
      ),
      0
    );
  } finally {
    await db.close();
  }
});
