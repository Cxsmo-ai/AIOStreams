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
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.deepEqual(ids.slice(0, 19), Array.from({ length: 19 }, (_, i) => i + 1));
  assert.deepEqual(
    ids.slice(-28),
    Array.from({ length: 28 }, (_, i) => 900012 + i)
  );
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

    await runMigrations(db);
    const { applied, pending } = await getMigrationStatus(db);
    assert.equal(pending.length, 0);
    assert.ok(applied.some((migration) => migration.name === 'anime_database'));
    assert.equal(
      await db.maybeOne('SELECT id FROM _migrations WHERE id = 900012'),
      null
    );
    assert.equal(
      (await db.maybeOne<{ id: number }>(
        'SELECT id FROM _migrations WHERE name = ?',
        ['anime_database']
      ))?.id,
      900012
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
    const anime = MIGRATIONS.find((migration) => migration.name === 'anime_database');
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
