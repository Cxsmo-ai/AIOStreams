import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteDriver } from '../driver/sqlite.js';
import { trackerProviderOutbox } from './900008_tracker_provider_outbox.js';

test('creates durable record and live-scrobble outboxes with retry indexes', async () => {
  const db = new SqliteDriver(':memory:');
  try {
    await db.exec('CREATE TABLE users (uuid TEXT PRIMARY KEY)');
    for (const statement of trackerProviderOutbox.up.sqlite
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)) {
      await db.exec(statement);
    }

    const indexes = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (?, ?) ORDER BY name",
      ['idx_tracker_provider_outbox_due', 'idx_tracker_scrobble_outbox_due']
    );
    assert.deepEqual(
      indexes.map(({ name }) => name),
      ['idx_tracker_provider_outbox_due', 'idx_tracker_scrobble_outbox_due']
    );

    await db.exec('INSERT INTO users (uuid) VALUES (?)', ['user-a']);
    await db.exec(
      `INSERT INTO tracker_provider_outbox
        (user_uuid, provider_id, record_id, record_json, updated_at_ms, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['user-a', 'wetrakr', 'movie:test', '{"state":"watched"}', 100, 100]
    );
    await db.exec(
      `INSERT INTO tracker_scrobble_outbox
        (user_uuid, provider_id, event_id, event_json, created_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
      ['user-a', 'wetrakr', 'event-a', '{"action":"pause"}', 100]
    );
    const rows = await db.query<{
      delivery_status: string;
      attempt_count: number;
      next_attempt_at_ms: number;
    }>(
      'SELECT delivery_status, attempt_count, next_attempt_at_ms FROM tracker_scrobble_outbox WHERE user_uuid = ? AND event_id = ?',
      ['user-a', 'event-a']
    );
    assert.deepEqual(rows, [
      { delivery_status: 'pending', attempt_count: 0, next_attempt_at_ms: 0 },
    ]);
    await db.exec('DELETE FROM users WHERE uuid = ?', ['user-a']);
    const orphaned = await db.query<{ records: number; scrobbles: number }>(
      `SELECT
        (SELECT COUNT(*) FROM tracker_provider_outbox) AS records,
        (SELECT COUNT(*) FROM tracker_scrobble_outbox) AS scrobbles`
    );
    assert.deepEqual(
      {
        records: Number(orphaned[0]?.records),
        scrobbles: Number(orphaned[0]?.scrobbles),
      },
      { records: 0, scrobbles: 0 }
    );
  } finally {
    await db.close();
  }
});
