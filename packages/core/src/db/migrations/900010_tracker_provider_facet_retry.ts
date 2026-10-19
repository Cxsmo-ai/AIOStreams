import type { Migration } from './types.js';

/** Backoff metadata for snapshot facets that are unavailable at the provider. */
export const trackerProviderFacetRetry: Migration = {
  id: 900010,
  name: 'tracker_provider_facet_retry',
  up: {
    sqlite: `
      ALTER TABLE tracker_provider_facets
        ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tracker_provider_facets
        ADD COLUMN next_attempt_at_ms BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE tracker_provider_facets
        ADD COLUMN last_failure_reason TEXT;
      ALTER TABLE tracker_provider_facets
        ADD COLUMN endpoint TEXT;
    `,
    postgres: `
      ALTER TABLE tracker_provider_facets
        ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tracker_provider_facets
        ADD COLUMN IF NOT EXISTS next_attempt_at_ms BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE tracker_provider_facets
        ADD COLUMN IF NOT EXISTS last_failure_reason TEXT;
      ALTER TABLE tracker_provider_facets
        ADD COLUMN IF NOT EXISTS endpoint TEXT;
    `,
  },
};
