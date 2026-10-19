import { createHash, randomUUID } from 'node:crypto';
import type { DbDriver } from '../db/driver/types.js';

/** Stay below WeTrakr's published development-key ceilings. */
export const WETRAKR_QUOTA = {
  requestsPer24Hours: 900,
  getsPerMinute: 180,
  writesPerMinute: 50,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const MIN_RETRY_MS = 1_000;

export type WeTrakrRequestKind = 'get' | 'write';

export type WeTrakrQuotaDecision = {
  allowed: boolean;
  retryAfterMs?: number;
  reason?: 'daily' | 'get_minute' | 'write_minute';
};

/**
 * Atomically reserve one request against a shared application-key budget.
 * Only a SHA-256 digest of the client ID is persisted; never the key/secret.
 * SQLite's single connection serializes transactions, and Postgres locks the
 * stable per-key row so parallel profile requests cannot oversubscribe it.
 */
export async function reserveWeTrakrRequest(
  clientId: string,
  kind: WeTrakrRequestKind,
  options: { now?: number; database?: DbDriver } = {}
): Promise<WeTrakrQuotaDecision> {
  const now = options.now ?? Date.now();
  let db: DbDriver;
  if (options.database) db = options.database;
  else {
    const { getDb } = await import('../db/db.js');
    db = getDb();
  }
  const keyHash = createHash('sha256').update(clientId).digest('hex');

  return db.tx(async (tx) => {
    await tx.exec(
      'INSERT INTO wetrakr_quota_clients (client_hash) VALUES (?) ON CONFLICT(client_hash) DO NOTHING',
      [keyHash]
    );
    await tx.query(
      `SELECT client_hash FROM wetrakr_quota_clients WHERE client_hash = ?${tx.dialect === 'postgres' ? ' FOR UPDATE' : ''}`,
      [keyHash]
    );
    await tx.exec(
      'DELETE FROM wetrakr_quota_requests WHERE requested_at_ms < ?',
      [now - DAY_MS]
    );

    const dailyCount = await tx.count(
      'SELECT COUNT(*) AS count FROM wetrakr_quota_requests WHERE client_hash = ? AND requested_at_ms >= ?',
      [keyHash, now - DAY_MS]
    );
    if (dailyCount >= WETRAKR_QUOTA.requestsPer24Hours) {
      const oldest = await tx.maybeOne<{ requested_at_ms: number | string }>(
        'SELECT MIN(requested_at_ms) AS requested_at_ms FROM wetrakr_quota_requests WHERE client_hash = ? AND requested_at_ms >= ?',
        [keyHash, now - DAY_MS]
      );
      return {
        allowed: false,
        reason: 'daily',
        retryAfterMs: Math.max(
          MIN_RETRY_MS,
          Number(oldest?.requested_at_ms ?? now) + DAY_MS - now
        ),
      };
    }

    const minuteCount = await tx.count(
      'SELECT COUNT(*) AS count FROM wetrakr_quota_requests WHERE client_hash = ? AND request_kind = ? AND requested_at_ms >= ?',
      [keyHash, kind, now - MINUTE_MS]
    );
    const minuteLimit =
      kind === 'get'
        ? WETRAKR_QUOTA.getsPerMinute
        : WETRAKR_QUOTA.writesPerMinute;
    if (minuteCount >= minuteLimit) {
      const oldest = await tx.maybeOne<{ requested_at_ms: number | string }>(
        'SELECT MIN(requested_at_ms) AS requested_at_ms FROM wetrakr_quota_requests WHERE client_hash = ? AND request_kind = ? AND requested_at_ms >= ?',
        [keyHash, kind, now - MINUTE_MS]
      );
      return {
        allowed: false,
        reason: kind === 'get' ? 'get_minute' : 'write_minute',
        retryAfterMs: Math.max(
          MIN_RETRY_MS,
          Number(oldest?.requested_at_ms ?? now) + MINUTE_MS - now
        ),
      };
    }

    await tx.exec(
      'INSERT INTO wetrakr_quota_requests (request_id, client_hash, requested_at_ms, request_kind) VALUES (?, ?, ?, ?)',
      [randomUUID(), keyHash, now, kind]
    );
    return { allowed: true };
  });
}
