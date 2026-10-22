import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteDriver } from '../driver/sqlite.js';
import { trackerProviderOutbox } from './900008_tracker_provider_outbox.js';
import { trackerOutboxGeneration } from './900042_tracker_outbox_generation.js';

test('generation migration drops unowned legacy queue rows and adds link fences', async () => {
  const db = new SqliteDriver(':memory:');
  try {
    await db.exec('CREATE TABLE users (uuid TEXT PRIMARY KEY)');
    await db.exec("INSERT INTO users (uuid) VALUES ('user-a')");
    for (const migration of [trackerProviderOutbox, trackerOutboxGeneration]) {
      for (const statement of migration.up.sqlite
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)) {
        if (migration === trackerOutboxGeneration) {
          if (statement.startsWith('--')) {
            const sql = statement
              .split('\n')
              .filter((line) => !line.trimStart().startsWith('--'))
              .join('\n')
              .trim();
            if (sql) await db.exec(sql);
          } else {
            await db.exec(statement);
          }
        } else {
          await db.exec(statement);
        }
      }
      if (migration === trackerProviderOutbox) {
        await db.exec(
          `INSERT INTO tracker_provider_outbox
            (user_uuid, provider_id, record_id, record_json, updated_at_ms, created_at_ms)
           VALUES ('user-a', 'floppy', 'movie:legacy', '{}', 1, 1)`
        );
        await db.exec(
          `INSERT INTO tracker_scrobble_outbox
            (user_uuid, provider_id, event_id, event_json, created_at_ms)
           VALUES ('user-a', 'floppy', 'legacy-event', '{}', 1)`
        );
      }
    }

    const legacyRows = await db.query<{ total: number }>(
      `SELECT
        (SELECT COUNT(*) FROM tracker_provider_outbox) +
        (SELECT COUNT(*) FROM tracker_scrobble_outbox) AS total`
    );
    assert.equal(Number(legacyRows[0]?.total), 0);
    const columns = await db.query<{ name: string }>(
      "SELECT name FROM pragma_table_info('tracker_provider_outbox') WHERE name = 'link_generation'"
    );
    assert.equal(columns.length, 1);
  } finally {
    await db.close();
  }
});
