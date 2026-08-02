import type { Migration } from './types.js';

/** Monthly reservation ledger for TorrentClaw-originated native NZB playback. */
export const torrentclawNzbQuota: Migration = {
  // 17 is occupied by the legacy vpn_management marker on the live fork.
  id: 18,
  name: 'torrentclaw_nzb_quota',
  up: {
    sqlite: `
      CREATE TABLE IF NOT EXISTS torrentclaw_nzb_quota (
        period TEXT PRIMARY KEY,
        reserved_bytes INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER NOT NULL
      );
    `,
    postgres: `
      CREATE TABLE IF NOT EXISTS torrentclaw_nzb_quota (
        period TEXT PRIMARY KEY,
        reserved_bytes BIGINT NOT NULL DEFAULT 0,
        updated_at_ms BIGINT NOT NULL
      );
    `,
  },
};
