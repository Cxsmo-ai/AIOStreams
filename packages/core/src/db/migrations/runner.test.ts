import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteDriver } from '../driver/sqlite.js';
import { MIGRATIONS } from './index.js';
import { getMigrationStatus, runMigrations } from './runner.js';

async function applyMigration(
  db: SqliteDriver,
  migration: (typeof MIGRATIONS)[number],
  id = migration.id
): Promise<void> {
  for (const statement of migration.up.sqlite
    .split(/;\s*(?:\r?\n|$)/g)
    .map((part) => part.trim())
    .filter(Boolean)) {
    await db.exec(statement);
  }
  await db.exec('INSERT INTO _migrations (id, name) VALUES (?, ?)', [
    id,
    migration.name,
  ]);
}

test('migration registry preserves published IDs and has an ordered unique range', () => {
  const ids = MIGRATIONS.map((migration) => migration.id);
  const names = MIGRATIONS.map((migration) => migration.name);

  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(
    ids,
    [...ids].sort((a, b) => a - b)
  );
  assert.deepEqual(
    ids.slice(0, 19),
    Array.from({ length: 19 }, (_, i) => i + 1)
  );
  assert.deepEqual(
    ids.filter((id) => id >= 900012 && id <= 900040),
    Array.from({ length: 29 }, (_, i) => 900012 + i)
  );
  assert.equal(ids.at(-1), 901001);
});

test('upgrades the fork migration history without reusing upstream migration IDs', async () => {
  const db = new SqliteDriver(':memory:');
  try {
    await db.exec(
      'CREATE TABLE _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)'
    );

    for (const migration of MIGRATIONS.filter(
      ({ id }) => id <= 19 || (id >= 900001 && id <= 900011)
    )) {
      await applyMigration(db, migration);
    }

    // Production has a historical local migration at id 20, as well as the
    // same custom migration correctly recorded at id 900005.
    await db.exec('INSERT INTO _migrations (id, name) VALUES (?, ?)', [
      20,
      'addon_performance',
    ]);
    await db.exec(
      'INSERT INTO tracker_records (user_uuid, record_id, record_json, updated_at_ms) VALUES (?, ?, ?, ?)',
      ['existing-user', 'movie:imdb:tt0000001', '{"state":"watched"}', 100]
    );

    await runMigrations(db);
    const { applied, pending } = await getMigrationStatus(db);
    assert.equal(pending.length, 0);
    assert.ok(applied.some((migration) => migration.name === 'anime_database'));
    assert.equal(
      (
        await db.maybeOne<{ name: string }>(
          'SELECT name FROM _migrations WHERE id = 20'
        )
      )?.name,
      'addon_performance'
    );
    assert.equal(
      (
        await db.maybeOne<{ id: number }>(
          'SELECT id FROM _migrations WHERE name = ?',
          ['anime_database']
        )
      )?.id,
      900012
    );
    assert.equal(
      await db.count(
        'SELECT COUNT(*) FROM tracker_record_changes WHERE user_uuid = ? AND record_id = ?',
        ['existing-user', 'movie:imdb:tt0000001']
      ),
      1,
      'existing tracker records are seeded into the bridge feed'
    );
    assert.equal(
      await db.count(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
        ['jellyfin_tracker_bridge_rejections']
      ),
      1,
      'unsupported bridge events have a durable quarantine table'
    );

    await db.exec(
      'INSERT INTO tracker_records (user_uuid, record_id, record_json, updated_at_ms) VALUES (?, ?, ?, ?)',
      ['existing-user', 'movie:imdb:tt0000002', '{"state":"watched"}', 200]
    );
    await db.exec(
      'UPDATE tracker_records SET record_json = ?, updated_at_ms = ? WHERE user_uuid = ? AND record_id = ?',
      ['{"state":"in_progress"}', 300, 'existing-user', 'movie:imdb:tt0000002']
    );
    await db.exec(
      'DELETE FROM tracker_records WHERE user_uuid = ? AND record_id = ?',
      ['existing-user', 'movie:imdb:tt0000002']
    );
    assert.equal(
      await db.count(
        'SELECT COUNT(*) FROM tracker_record_changes WHERE user_uuid = ? AND record_id = ?',
        ['existing-user', 'movie:imdb:tt0000002']
      ),
      3,
      'insert, update, and delete all append durable bridge changes'
    );
    assert.deepEqual(
      await db.maybeOne(
        `SELECT change_type, record_json FROM tracker_record_changes
         WHERE user_uuid = ? AND record_id = ? ORDER BY change_id DESC LIMIT 1`,
        ['existing-user', 'movie:imdb:tt0000002']
      ),
      { change_type: 'delete', record_json: '{"state":"in_progress"}' },
      'physical deletes retain the last record payload so the bridge can clear the corresponding facet'
    );
  } finally {
    await db.close();
  }
});

test('recognizes an upstream anime migration recorded at its original ID', async () => {
  const db = new SqliteDriver(':memory:');
  try {
    await db.exec(
      'CREATE TABLE _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)'
    );
    for (const migration of MIGRATIONS.filter(({ id }) => id <= 19)) {
      await applyMigration(db, migration);
    }
    const anime = MIGRATIONS.find(
      (migration) => migration.name === 'anime_database'
    );
    assert.ok(anime);
    await applyMigration(db, anime, 20);

    await runMigrations(db);
    const { applied, pending } = await getMigrationStatus(db);
    assert.equal(pending.length, 0);
    assert.ok(applied.some((migration) => migration.name === 'anime_database'));
    assert.equal(
      await db.maybeOne('SELECT id FROM _migrations WHERE id = 900012'),
      null
    );
  } finally {
    await db.close();
  }
});
