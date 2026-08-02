import type { Migration } from './types.js';

/**
 * Hourly per-indexer grab rollups for the native usenet engine. One row per
 * (hour, indexer) accumulates concluded NZB grab attempts so the dashboard can
 * show per-indexer grab volume, success rate and timings. Rollups only — never
 * raw per-grab events; derived metrics (success rate, averages, share) are
 * computed at query time.
 *
 *   ok / degraded / failed   import-time outcome counts (grabs = their sum)
 *   failed_missing           subset of failed: articles dead on providers
 *   failed_fetch             subset of failed: .nzb download from indexer failed
 *   fetch_auth               subset of failed_fetch: HTTP 401/403
 *   fetch_limited            subset of failed_fetch: HTTP 429
 *   sum_grab_ms              .nzb download time (avg = /grab_samples)
 *   sum_import_ms            inspect/import time (avg = /import_samples)
 *
 * `usenet_indexer_last_error` keeps the most recent grab-fetch error per
 * indexer (one overwritten row each).
 */
export const usenetIndexerMetrics: Migration = {
  id: 16,
  name: 'usenet_indexer_metrics',
  up: {
    sqlite: `
      CREATE TABLE IF NOT EXISTS usenet_indexer_metrics (
        hour_ms INTEGER NOT NULL,
        indexer TEXT NOT NULL,
        ok INTEGER NOT NULL DEFAULT 0,
        degraded INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        failed_missing INTEGER NOT NULL DEFAULT 0,
        failed_fetch INTEGER NOT NULL DEFAULT 0,
        fetch_auth INTEGER NOT NULL DEFAULT 0,
        fetch_limited INTEGER NOT NULL DEFAULT 0,
        sum_grab_ms INTEGER NOT NULL DEFAULT 0,
        grab_samples INTEGER NOT NULL DEFAULT 0,
        sum_import_ms INTEGER NOT NULL DEFAULT 0,
        import_samples INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (hour_ms, indexer)
      );

      CREATE INDEX IF NOT EXISTS idx_usenet_indexer_metrics_hour
        ON usenet_indexer_metrics (hour_ms);

      CREATE TABLE IF NOT EXISTS usenet_indexer_last_error (
        indexer TEXT PRIMARY KEY,
        status INTEGER,
        message TEXT NOT NULL,
        at_ms INTEGER NOT NULL
      );
    `,
    postgres: `
      CREATE TABLE IF NOT EXISTS usenet_indexer_metrics (
        hour_ms BIGINT NOT NULL,
        indexer TEXT NOT NULL,
        ok BIGINT NOT NULL DEFAULT 0,
        degraded BIGINT NOT NULL DEFAULT 0,
        failed BIGINT NOT NULL DEFAULT 0,
        failed_missing BIGINT NOT NULL DEFAULT 0,
        failed_fetch BIGINT NOT NULL DEFAULT 0,
        fetch_auth BIGINT NOT NULL DEFAULT 0,
        fetch_limited BIGINT NOT NULL DEFAULT 0,
        sum_grab_ms BIGINT NOT NULL DEFAULT 0,
        grab_samples BIGINT NOT NULL DEFAULT 0,
        sum_import_ms BIGINT NOT NULL DEFAULT 0,
        import_samples BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (hour_ms, indexer)
      );

      CREATE INDEX IF NOT EXISTS idx_usenet_indexer_metrics_hour
        ON usenet_indexer_metrics (hour_ms);

      CREATE TABLE IF NOT EXISTS usenet_indexer_last_error (
        indexer TEXT PRIMARY KEY,
        status INTEGER,
        message TEXT NOT NULL,
        at_ms BIGINT NOT NULL
      );
    `,
  },
};
