import type { Migration } from './types.js';

/** Durable retries for canonical tracker writes that could not reach a provider. */
export const trackerProviderOutbox: Migration = {
  id: 900008,
  name: 'tracker_provider_outbox',
  up: {
    sqlite: `
      CREATE TABLE IF NOT EXISTS tracker_provider_outbox (
        user_uuid TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        record_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at_ms BIGINT NOT NULL DEFAULT 0,
        lease_token TEXT,
        lease_until_ms BIGINT NOT NULL DEFAULT 0,
        created_at_ms BIGINT NOT NULL,
        last_error_code TEXT,
        PRIMARY KEY (user_uuid, provider_id, record_id),
        FOREIGN KEY (user_uuid) REFERENCES users(uuid) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_tracker_provider_outbox_due
        ON tracker_provider_outbox (user_uuid, provider_id, next_attempt_at_ms, updated_at_ms);
      CREATE TABLE IF NOT EXISTS tracker_scrobble_outbox (
        user_uuid TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_json TEXT NOT NULL,
        delivery_status TEXT NOT NULL DEFAULT 'pending',
        created_at_ms BIGINT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at_ms BIGINT NOT NULL DEFAULT 0,
        lease_token TEXT,
        lease_until_ms BIGINT NOT NULL DEFAULT 0,
        last_error_code TEXT,
        PRIMARY KEY (user_uuid, provider_id, event_id),
        FOREIGN KEY (user_uuid) REFERENCES users(uuid) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_tracker_scrobble_outbox_due
        ON tracker_scrobble_outbox (user_uuid, provider_id, delivery_status, next_attempt_at_ms, created_at_ms);
    `,
    postgres: `
      CREATE TABLE IF NOT EXISTS tracker_provider_outbox (
        user_uuid TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        record_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at_ms BIGINT NOT NULL DEFAULT 0,
        lease_token TEXT,
        lease_until_ms BIGINT NOT NULL DEFAULT 0,
        created_at_ms BIGINT NOT NULL,
        last_error_code TEXT,
        PRIMARY KEY (user_uuid, provider_id, record_id),
        FOREIGN KEY (user_uuid) REFERENCES users(uuid) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_tracker_provider_outbox_due
        ON tracker_provider_outbox (user_uuid, provider_id, next_attempt_at_ms, updated_at_ms);
      CREATE TABLE IF NOT EXISTS tracker_scrobble_outbox (
        user_uuid TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_json TEXT NOT NULL,
        delivery_status TEXT NOT NULL DEFAULT 'pending',
        created_at_ms BIGINT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at_ms BIGINT NOT NULL DEFAULT 0,
        lease_token TEXT,
        lease_until_ms BIGINT NOT NULL DEFAULT 0,
        last_error_code TEXT,
        PRIMARY KEY (user_uuid, provider_id, event_id),
        FOREIGN KEY (user_uuid) REFERENCES users(uuid) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_tracker_scrobble_outbox_due
        ON tracker_scrobble_outbox (user_uuid, provider_id, delivery_status, next_attempt_at_ms, created_at_ms);
    `,
  },
};
