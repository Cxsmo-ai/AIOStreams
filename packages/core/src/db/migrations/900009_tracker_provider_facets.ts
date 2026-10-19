import type { Migration } from './types.js';

/** Remember successfully acquired facets of a partially available snapshot. */
export const trackerProviderFacets: Migration = {
  id: 900009,
  name: 'tracker_provider_facets',
  up: {
    sqlite: `
      CREATE TABLE IF NOT EXISTS tracker_provider_facets (
        user_uuid TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        facet_id TEXT NOT NULL,
        completed_at_ms BIGINT NOT NULL,
        PRIMARY KEY (user_uuid, provider_id, facet_id),
        FOREIGN KEY (user_uuid) REFERENCES users(uuid) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_tracker_provider_facets_user_provider
        ON tracker_provider_facets (user_uuid, provider_id);
    `,
    postgres: `
      CREATE TABLE IF NOT EXISTS tracker_provider_facets (
        user_uuid TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        facet_id TEXT NOT NULL,
        completed_at_ms BIGINT NOT NULL,
        PRIMARY KEY (user_uuid, provider_id, facet_id),
        FOREIGN KEY (user_uuid) REFERENCES users(uuid) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_tracker_provider_facets_user_provider
        ON tracker_provider_facets (user_uuid, provider_id);
    `,
  },
};
