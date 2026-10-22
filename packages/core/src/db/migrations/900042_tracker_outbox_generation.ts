import type { Migration } from './types.js';

/** Bind durable provider work to the credential-link generation that created it. */
export const trackerOutboxGeneration: Migration = {
  id: 900042,
  name: 'tracker_outbox_generation',
  up: {
    sqlite: `
      ALTER TABLE tracker_provider_outbox ADD COLUMN link_generation BIGINT;
      ALTER TABLE tracker_scrobble_outbox ADD COLUMN link_generation BIGINT;
      -- Pre-generation rows cannot be attributed to a credential link safely.
      -- Fail closed instead of allowing legacy work to block or leak across relinks.
      DELETE FROM tracker_provider_outbox WHERE link_generation IS NULL;
      DELETE FROM tracker_scrobble_outbox WHERE link_generation IS NULL;
      CREATE INDEX IF NOT EXISTS idx_tracker_provider_outbox_generation
        ON tracker_provider_outbox (user_uuid, provider_id, link_generation);
      CREATE INDEX IF NOT EXISTS idx_tracker_scrobble_outbox_generation
        ON tracker_scrobble_outbox (user_uuid, provider_id, link_generation);
    `,
    postgres: `
      ALTER TABLE tracker_provider_outbox ADD COLUMN IF NOT EXISTS link_generation BIGINT;
      ALTER TABLE tracker_scrobble_outbox ADD COLUMN IF NOT EXISTS link_generation BIGINT;
      -- Pre-generation rows cannot be attributed to a credential link safely.
      -- Fail closed instead of allowing legacy work to block or leak across relinks.
      DELETE FROM tracker_provider_outbox WHERE link_generation IS NULL;
      DELETE FROM tracker_scrobble_outbox WHERE link_generation IS NULL;
      CREATE INDEX IF NOT EXISTS idx_tracker_provider_outbox_generation
        ON tracker_provider_outbox (user_uuid, provider_id, link_generation);
      CREATE INDEX IF NOT EXISTS idx_tracker_scrobble_outbox_generation
        ON tracker_scrobble_outbox (user_uuid, provider_id, link_generation);
    `,
  },
};
