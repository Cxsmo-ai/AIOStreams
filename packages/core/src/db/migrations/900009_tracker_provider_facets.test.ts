import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteDriver } from '../driver/sqlite.js';
import { trackerProviderFacets } from './900009_tracker_provider_facets.js';

test('stores successful account facets independently and cascades on user deletion', async () => {
  const db = new SqliteDriver(':memory:');
  try {
    await db.exec('CREATE TABLE users (uuid TEXT PRIMARY KEY)');
    for (const statement of trackerProviderFacets.up.sqlite
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)) {
      await db.exec(statement);
    }
    await db.exec('INSERT INTO users (uuid) VALUES (?)', ['user-a']);
    await db.exec(
      'INSERT INTO tracker_provider_facets (user_uuid, provider_id, facet_id, completed_at_ms) VALUES (?, ?, ?, ?)',
      ['user-a', 'wetrakr', 'sync_tracking_watched_history_episodes', 123]
    );
    const saved = await db.query<{
      facet_id: string;
      completed_at_ms: number;
    }>(
      'SELECT facet_id, completed_at_ms FROM tracker_provider_facets WHERE user_uuid = ? AND provider_id = ?',
      ['user-a', 'wetrakr']
    );
    assert.deepEqual(saved, [
      {
        facet_id: 'sync_tracking_watched_history_episodes',
        completed_at_ms: 123,
      },
    ]);

    await db.exec('DELETE FROM users WHERE uuid = ?', ['user-a']);
    const orphaned = await db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM tracker_provider_facets'
    );
    assert.equal(Number(orphaned[0]?.count), 0);
  } finally {
    await db.close();
  }
});
