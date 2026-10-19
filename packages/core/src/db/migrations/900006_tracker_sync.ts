import type { Migration } from './types.js';

/** Per-AIOStreams-user canonical tracker state; data is scoped by UUID and has no global visibility. */
export const trackerSync: Migration = {
  id: 900006,
  name: 'tracker_sync',
  up: {
    sqlite: `
      CREATE TABLE IF NOT EXISTS tracker_records (
        user_uuid TEXT NOT NULL,
        record_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        PRIMARY KEY (user_uuid, record_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tracker_records_cursor
        ON tracker_records (user_uuid, updated_at_ms, record_id);
      CREATE TABLE IF NOT EXISTS tracker_provider_sync_state (
        user_uuid TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        checkpoint_at_ms BIGINT NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        PRIMARY KEY (user_uuid, provider_id)
      );
    `,
    postgres: `
      CREATE TABLE IF NOT EXISTS tracker_records (
        user_uuid TEXT NOT NULL,
        record_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        PRIMARY KEY (user_uuid, record_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tracker_records_cursor
        ON tracker_records (user_uuid, updated_at_ms, record_id);
      CREATE TABLE IF NOT EXISTS tracker_provider_sync_state (
        user_uuid TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        checkpoint_at_ms BIGINT NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        PRIMARY KEY (user_uuid, provider_id)
      );
    `,
  },
};
