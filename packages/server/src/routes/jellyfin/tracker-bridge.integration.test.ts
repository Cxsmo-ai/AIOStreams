import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TrackerRecordSchema,
  WatchStateRepository,
  type WatchScope,
} from '@aiostreams/core';
import { SqliteDriver } from '../../../../core/dist/db/driver/sqlite.js';
import { runMigrations } from '../../../../core/src/db/migrations/runner.js';
import { syncTrackerRecordsToWatchState } from './tracker-bridge.js';

const scope: WatchScope = { uuid: 'bridge-integration-user', persona: '' };

async function storeRecord(
  db: SqliteDriver,
  id: string,
  record: unknown,
  updatedAt: number
) {
  await db.exec(
    `INSERT INTO tracker_records (user_uuid, record_id, record_json, updated_at_ms)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_uuid, record_id) DO UPDATE SET
       record_json = excluded.record_json, updated_at_ms = excluded.updated_at_ms`,
    [scope.uuid, id, JSON.stringify(record), updatedAt]
  );
}

test('tracker bridge applies facets, protects local state, handles deletes and quarantines invalid rows', async () => {
  const db = new SqliteDriver(':memory:');
  try {
    await runMigrations(db);
    await db.exec(
      'INSERT INTO users (uuid, password_hash, config, config_salt) VALUES (?, ?, ?, ?)',
      [scope.uuid, 'test-hash', '{}', 'test-salt']
    );
    const watched = TrackerRecordSchema.parse({
      id: 'movie:imdb:tt1000001',
      kind: 'movie',
      ids: { imdb: 'tt1000001' },
      title: 'Bridge Watched',
      state: 'watched',
      updatedAt: 100,
      origin: 'test-provider',
    });
    const rating = TrackerRecordSchema.parse({
      id: 'movie:imdb:tt1000002|rating',
      kind: 'movie',
      ids: { imdb: 'tt1000002' },
      title: 'Bridge Rating',
      state: 'rated',
      rating: 8,
      updatedAt: 200,
      origin: 'test-provider',
    });
    await storeRecord(db, watched.id, watched, 110);
    await storeRecord(db, rating.id, rating, 210);

    const first = await syncTrackerRecordsToWatchState(scope, db);
    assert.equal(first.imported, 2);
    const importedMovie = await db.maybeOne<{ played: number; last_played_at: number }>(
      'SELECT played, last_played_at FROM watch_state WHERE uuid = ? AND item_key = ?',
      [scope.uuid, 'm|tt1000001']
    );
    assert.deepEqual(importedMovie, { played: 1, last_played_at: 100 });

    const ratingIdentity = {
      itemKey: 'm|tt1000002',
      kind: 'movie' as const,
      mediaType: 'movie' as const,
      baseId: 'tt1000002',
    };
    await WatchStateRepository.upsert(scope, ratingIdentity, {
      rating: 4,
      origin: 'local',
    }, db);
    const olderExternalRating = TrackerRecordSchema.parse({
      ...rating,
      rating: 9,
      updatedAt: Date.now() - 60_000,
    });
    await storeRecord(db, rating.id, olderExternalRating, Date.now());
    await syncTrackerRecordsToWatchState(scope, db);
    assert.equal(
      (await db.maybeOne<{ rating: number }>(
        'SELECT rating FROM watch_state WHERE uuid = ? AND item_key = ?',
        [scope.uuid, ratingIdentity.itemKey]
      ))?.rating,
      4,
      'an older remote tracker value cannot overwrite a newer local rating'
    );

    await db.exec(
      'DELETE FROM tracker_records WHERE user_uuid = ? AND record_id = ?',
      [scope.uuid, watched.id]
    );
    await syncTrackerRecordsToWatchState(scope, db);
    assert.equal(
      (await db.maybeOne<{ played: number }>(
        'SELECT played FROM watch_state WHERE uuid = ? AND item_key = ?',
        [scope.uuid, 'm|tt1000001']
      ))?.played,
      0,
      'physical deletion clears only the tracker-owned playback facet'
    );

    await storeRecord(db, 'invalid-row', '{not json', 300);
    const invalid = await syncTrackerRecordsToWatchState(scope, db);
    assert.equal(invalid.skipped, 1);
    assert.equal(
      await db.count(
        'SELECT COUNT(*) FROM jellyfin_tracker_bridge_rejections WHERE user_uuid = ? AND record_id = ?',
        [scope.uuid, 'invalid-row']
      ),
      1,
      'invalid rows are durably quarantined before the feed cursor advances'
    );
  } finally {
    await db.close();
  }
});
