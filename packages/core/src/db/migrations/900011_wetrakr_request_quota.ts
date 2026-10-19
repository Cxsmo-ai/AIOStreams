import type { Migration } from './types.js';

/** Shared, restart-safe WeTrakr request budget across all linked profiles. */
export const wetrakrRequestQuota: Migration = {
  id: 900011,
  name: 'wetrakr_request_quota',
  up: {
    sqlite: `
      CREATE TABLE IF NOT EXISTS wetrakr_quota_clients (
        client_hash TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS wetrakr_quota_requests (
        request_id TEXT PRIMARY KEY,
        client_hash TEXT NOT NULL,
        requested_at_ms BIGINT NOT NULL,
        request_kind TEXT NOT NULL CHECK (request_kind IN ('get', 'write')),
        FOREIGN KEY (client_hash) REFERENCES wetrakr_quota_clients(client_hash) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_wetrakr_quota_window
        ON wetrakr_quota_requests (client_hash, requested_at_ms, request_kind);
      CREATE INDEX IF NOT EXISTS idx_wetrakr_quota_expiry
        ON wetrakr_quota_requests (requested_at_ms);
    `,
    postgres: `
      CREATE TABLE IF NOT EXISTS wetrakr_quota_clients (
        client_hash TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS wetrakr_quota_requests (
        request_id TEXT PRIMARY KEY,
        client_hash TEXT NOT NULL REFERENCES wetrakr_quota_clients(client_hash) ON DELETE CASCADE,
        requested_at_ms BIGINT NOT NULL,
        request_kind TEXT NOT NULL CHECK (request_kind IN ('get', 'write'))
      );
      CREATE INDEX IF NOT EXISTS idx_wetrakr_quota_window
        ON wetrakr_quota_requests (client_hash, requested_at_ms, request_kind);
      CREATE INDEX IF NOT EXISTS idx_wetrakr_quota_expiry
        ON wetrakr_quota_requests (requested_at_ms);
    `,
  },
};
