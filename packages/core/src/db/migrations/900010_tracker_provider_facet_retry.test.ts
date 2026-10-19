import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteDriver } from '../driver/sqlite.js';
import { trackerProviderFacets } from './900009_tracker_provider_facets.js';
import { trackerProviderFacetRetry } from './900010_tracker_provider_facet_retry.js';

test('persists safe retry cooldown state per incomplete provider facet', async () => {
  const db = new SqliteDriver(':memory:');
  try {
    await db.exec('CREATE TABLE users (uuid TEXT PRIMARY KEY)');
    for (const migration of [trackerProviderFacets, trackerProviderFacetRetry]) {
      for (const statement of migration.up.sqlite
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)) {
        await db.exec(statement);
      }
    }
    await db.exec('INSERT INTO users (uuid) VALUES (?)', ['user-a']);
    const retryAt = Date.now() + 60_000;
    await db.exec(
      'INSERT INTO tracker_provider_facets (user_uuid, provider_id, facet_id, completed_at_ms, attempt_count, next_attempt_at_ms, last_failure_reason, endpoint) VALUES (?, ?, ?, 0, ?, ?, ?, ?)',
      ['user-a', 'wetrakr', 'likes_all', 1, retryAt, 'upstream_private', 'likes_all']
    );
    const [saved] = await db.query<{
      facet_id: string;
      attempt_count: number;
      next_attempt_at_ms: number;
      last_failure_reason: string;
      endpoint: string;
    }>(
      'SELECT facet_id, attempt_count, next_attempt_at_ms, last_failure_reason, endpoint FROM tracker_provider_facets WHERE user_uuid = ? AND provider_id = ?',
      ['user-a', 'wetrakr']
    );
    assert.deepEqual(saved, {
      facet_id: 'likes_all',
      attempt_count: 1,
      next_attempt_at_ms: retryAt,
      last_failure_reason: 'upstream_private',
      endpoint: 'likes_all',
    });
  } finally {
    await db.close();
  }
});
