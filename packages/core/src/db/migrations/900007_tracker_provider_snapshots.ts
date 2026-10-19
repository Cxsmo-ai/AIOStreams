import type { Migration } from './types.js';

/** Last complete view observed from each snapshot-only tracker provider. */
export const trackerProviderSnapshots: Migration = {
  id: 900007,
  name: 'tracker_provider_snapshots',
  up: {
    sqlite: `
      CREATE TABLE IF NOT EXISTS tracker_provider_records (
        user_uuid TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        record_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        PRIMARY KEY (user_uuid, provider_id, record_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tracker_provider_records_user_provider
        ON tracker_provider_records (user_uuid, provider_id);
    `,
    postgres: `
      CREATE TABLE IF NOT EXISTS tracker_provider_records (
        user_uuid TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        record_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        PRIMARY KEY (user_uuid, provider_id, record_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tracker_provider_records_user_provider
        ON tracker_provider_records (user_uuid, provider_id);
    `,
  },
};
