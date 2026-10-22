import type { Migration } from './types.js';

/** Active opaque authRef and monotonically increasing generation per config/provider. */
export const trackerProviderLinkState: Migration = {
  id: 900041,
  name: 'tracker_provider_link_state',
  up: {
    sqlite: `
      CREATE TABLE IF NOT EXISTS tracker_provider_link_state (
        user_uuid TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        auth_ref TEXT,
        generation BIGINT NOT NULL DEFAULT 1,
        updated_at_ms BIGINT NOT NULL,
        PRIMARY KEY (user_uuid, provider_id),
        FOREIGN KEY (user_uuid) REFERENCES users(uuid) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_tracker_provider_link_state_reference
        ON tracker_provider_link_state (provider_id, auth_ref);
    `,
    postgres: `
      CREATE TABLE IF NOT EXISTS tracker_provider_link_state (
        user_uuid TEXT NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        auth_ref TEXT,
        generation BIGINT NOT NULL DEFAULT 1,
        updated_at_ms BIGINT NOT NULL,
        PRIMARY KEY (user_uuid, provider_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tracker_provider_link_state_reference
        ON tracker_provider_link_state (provider_id, auth_ref);
    `,
  },
};
