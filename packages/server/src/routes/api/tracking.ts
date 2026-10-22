import { randomUUID } from 'node:crypto';
import { Router, type Request, type RequestHandler } from 'express';
import {
  APIError,
  constants,
  UserRepository,
  getDb,
  TrackerBatchSchema,
  TrackerRecordSchema,
  type TrackerRecord,
  makeTrackerCursor,
  makeTrackerTombstone,
  parseTrackerCursor,
  requestWeTrakrApi,
  requestFloppyApi,
  getTrackerProviderLinkState,
  initializeTrackerProviderLinkStates,
  isCurrentTrackerProviderLink,
  withTrackerProviderLinkLock,
  WeTrakrRateLimitError,
  type DbDriver,
} from '@aiostreams/core';
import { userApiRateLimiter } from '../../middlewares/ratelimit.js';
import { parseBasicAuthHeader } from '../../utils/basic-auth.js';
import { createResponse } from '../../utils/responses.js';
import {
  defaultTrackerProviderAdapters,
  type TrackerProviderAdapter,
  type TrackerProviderApiRequest,
  type TrackerProviderLink,
  type TrackerProviderSnapshot,
  type TrackerScrobbleEvent,
} from './tracker-providers.js';

export interface TrackerRouterDependencies {
  authenticate: (
    uuid: string,
    password: string
  ) => Promise<
    boolean | { trackerProviders?: Record<string, TrackerProviderLink> } | null
  >;
  database: () => DbDriver;
  requestProviderApi?: TrackerProviderApiRequest;
  trackerAdapters?: TrackerProviderAdapter[];
  rateLimiter?: RequestHandler;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)])
    );
  }
  return value;
}

/** Ignore provider timestamps/provenance when detecting an echoed value. */
function sameTrackerValue(
  left: ReturnType<typeof TrackerRecordSchema.parse>,
  right: ReturnType<typeof TrackerRecordSchema.parse>
): boolean {
  const {
    updatedAt: _leftTime,
    origin: _leftOrigin,
    revision: _leftRevision,
    ...leftValue
  } = left;
  const {
    updatedAt: _rightTime,
    origin: _rightOrigin,
    revision: _rightRevision,
    ...rightValue
  } = right;
  return (
    JSON.stringify(stableValue(leftValue)) ===
      JSON.stringify(stableValue(rightValue)) &&
    // For watch records updatedAt is the semantic play/completion date, not
    // merely a provider's modification timestamp. Ignoring it made corrected
    // dates invisible to the snapshot diff and downstream trackers.
    (!['watched', 'play'].includes(left.state) ||
      !['watched', 'play'].includes(right.state) ||
      left.updatedAt === right.updatedAt)
  );
}

type TrackerRefreshFailure = {
  providerId: string;
  stage: 'pull' | 'queue_write' | 'write' | 'scrobble' | 'checkpoint';
  reason: string;
  endpoint?: string;
};

const SAFE_TRACKER_ENDPOINTS = new Set([
  'sync_tracking_watching_all',
  'sync_tracking_playing_all',
  'sync_tracking_waiting_all',
  'sync_tracking_planning_all',
  'sync_tracking_dropped_all',
  'sync_tracking_paused_all',
  'sync_tracking_watched_all',
  'sync_tracking_watched_history_movies',
  'sync_tracking_watched_history_episodes',
  'sync_ratings_all',
  'sync_favorites_all',
  'likes_all',
  'sync_notes_all',
  'sync_comments_all',
  'sync_lists',
  'sync_lists_items',
  'sync_journal',
  'other',
  'floppy_media_movie',
  'floppy_media_tv',
  'floppy_media_anime',
  'floppy_media_season',
  'floppy_media_episode',
  'floppy_playback_progress',
  'floppy_history',
]);

function trackerRefreshFailureEndpoint(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const endpoint = (error as { endpoint?: unknown }).endpoint;
  return typeof endpoint === 'string' && SAFE_TRACKER_ENDPOINTS.has(endpoint)
    ? endpoint
    : undefined;
}

function trackerOutboxRetry(
  adapter: TrackerProviderAdapter,
  error: unknown,
  attempt: number,
  maximumDelayMs: number
): { delayMs: number; errorCode: string; failureReason: string } {
  if (adapter.id === 'wetrakr' && error instanceof WeTrakrRateLimitError) {
    const delayMs = Math.min(
      24 * 60 * 60 * 1000,
      Math.max(1_000, error.retryAfterMs)
    );
    return {
      delayMs,
      errorCode: 'rate_limited',
      failureReason: 'rate_limited',
    };
  }
  const delayMs = Math.min(
    maximumDelayMs,
    5_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 8)
  );
  return {
    delayMs,
    errorCode: 'provider_unavailable',
    failureReason: 'provider_unavailable',
  };
}

/** Return a coarse error category only; never serialize provider error text. */
function trackerRefreshFailureReason(error: unknown): string {
  if (!error || typeof error !== 'object') return 'provider_error';
  const candidate = error as {
    status?: unknown;
    name?: unknown;
    providerCode?: unknown;
    reason?: unknown;
    errorName?: unknown;
  };
  if (candidate.reason === 'invalid_history_cursor')
    return 'invalid_history_cursor';
  if (candidate.reason === 'history_cursor_limit')
    return 'history_cursor_limit';
  if (candidate.reason === 'pagination_limit') return 'pagination_limit';
  if (candidate.reason === 'response_too_large') return 'response_too_large';
  if (candidate.reason === 'invalid_upstream_response')
    return 'invalid_upstream_response';
  if (candidate.reason === 'upstream_transport_error')
    return 'upstream_transport_error';
  if (
    candidate.errorName === 'AbortError' ||
    candidate.errorName === 'TimeoutError'
  )
    return 'timeout';
  if (candidate.errorName === 'TypeError') return 'upstream_transport_error';
  const status = Number(candidate.status);
  if (status === 403 && candidate.providerCode === 'PRIVATE')
    return 'upstream_private';
  if (status === 403 && candidate.providerCode === 'FRIENDS_ONLY')
    return 'upstream_friends_only';
  if (status === 403 && candidate.providerCode === 'COMMENTS_DISABLED')
    return 'upstream_comments_disabled';
  if (status === 401 || status === 403) return `upstream_http_${status}`;
  if (status === 429) return 'rate_limited';
  if (Number.isInteger(status) && status >= 400 && status <= 499)
    return `upstream_http_${status}`;
  if (Number.isInteger(status) && status >= 500 && status <= 599)
    return 'upstream_unavailable';
  if (candidate.name === 'AbortError' || candidate.name === 'TimeoutError')
    return 'timeout';
  return 'provider_error';
}

/** Convert a provider's complete state into a stable, retryable canonical delta. */
function diffTrackerSnapshot(
  providerId: string,
  snapshot: TrackerRecord[],
  previousRows: Array<{ record_json: string }>
): { records: TrackerRecord[]; observed: TrackerRecord[] } {
  const previous = new Map(
    previousRows.map((row) => {
      const record = TrackerRecordSchema.parse(JSON.parse(row.record_json));
      return [record.id, record] as const;
    })
  );
  const observedById = new Map<string, TrackerRecord>();
  const changes: TrackerRecord[] = [];

  for (const value of snapshot) {
    const parsed = TrackerRecordSchema.parse({ ...value, origin: providerId });
    if (observedById.has(parsed.id))
      throw new Error(
        `Provider ${providerId} returned duplicate tracker record IDs`
      );
    const prior = previous.get(parsed.id);
    let current = parsed;
    if (prior && !sameTrackerValue(prior, parsed)) {
      // Providers that do not expose a reliable modification time still need
      // monotonically ordered updates for deterministic conflict resolution.
      if (current.updatedAt <= prior.updatedAt) {
        current = TrackerRecordSchema.parse({
          ...current,
          updatedAt: prior.updatedAt + 1,
          revision: Math.max(current.revision, prior.revision + 1),
        });
      }
      changes.push(current);
    } else if (!prior) {
      changes.push(current);
    }
    observedById.set(current.id, current);
  }

  for (const [id, prior] of previous) {
    if (!observedById.has(id)) {
      // Use a deterministic timestamp so a failed fan-out produces the same
      // deletion marker on retry instead of generating endless newer deletes.
      changes.push(
        makeTrackerTombstone(prior, providerId, prior.updatedAt + 1)
      );
    }
  }

  return { records: changes, observed: [...observedById.values()] };
}

type TrackerOutboxRow = {
  record_id: string;
  record_json: string;
  updated_at_ms: number | string;
  attempt_count: number | string;
  link_generation: number | string | null;
};

type TrackerScrobbleOutboxRow = {
  event_id: string;
  event_json: string;
  created_at_ms: number | string;
  attempt_count: number | string;
  link_generation: number | string | null;
};

export type LinkedTrackerAdapter = {
  adapter: TrackerProviderAdapter;
  authRef: string;
  generation: number;
};

type ResolvedTrackerAdapter = Omit<LinkedTrackerAdapter, 'generation'>;

/**
 * Persist live playback events before provider fan-out. Stable event IDs make
 * a retry safe for adapters that forward an idempotency key to the provider.
 */
export async function enqueueScrobbleEvents(
  tx: DbDriver,
  userUuid: string,
  adapters: LinkedTrackerAdapter[],
  event: TrackerScrobbleEvent,
  now = Date.now()
): Promise<string[]> {
  const staleProviders: string[] = [];
  for (const { adapter, authRef, generation } of adapters) {
    if (
      !(await isCurrentTrackerProviderLink(
        tx,
        userUuid,
        adapter.id,
        authRef,
        generation,
        true
      ))
    ) {
      staleProviders.push(adapter.id);
      continue;
    }
    // Prune obsolete work only after locking and validating the current link.
    // A worker holding an older generation must never perform this cleanup.
    await tx.exec(
      'DELETE FROM tracker_scrobble_outbox WHERE user_uuid = ? AND provider_id = ? AND (link_generation IS NULL OR link_generation <> ?)',
      [userUuid, adapter.id, generation]
    );
    await tx.exec(
      'INSERT INTO tracker_scrobble_outbox (user_uuid, provider_id, event_id, event_json, created_at_ms, link_generation, attempt_count, next_attempt_at_ms, lease_token, lease_until_ms, last_error_code) VALUES (?, ?, ?, ?, ?, ?, 0, 0, NULL, 0, NULL) ON CONFLICT(user_uuid, provider_id, event_id) DO NOTHING',
      [
        userUuid,
        adapter.id,
        event.eventId,
        JSON.stringify(event),
        now,
        generation,
      ]
    );
  }
  return staleProviders;
}

/**
 * Hold a provider-scoped lock until remote dispatch finishes. PostgreSQL also
 * holds the link row lock for cross-process coordination; SQLite uses the
 * shared in-process lock so network I/O never holds its database-wide writer
 * lock.
 */
async function dispatchForCurrentTrackerLink<T>(
  db: DbDriver,
  userUuid: string,
  providerId: string,
  authRef: string,
  generation: number,
  dispatch: (tx: DbDriver) => Promise<T>
): Promise<{ current: false } | { current: true; value: T }> {
  const dispatchWithCheck = async (
    tx: DbDriver,
    lockForUpdate: boolean
  ): Promise<{ current: false } | { current: true; value: T }> => {
    if (
      !(await isCurrentTrackerProviderLink(
        tx,
        userUuid,
        providerId,
        authRef,
        generation,
        lockForUpdate
      ))
    )
      return { current: false };
    return { current: true, value: await dispatch(tx) };
  };

  if (db.dialect === 'sqlite')
    return withTrackerProviderLinkLock(userUuid, providerId, async () => {
      if (
        !(await isCurrentTrackerProviderLink(
          db,
          userUuid,
          providerId,
          authRef,
          generation
        ))
      )
        return { current: false };
      return { current: true, value: await dispatch(db) };
    });
  return db.tx((tx) => dispatchWithCheck(tx, true));
}

export async function flushScrobbleOutbox(
  db: DbDriver,
  userUuid: string,
  adapters: LinkedTrackerAdapter[],
  providerApiFor: (
    adapter: TrackerProviderAdapter
  ) => TrackerProviderApiRequest,
  now = Date.now(),
  forceRetry = false
): Promise<{
  syncedProviders: string[];
  pendingProviders: string[];
  ignoredProviders: Array<{ providerId: string; reason?: string }>;
}> {
  const syncedProviders: string[] = [];
  const pendingProviders: string[] = [];
  const ignoredProviders: Array<{ providerId: string; reason?: string }> = [];
  for (const { adapter, authRef, generation } of adapters) {
    let linkChanged = false;
    // Retain successful event IDs long enough to suppress ordinary retries,
    // without keeping a permanent playback-history database.
    await db.exec(
      "DELETE FROM tracker_scrobble_outbox WHERE user_uuid = ? AND provider_id = ? AND delivery_status = 'delivered' AND created_at_ms < ?",
      [userUuid, adapter.id, now - 30 * 24 * 60 * 60 * 1000]
    );
    const rows = await db.query<TrackerScrobbleOutboxRow>(
      forceRetry
        ? "SELECT event_id, event_json, created_at_ms, attempt_count, link_generation FROM tracker_scrobble_outbox WHERE user_uuid = ? AND provider_id = ? AND link_generation = ? AND delivery_status = 'pending' AND lease_until_ms <= ? ORDER BY created_at_ms, event_id LIMIT ?"
        : "SELECT event_id, event_json, created_at_ms, attempt_count, link_generation FROM tracker_scrobble_outbox WHERE user_uuid = ? AND provider_id = ? AND link_generation = ? AND delivery_status = 'pending' AND next_attempt_at_ms <= ? AND lease_until_ms <= ? ORDER BY created_at_ms, event_id LIMIT ?",
      forceRetry
        ? [userUuid, adapter.id, generation, now, 200]
        : [userUuid, adapter.id, generation, now, now, 200]
    );
    for (const row of rows) {
      const claimToken = randomUUID();
      const createdAt = Number(row.created_at_ms);
      const claimed = await db.exec(
        'UPDATE tracker_scrobble_outbox SET lease_token = ?, lease_until_ms = ? WHERE user_uuid = ? AND provider_id = ? AND event_id = ? AND created_at_ms = ? AND link_generation = ? AND lease_until_ms <= ?',
        [
          claimToken,
          now + 120_000,
          userUuid,
          adapter.id,
          row.event_id,
          createdAt,
          generation,
          now,
        ]
      );
      if (!claimed.rowCount) continue;
      try {
        const event = JSON.parse(row.event_json) as TrackerScrobbleEvent;
        const dispatch = await dispatchForCurrentTrackerLink(
          db,
          userUuid,
          adapter.id,
          authRef,
          generation,
          async (tx) => {
            const result = await adapter.scrobble(
              authRef,
              event,
              providerApiFor(adapter)
            );
            await tx.exec(
              "UPDATE tracker_scrobble_outbox SET delivery_status = 'delivered', lease_token = NULL, lease_until_ms = 0, last_error_code = NULL WHERE user_uuid = ? AND provider_id = ? AND event_id = ? AND created_at_ms = ? AND link_generation = ? AND lease_token = ?",
              [
                userUuid,
                adapter.id,
                row.event_id,
                createdAt,
                generation,
                claimToken,
              ]
            );
            return result;
          }
        );
        if (!dispatch.current) {
          linkChanged = true;
          // This worker owns only its claimed generation. A relinked queue is
          // pruned by the new link's enqueue transaction, never by stale work.
          await db.exec(
            'UPDATE tracker_scrobble_outbox SET lease_token = NULL, lease_until_ms = 0 WHERE user_uuid = ? AND provider_id = ? AND event_id = ? AND created_at_ms = ? AND link_generation = ? AND lease_token = ?',
            [
              userUuid,
              adapter.id,
              row.event_id,
              createdAt,
              generation,
              claimToken,
            ]
          );
          continue;
        }
        const result = dispatch.value;
        if (result?.status === 'ignored')
          ignoredProviders.push({
            providerId: adapter.id,
            ...(result.reason ? { reason: result.reason } : {}),
          });
        else if (!syncedProviders.includes(adapter.id))
          syncedProviders.push(adapter.id);
      } catch (error) {
        const attempt = Number(row.attempt_count) + 1;
        const retry = trackerOutboxRetry(adapter, error, attempt, 1_280_000);
        await db.exec(
          'UPDATE tracker_scrobble_outbox SET attempt_count = attempt_count + 1, next_attempt_at_ms = ?, lease_token = NULL, lease_until_ms = 0, last_error_code = ? WHERE user_uuid = ? AND provider_id = ? AND event_id = ? AND created_at_ms = ? AND link_generation = ? AND lease_token = ?',
          [
            Date.now() + retry.delayMs,
            retry.errorCode,
            userUuid,
            adapter.id,
            row.event_id,
            createdAt,
            generation,
            claimToken,
          ]
        );
      }
    }
    const pending = await db.query<{ event_id: string }>(
      "SELECT event_id FROM tracker_scrobble_outbox WHERE user_uuid = ? AND provider_id = ? AND link_generation = ? AND delivery_status = 'pending' LIMIT 1",
      [userUuid, adapter.id, generation]
    );
    if (pending.length || linkChanged) pendingProviders.push(adapter.id);
  }
  return { syncedProviders, pendingProviders, ignoredProviders };
}

/** Queue accepted canonical records before attempting external provider writes. */
async function enqueueProviderRecords(
  tx: DbDriver,
  userUuid: string,
  providerId: string,
  authRef: string,
  generation: number,
  records: TrackerRecord[],
  now = Date.now()
): Promise<boolean> {
  if (
    !(await isCurrentTrackerProviderLink(
      tx,
      userUuid,
      providerId,
      authRef,
      generation,
      true
    ))
  ) {
    return false;
  }
  await tx.exec(
    'DELETE FROM tracker_provider_outbox WHERE user_uuid = ? AND provider_id = ? AND (link_generation IS NULL OR link_generation <> ?)',
    [userUuid, providerId, generation]
  );
  for (const record of records) {
    await tx.exec(
      `INSERT INTO tracker_provider_outbox (user_uuid, provider_id, record_id, record_json, updated_at_ms, link_generation, attempt_count, next_attempt_at_ms, lease_token, lease_until_ms, created_at_ms, last_error_code) VALUES (?, ?, ?, ?, ?, ?, 0, 0, NULL, 0, ?, NULL) ON CONFLICT(user_uuid, provider_id, record_id) DO UPDATE SET record_json = excluded.record_json, updated_at_ms = excluded.updated_at_ms, link_generation = excluded.link_generation, attempt_count = 0, next_attempt_at_ms = 0, lease_token = NULL, lease_until_ms = 0, created_at_ms = excluded.created_at_ms, last_error_code = NULL WHERE excluded.link_generation = tracker_provider_outbox.link_generation AND excluded.updated_at_ms >= tracker_provider_outbox.updated_at_ms`,
      [
        userUuid,
        providerId,
        record.id,
        JSON.stringify(record),
        record.updatedAt,
        generation,
        now,
      ]
    );
  }
  return true;
}

/** Drop only rows still owned by this worker when a tracker was relinked. */
async function discardClaimedProviderRows(
  db: DbDriver,
  userUuid: string,
  providerId: string,
  rows: TrackerOutboxRow[],
  claimToken: string
): Promise<void> {
  await db.tx(async (tx) => {
    for (const row of rows) {
      await tx.exec(
        'DELETE FROM tracker_provider_outbox WHERE user_uuid = ? AND provider_id = ? AND record_id = ? AND updated_at_ms = ? AND link_generation = ? AND lease_token = ?',
        [
          userUuid,
          providerId,
          row.record_id,
          Number(row.updated_at_ms),
          Number(row.link_generation),
          claimToken,
        ]
      );
    }
  });
}

/**
 * Drain due provider writes. Failures stay in the durable outbox with bounded
 * exponential backoff, so a successful `/refresh` cannot hide a failed live
 * `/records` fan-out.
 */
async function flushProviderOutbox(
  db: DbDriver,
  userUuid: string,
  adapters: LinkedTrackerAdapter[],
  requestApi: (adapter: TrackerProviderAdapter) => TrackerProviderApiRequest,
  now = Date.now(),
  forceRetry = false
): Promise<{
  syncedProviders: string[];
  pendingProviders: string[];
  unsupportedWrites: Array<{ providerId: string; skipped: number }>;
  writeFailureReasons: Record<string, string>;
  synced: number;
  skipped: number;
}> {
  const syncedProviders: string[] = [];
  const unsupportedWrites: Array<{ providerId: string; skipped: number }> = [];
  const writeFailureReasons: Record<string, string> = {};
  let synced = 0;
  let skipped = 0;
  for (const { adapter, authRef, generation } of adapters) {
    const rows = await db.query<TrackerOutboxRow>(
      forceRetry
        ? 'SELECT record_id, record_json, updated_at_ms, attempt_count, link_generation FROM tracker_provider_outbox WHERE user_uuid = ? AND provider_id = ? AND link_generation = ? AND lease_until_ms <= ? ORDER BY updated_at_ms ASC, record_id ASC LIMIT ?'
        : 'SELECT record_id, record_json, updated_at_ms, attempt_count, link_generation FROM tracker_provider_outbox WHERE user_uuid = ? AND provider_id = ? AND link_generation = ? AND next_attempt_at_ms <= ? AND lease_until_ms <= ? ORDER BY updated_at_ms ASC, record_id ASC LIMIT ?',
      forceRetry
        ? [userUuid, adapter.id, generation, now, 200]
        : [userUuid, adapter.id, generation, now, now, 200]
    );
    if (rows.length) {
      const claimToken = randomUUID();
      const claimed: TrackerOutboxRow[] = [];
      await db.tx(async (tx) => {
        for (const row of rows) {
          const result = await tx.exec(
            'UPDATE tracker_provider_outbox SET lease_token = ?, lease_until_ms = ? WHERE user_uuid = ? AND provider_id = ? AND record_id = ? AND updated_at_ms = ? AND link_generation = ? AND lease_until_ms <= ?',
            [
              claimToken,
              now + 120_000,
              userUuid,
              adapter.id,
              row.record_id,
              Number(row.updated_at_ms),
              generation,
              now,
            ]
          );
          if (result.rowCount) claimed.push(row);
        }
      });
      if (!claimed.length) continue;
      // Isolate corrupt rows so a single bad payload cannot strand every
      // otherwise-valid item behind a batch-level JSON/schema exception.
      const valid: Array<{ row: TrackerOutboxRow; record: TrackerRecord }> = [];
      for (const row of claimed) {
        try {
          valid.push({
            row,
            record: TrackerRecordSchema.parse(JSON.parse(row.record_json)),
          });
        } catch {
          await db.exec(
            'DELETE FROM tracker_provider_outbox WHERE user_uuid = ? AND provider_id = ? AND record_id = ? AND updated_at_ms = ? AND link_generation = ? AND lease_token = ?',
            [
              userUuid,
              adapter.id,
              row.record_id,
              Number(row.updated_at_ms),
              generation,
              claimToken,
            ]
          );
        }
      }
      const deliverableRows = valid.map(({ row }) => row);
      const records = valid.map(({ record }) => record);
      if (!deliverableRows.length) continue;
      if (adapter.pushRecord) {
        const api = requestApi(adapter);
        let batchSynced = 0;
        let batchSkipped = 0;
        for (let index = 0; index < deliverableRows.length; index += 1) {
          const row = deliverableRows[index]!;
          const record = records[index]!;
          try {
            const dispatch = await dispatchForCurrentTrackerLink(
              db,
              userUuid,
              adapter.id,
              authRef,
              generation,
              () => adapter.pushRecord!(authRef, record, api)
            );
            if (!dispatch.current) {
              writeFailureReasons[adapter.id] = 'tracker_link_changed';
              await db.exec(
                'DELETE FROM tracker_provider_outbox WHERE user_uuid = ? AND provider_id = ? AND record_id = ? AND updated_at_ms = ? AND link_generation = ? AND lease_token = ?',
                [
                  userUuid,
                  adapter.id,
                  row.record_id,
                  Number(row.updated_at_ms),
                  generation,
                  claimToken,
                ]
              );
              continue;
            }
            const represented = dispatch.value;
            await db.tx(async (tx) => {
              await tx.exec(
                'DELETE FROM tracker_provider_outbox WHERE user_uuid = ? AND provider_id = ? AND record_id = ? AND updated_at_ms = ? AND link_generation = ? AND lease_token = ?',
                [
                  userUuid,
                  adapter.id,
                  row.record_id,
                  Number(row.updated_at_ms),
                  generation,
                  claimToken,
                ]
              );
            });
            if (represented) batchSynced += 1;
            else batchSkipped += 1;
          } catch (error) {
            const floppyFailure =
              adapter.id === 'floppy' && error instanceof Error
                ? /^Floppy API request failed \(([45]\d\d)\)(?:; record=(movie|show|episode|season|list)-([a-z_]{1,32}))?$/.exec(
                    error.message
                  )
                : undefined;
            const state =
              record.state === 'deleted'
                ? (record.deletedState ?? 'deleted')
                : record.state;
            writeFailureReasons[adapter.id] = floppyFailure
              ? `upstream_http_${floppyFailure[1]}_${record.kind}_${state}`
              : adapter.id === 'wetrakr' &&
                  error instanceof WeTrakrRateLimitError
                ? 'rate_limited'
                : 'provider_unavailable';
            const attempt = Number(row.attempt_count) + 1;
            const retry = trackerOutboxRetry(
              adapter,
              error,
              attempt,
              15 * 60_000
            );
            await db.tx(async (tx) => {
              await tx.exec(
                'UPDATE tracker_provider_outbox SET attempt_count = attempt_count + 1, next_attempt_at_ms = ?, lease_token = NULL, lease_until_ms = 0, last_error_code = ? WHERE user_uuid = ? AND provider_id = ? AND record_id = ? AND updated_at_ms = ? AND link_generation = ? AND lease_token = ?',
                [
                  Date.now() + retry.delayMs,
                  retry.errorCode,
                  userUuid,
                  adapter.id,
                  row.record_id,
                  Number(row.updated_at_ms),
                  generation,
                  claimToken,
                ]
              );
            });
          }
        }
        if (batchSynced + batchSkipped > 0) syncedProviders.push(adapter.id);
        synced += batchSynced;
        skipped += batchSkipped;
        if (batchSkipped > 0)
          unsupportedWrites.push({
            providerId: adapter.id,
            skipped: batchSkipped,
          });
        continue;
      }
      try {
        const api = requestApi(adapter);
        const ordinary = valid.filter(
          ({ record }) => record.state !== 'deleted'
        );
        const tombstones = valid.filter(
          ({ record }) => record.state === 'deleted'
        );
        let providerHadSuccessfulWrites = false;
        if (ordinary.length) {
          const dispatch = await dispatchForCurrentTrackerLink(
            db,
            userUuid,
            adapter.id,
            authRef,
            generation,
            () =>
              adapter.pushRecords(
                authRef,
                ordinary.map(({ record }) => record),
                api
              )
          );
          if (!dispatch.current) {
            writeFailureReasons[adapter.id] = 'tracker_link_changed';
            await discardClaimedProviderRows(
              db,
              userUuid,
              adapter.id,
              deliverableRows,
              claimToken
            );
            continue;
          }
          const ordinaryResult = dispatch.value;
          await discardClaimedProviderRows(
            db,
            userUuid,
            adapter.id,
            ordinary.map(({ row }) => row),
            claimToken
          );
          providerHadSuccessfulWrites = true;
          synced += ordinaryResult.synced;
          skipped += ordinaryResult.skipped;
          if (ordinaryResult.skipped > 0)
            unsupportedWrites.push({
              providerId: adapter.id,
              skipped: ordinaryResult.skipped,
            });
        }
        if (tombstones.length) {
          if (adapter.removeRecord) {
            for (const { row, record } of tombstones) {
              const dispatch = await dispatchForCurrentTrackerLink(
                db,
                userUuid,
                adapter.id,
                authRef,
                generation,
                () => adapter.removeRecord!(authRef, record, api)
              );
              if (!dispatch.current) {
                writeFailureReasons[adapter.id] = 'tracker_link_changed';
                await discardClaimedProviderRows(
                  db,
                  userUuid,
                  adapter.id,
                  tombstones.map(({ row: pendingRow }) => pendingRow),
                  claimToken
                );
                break;
              }
              await discardClaimedProviderRows(
                db,
                userUuid,
                adapter.id,
                [row],
                claimToken
              );
              synced += 1;
              providerHadSuccessfulWrites = true;
            }
          } else {
            const dispatch = await dispatchForCurrentTrackerLink(
              db,
              userUuid,
              adapter.id,
              authRef,
              generation,
              () =>
                adapter.pushRecords(
                  authRef,
                  tombstones.map(({ record }) => record),
                  api
                )
            );
            if (!dispatch.current) {
              writeFailureReasons[adapter.id] = 'tracker_link_changed';
              await discardClaimedProviderRows(
                db,
                userUuid,
                adapter.id,
                tombstones.map(({ row }) => row),
                claimToken
              );
              continue;
            }
            const tombstoneResult = dispatch.value;
            await discardClaimedProviderRows(
              db,
              userUuid,
              adapter.id,
              tombstones.map(({ row }) => row),
              claimToken
            );
            providerHadSuccessfulWrites = true;
            synced += tombstoneResult.synced;
            skipped += tombstoneResult.skipped;
            if (tombstoneResult.skipped > 0)
              unsupportedWrites.push({
                providerId: adapter.id,
                skipped: tombstoneResult.skipped,
              });
          }
        }
        if (providerHadSuccessfulWrites) syncedProviders.push(adapter.id);
      } catch (error) {
        const floppyFailure =
          adapter.id === 'floppy' && error instanceof Error
            ? /^Floppy API request failed \(([45]\d\d)\)(?:; record=(movie|show|episode|season|list)-([a-z_]{1,32}))?$/.exec(
                error.message
              )
            : undefined;
        writeFailureReasons[adapter.id] = floppyFailure
          ? `upstream_http_${floppyFailure[1]}${floppyFailure[2] && floppyFailure[3] ? `_${floppyFailure[2]}_${floppyFailure[3]}` : ''}`
          : adapter.id === 'wetrakr' && error instanceof WeTrakrRateLimitError
            ? 'rate_limited'
            : 'provider_unavailable';
        await db.tx(async (tx) => {
          for (const row of deliverableRows) {
            const attempt = Number(row.attempt_count) + 1;
            const retry = trackerOutboxRetry(
              adapter,
              error,
              attempt,
              15 * 60_000
            );
            await tx.exec(
              'UPDATE tracker_provider_outbox SET attempt_count = attempt_count + 1, next_attempt_at_ms = ?, lease_token = NULL, lease_until_ms = 0, last_error_code = ? WHERE user_uuid = ? AND provider_id = ? AND record_id = ? AND updated_at_ms = ? AND link_generation = ? AND lease_token = ?',
              [
                Date.now() + retry.delayMs,
                retry.errorCode,
                userUuid,
                adapter.id,
                row.record_id,
                Number(row.updated_at_ms),
                generation,
                claimToken,
              ]
            );
          }
        });
      }
    }
  }
  const pendingProviders: string[] = [];
  for (const { adapter, generation } of adapters) {
    const pending = await db.query<{ record_id: string }>(
      'SELECT record_id FROM tracker_provider_outbox WHERE user_uuid = ? AND provider_id = ? AND link_generation = ? LIMIT 1',
      [userUuid, adapter.id, generation]
    );
    if (pending.length || writeFailureReasons[adapter.id])
      pendingProviders.push(adapter.id);
  }
  return {
    syncedProviders,
    pendingProviders,
    unsupportedWrites,
    writeFailureReasons,
    synced,
    skipped,
  };
}

export function resolveLinkedAdapters(
  user: { trackerProviders?: Record<string, TrackerProviderLink> } | null,
  providerAdapters: TrackerProviderAdapter[] = defaultTrackerProviderAdapters
): { adapters: ResolvedTrackerAdapter[]; unsupported: string[] } {
  const configured = user?.trackerProviders ?? {};
  const active = Object.entries(configured).filter(
    ([, link]) => Boolean(link?.authRef) && link.enabled !== false
  );
  const adapters: ResolvedTrackerAdapter[] = active.flatMap(([id, link]) => {
    const adapter = providerAdapters.find((candidate) => candidate.id === id);
    return adapter && link.authRef ? [{ adapter, authRef: link.authRef }] : [];
  });
  const unsupported = active
    .filter(
      ([id]) => !providerAdapters.some((candidate) => candidate.id === id)
    )
    .map(([id]) => id);
  return { adapters, unsupported };
}

export async function bindLinkedTrackerAdapters(
  db: DbDriver,
  userUuid: string,
  adapters: ResolvedTrackerAdapter[]
): Promise<{ adapters: LinkedTrackerAdapter[]; stale: string[] }> {
  const bound: LinkedTrackerAdapter[] = [];
  const stale: string[] = [];
  for (const linked of adapters) {
    const state = await getTrackerProviderLinkState(
      db,
      userUuid,
      linked.adapter.id
    );
    if (!state || state.authRef !== linked.authRef) {
      stale.push(linked.adapter.id);
      continue;
    }
    bound.push({ ...linked, generation: state.generation });
  }
  return { adapters: bound, stale };
}

/** Resolve tracker connections only when the saved config still owns the authRef. */
export async function resolveCurrentLinkedAdapters(
  db: DbDriver,
  userUuid: string,
  user: { trackerProviders?: Record<string, TrackerProviderLink> } | null
): Promise<{
  adapters: LinkedTrackerAdapter[];
  stale: string[];
  unsupported: string[];
}> {
  await db.tx((tx) =>
    initializeTrackerProviderLinkStates(
      tx,
      userUuid,
      user?.trackerProviders ?? {}
    )
  );
  const resolved = resolveLinkedAdapters(user);
  const bound = await bindLinkedTrackerAdapters(
    db,
    userUuid,
    resolved.adapters
  );
  return { ...bound, unsupported: resolved.unsupported };
}

export function defaultProviderApiFor(
  adapter: TrackerProviderAdapter,
  requestProviderApi?: TrackerProviderApiRequest
): TrackerProviderApiRequest {
  if (adapter.requestApi) return adapter.requestApi;
  if (requestProviderApi) return requestProviderApi;
  if (adapter.id === 'wetrakr') {
    return (authRef, path, init) => requestWeTrakrApi(authRef, path, init);
  }
  if (adapter.id === 'floppy') {
    return (authRef, path, init) => requestFloppyApi(authRef, path, init);
  }
  return async () => {
    throw new Error(
      `Tracker provider ${adapter.id} has no configured API transport`
    );
  };
}

/**
 * Persisted Jellyfin list/rating mutations must enter the same durable provider
 * outbox as writes made through the tracker API. This keeps retries, rate
 * limits, origin suppression, and provider-specific delete semantics unified.
 */
export async function fanOutLinkedTrackerRecord(
  userUuid: string,
  user: { trackerProviders?: Record<string, TrackerProviderLink> } | null,
  record: TrackerRecord,
  db: DbDriver = getDb(),
  persist?: (tx: DbDriver) => Promise<boolean>
): Promise<void> {
  await db.tx((tx) =>
    initializeTrackerProviderLinkStates(
      tx,
      userUuid,
      user?.trackerProviders ?? {}
    )
  );
  const resolved = resolveLinkedAdapters(user).adapters.filter(
    ({ adapter }) => adapter.id !== record.origin
  );
  const { adapters } = await bindLinkedTrackerAdapters(db, userUuid, resolved);
  if (!adapters.length && !persist) return;
  const now = Date.now();
  let accepted = true;
  await db.tx(async (tx) => {
    accepted = (await persist?.(tx)) ?? true;
    if (!accepted) return;
    for (const { adapter, authRef, generation } of adapters) {
      const enqueued = await enqueueProviderRecords(
        tx,
        userUuid,
        adapter.id,
        authRef,
        generation,
        [record],
        now
      );
      if (!enqueued)
        throw new Error('Tracker link changed during Jellyfin fan-out');
    }
  });
  if (!accepted || !adapters.length) return;
  await flushProviderOutbox(
    db,
    userUuid,
    adapters,
    (adapter) => defaultProviderApiFor(adapter),
    now
  );
}

/** Factory keeps the mounted API testable without weakening production auth. */
export function createTrackerRouter(
  dependencies: TrackerRouterDependencies = {
    authenticate: async (uuid, password) =>
      (await UserRepository.getUser(uuid, password)) ?? null,
    database: getDb,
    rateLimiter: userApiRateLimiter,
  }
): Router {
  const router: Router = Router();
  router.use(dependencies.rateLimiter ?? userApiRateLimiter);
  const lastProviderProgressWrite = new Map<string, number>();
  const providerAdapters =
    dependencies.trackerAdapters ?? defaultTrackerProviderAdapters;
  const providerApi =
    dependencies.requestProviderApi ??
    ((authRef, path, init) => requestWeTrakrApi(authRef, path, init));
  const providerApiFor = (adapter: TrackerProviderAdapter) =>
    adapter.requestApi ??
    dependencies.requestProviderApi ??
    (adapter.id === 'wetrakr'
      ? providerApi
      : async () => {
          throw new Error(
            `Tracker provider ${adapter.id} has no configured API transport`
          );
        });

  async function authenticatedAccount(req: Request): Promise<{
    uuid: string;
    user: { trackerProviders?: Record<string, TrackerProviderLink> } | null;
  }> {
    // AIOStreams addon URLs already contain this server-issued encrypted
    // password token. Accept it here so Nuvio can offer one-tap tracker
    // linking when that addon is installed, without asking users to retype or
    // persist the raw account password on the TV.
    const credentials = parseBasicAuthHeader(req, { allowEncrypted: true });
    if (!credentials)
      throw new APIError(
        constants.ErrorCode.UNAUTHORIZED,
        undefined,
        'Basic AIOStreams credentials required'
      );
    const authenticated = await dependencies.authenticate(
      credentials.uuid,
      credentials.password
    );
    if (!authenticated) {
      throw new APIError(constants.ErrorCode.UNAUTHORIZED);
    }
    const user = typeof authenticated === 'object' ? authenticated : null;
    if (user) {
      // Legacy rows are seeded only from the authenticated saved config. The
      // insert is do-nothing on conflict, so a concurrent relink always wins.
      await dependencies
        .database()
        .tx((tx) =>
          initializeTrackerProviderLinkStates(
            tx,
            credentials.uuid,
            user.trackerProviders ?? {}
          )
        );
    }
    return {
      uuid: credentials.uuid,
      user,
    };
  }

  async function authenticatedUuid(req: Request): Promise<string> {
    return (await authenticatedAccount(req)).uuid;
  }

  async function linkedAdapters(
    userUuid: string,
    user: { trackerProviders?: Record<string, TrackerProviderLink> } | null,
    db: DbDriver
  ) {
    const resolved = resolveLinkedAdapters(user, providerAdapters);
    const bound = await bindLinkedTrackerAdapters(
      db,
      userUuid,
      resolved.adapters
    );
    return {
      adapters: bound.adapters,
      unsupported: [...resolved.unsupported, ...bound.stale],
    };
  }

  router.post('/refresh', async (req, res, next) => {
    try {
      const { uuid: userUuid, user } = await authenticatedAccount(req);
      const db = dependencies.database();
      const { adapters, unsupported } = await linkedAdapters(
        userUuid,
        user,
        db
      );
      const pullable = adapters.filter(
        ({ adapter }) => adapter.pullChanges || adapter.pullSnapshot
      );
      const outcomes = await Promise.all(
        pullable.map(async ({ adapter, authRef, generation }) => {
          try {
            if (
              !(await isCurrentTrackerProviderLink(
                db,
                userUuid,
                adapter.id,
                authRef,
                generation
              ))
            ) {
              return {
                success: false as const,
                id: adapter.id,
                reason: 'tracker_link_changed',
                endpoint: undefined,
              };
            }
            const state = await db.maybeOne<{
              checkpoint_at_ms: number | string;
            }>(
              'SELECT checkpoint_at_ms FROM tracker_provider_sync_state WHERE user_uuid = ? AND provider_id = ?',
              [userUuid, adapter.id]
            );
            const initial = !state;
            const startedAt = Date.now();
            const checkpointBefore = state
              ? Number(state.checkpoint_at_ms)
              : null;
            const checkpoint = state
              ? new Date(checkpointBefore!).toISOString()
              : new Date(startedAt - 5_000).toISOString();
            const facetStateRows = adapter.retryIncompleteSnapshotFacets
              ? await db.query<{
                  facet_id: string;
                  completed_at_ms: number | string;
                  attempt_count?: number | string;
                  next_attempt_at_ms?: number | string;
                  last_failure_reason?: string | null;
                  endpoint?: string | null;
                }>(
                  'SELECT facet_id, completed_at_ms, attempt_count, next_attempt_at_ms, last_failure_reason, endpoint FROM tracker_provider_facets WHERE user_uuid = ? AND provider_id = ?',
                  [userUuid, adapter.id]
                )
              : [];
            const now = Date.now();
            const completedFacetIds = facetStateRows
              .filter(({ completed_at_ms }) => Number(completed_at_ms) > 0)
              .map(({ facet_id }) => facet_id);
            const deferredFacetRows = facetStateRows.filter(
              ({ completed_at_ms, next_attempt_at_ms }) =>
                Number(completed_at_ms) <= 0 &&
                Number(next_attempt_at_ms ?? 0) > now
            );
            const skippedFacetIds = [
              ...completedFacetIds,
              ...deferredFacetRows.map(({ facet_id }) => facet_id),
            ];
            const snapshotOnly =
              adapter.syncMode === 'snapshot' || !adapter.pullChanges;
            let mergedInput: TrackerRecord[];
            let observedSnapshot: TrackerRecord[] | undefined;
            let snapshotFailures: TrackerProviderSnapshot['failures'] = [];
            let nextCheckpoint: string;
            if (snapshotOnly) {
              if (!adapter.pullSnapshot)
                throw new Error(
                  `Snapshot provider ${adapter.id} has no snapshot reader`
                );
              const [pulledSnapshot, priorRows] = await Promise.all([
                adapter.pullSnapshot(authRef, providerApiFor(adapter), {
                  completedFacets: skippedFacetIds,
                }),
                db.query<{ record_json: string }>(
                  'SELECT record_json FROM tracker_provider_records WHERE user_uuid = ? AND provider_id = ? ORDER BY record_id ASC',
                  [userUuid, adapter.id]
                ),
              ]);
              const snapshot = Array.isArray(pulledSnapshot)
                ? { records: pulledSnapshot, failures: [], completedFacets: [] }
                : pulledSnapshot;
              snapshotFailures = [
                ...snapshot.failures,
                ...deferredFacetRows.map((row) => {
                  const storedReason =
                    row.last_failure_reason ?? 'provider_error';
                  const statusMatch = /^upstream_http_(4\d\d|5\d\d)$/.exec(
                    storedReason
                  );
                  const status = statusMatch
                    ? Number(statusMatch[1])
                    : undefined;
                  const providerCode =
                    storedReason === 'upstream_private'
                      ? ('PRIVATE' as const)
                      : storedReason === 'upstream_friends_only'
                        ? ('FRIENDS_ONLY' as const)
                        : storedReason === 'upstream_comments_disabled'
                          ? ('COMMENTS_DISABLED' as const)
                          : undefined;
                  const endpoint =
                    row.endpoint && SAFE_TRACKER_ENDPOINTS.has(row.endpoint)
                      ? row.endpoint
                      : undefined;
                  return {
                    facetId: row.facet_id,
                    ...(status ? { status } : {}),
                    ...(providerCode ? { providerCode } : {}),
                    ...(endpoint ? { endpoint } : {}),
                    ...(!status && !providerCode
                      ? {
                          reason: storedReason as NonNullable<
                            TrackerProviderSnapshot['failures'][number]['reason']
                          >,
                        }
                      : {}),
                  };
                }),
              ];
              if (snapshotFailures.length) {
                // A partial snapshot can add/update returned records, but it is
                // never authoritative: do not synthesize removals or save it as
                // the provider's observed state.
                mergedInput = diffTrackerSnapshot(
                  adapter.id,
                  snapshot.records,
                  []
                ).observed;
              } else {
                const diff = diffTrackerSnapshot(
                  adapter.id,
                  snapshot.records,
                  priorRows
                );
                mergedInput = diff.records;
                observedSnapshot = diff.observed;
              }
              nextCheckpoint = new Date(
                Math.max(startedAt, (checkpointBefore ?? 0) + 1)
              ).toISOString();
            } else {
              let initialRecords: TrackerRecord[] = [];
              if (
                (initial || adapter.retryIncompleteSnapshotFacets) &&
                adapter.pullSnapshot
              ) {
                const pulledSnapshot = await adapter.pullSnapshot(
                  authRef,
                  providerApiFor(adapter),
                  { completedFacets: skippedFacetIds }
                );
                const snapshot = Array.isArray(pulledSnapshot)
                  ? {
                      records: pulledSnapshot,
                      failures: [],
                      completedFacets: [],
                    }
                  : pulledSnapshot;
                snapshotFailures = [
                  ...snapshot.failures,
                  ...deferredFacetRows.map((row) => {
                    const storedReason =
                      row.last_failure_reason ?? 'provider_error';
                    const statusMatch = /^upstream_http_(4\d\d|5\d\d)$/.exec(
                      storedReason
                    );
                    const status = statusMatch
                      ? Number(statusMatch[1])
                      : undefined;
                    const providerCode =
                      storedReason === 'upstream_private'
                        ? ('PRIVATE' as const)
                        : storedReason === 'upstream_friends_only'
                          ? ('FRIENDS_ONLY' as const)
                          : storedReason === 'upstream_comments_disabled'
                            ? ('COMMENTS_DISABLED' as const)
                            : undefined;
                    const endpoint =
                      row.endpoint && SAFE_TRACKER_ENDPOINTS.has(row.endpoint)
                        ? row.endpoint
                        : undefined;
                    return {
                      facetId: row.facet_id,
                      ...(status ? { status } : {}),
                      ...(providerCode ? { providerCode } : {}),
                      ...(endpoint ? { endpoint } : {}),
                      ...(!status && !providerCode
                        ? {
                            reason: storedReason as NonNullable<
                              TrackerProviderSnapshot['failures'][number]['reason']
                            >,
                          }
                        : {}),
                    };
                  }),
                ];
                // Facet snapshots are additive: retain successful facets, retry
                // only incomplete facets, and use the journal for ongoing edits.
                initialRecords = diffTrackerSnapshot(
                  adapter.id,
                  snapshot.records,
                  []
                ).observed;
                completedFacetIds.push(...(snapshot.completedFacets ?? []));
              }
              const delta = await adapter.pullChanges!(
                authRef,
                checkpoint,
                providerApiFor(adapter)
              );
              mergedInput = [...initialRecords, ...delta.records];
              nextCheckpoint = delta.checkpoint;
            }
            let accepted: ReturnType<typeof TrackerRecordSchema.parse>[] = [];
            const replayable: ReturnType<typeof TrackerRecordSchema.parse>[] =
              [];
            const persistedForCurrentLink = await db.tx(async (tx) => {
              if (
                !(await isCurrentTrackerProviderLink(
                  tx,
                  userUuid,
                  adapter.id,
                  authRef,
                  generation,
                  true
                ))
              ) {
                return false;
              }
              for (const record of mergedInput) {
                const existing = await tx.maybeOne<{
                  record_json: string;
                  updated_at_ms: number | string;
                }>(
                  'SELECT record_json, updated_at_ms FROM tracker_records WHERE user_uuid = ? AND record_id = ?',
                  [userUuid, record.id]
                );
                if (existing) {
                  const current = TrackerRecordSchema.parse(
                    JSON.parse(existing.record_json)
                  );
                  if (sameTrackerValue(current, record)) {
                    // A provider may replay a change after a downstream write failed.
                    // Re-forward the canonical value without treating the echo as new.
                    replayable.push(current);
                    continue;
                  }
                  if (record.updatedAt < Number(existing.updated_at_ms)) {
                    // Keep the newer canonical winner and repair this source
                    // rather than letting its stale snapshot become permanent.
                    replayable.push(current);
                    continue;
                  }
                  if (record.updatedAt === Number(existing.updated_at_ms)) {
                    replayable.push(current);
                    continue;
                  }
                }
                const saved = await tx.exec(
                  `INSERT INTO tracker_records (user_uuid, record_id, record_json, updated_at_ms) VALUES (?, ?, ?, ?) ON CONFLICT(user_uuid, record_id) DO UPDATE SET record_json = excluded.record_json, updated_at_ms = excluded.updated_at_ms WHERE excluded.updated_at_ms > tracker_records.updated_at_ms`,
                  [
                    userUuid,
                    record.id,
                    JSON.stringify(record),
                    record.updatedAt,
                  ]
                );
                if (saved.rowCount > 0) {
                  accepted.push(record);
                  replayable.push(record);
                }
              }
              for (const facetId of [...completedFacetIds]) {
                if (!/^[a-z0-9_:-]{1,128}$/i.test(facetId)) continue;
                await tx.exec(
                  'INSERT INTO tracker_provider_facets (user_uuid, provider_id, facet_id, completed_at_ms, attempt_count, next_attempt_at_ms, last_failure_reason, endpoint) VALUES (?, ?, ?, ?, 0, 0, NULL, NULL) ON CONFLICT(user_uuid, provider_id, facet_id) DO UPDATE SET completed_at_ms = excluded.completed_at_ms, attempt_count = 0, next_attempt_at_ms = 0, last_failure_reason = NULL, endpoint = NULL',
                  [userUuid, adapter.id, facetId, Date.now()]
                );
              }
              for (const failure of snapshotFailures) {
                const facetId = failure.facetId;
                if (!facetId || !/^[a-z0-9_:-]{1,128}$/i.test(facetId))
                  continue;
                const previous = facetStateRows.find(
                  (row) => row.facet_id === facetId
                );
                if (Number(previous?.next_attempt_at_ms ?? 0) > now) continue;
                const attempt = Number(previous?.attempt_count ?? 0) + 1;
                const reason = trackerRefreshFailureReason(failure);
                const endpoint =
                  failure.endpoint &&
                  SAFE_TRACKER_ENDPOINTS.has(failure.endpoint)
                    ? failure.endpoint
                    : 'other';
                const delay =
                  failure.status === 401 || failure.status === 403
                    ? 30 * 60_000
                    : failure.status === 429
                      ? 5 * 60_000
                      : Math.min(
                          15 * 60_000,
                          5_000 * 2 ** Math.min(attempt - 1, 8)
                        );
                await tx.exec(
                  'INSERT INTO tracker_provider_facets (user_uuid, provider_id, facet_id, completed_at_ms, attempt_count, next_attempt_at_ms, last_failure_reason, endpoint) VALUES (?, ?, ?, 0, ?, ?, ?, ?) ON CONFLICT(user_uuid, provider_id, facet_id) DO UPDATE SET attempt_count = excluded.attempt_count, next_attempt_at_ms = excluded.next_attempt_at_ms, last_failure_reason = excluded.last_failure_reason, endpoint = excluded.endpoint WHERE tracker_provider_facets.completed_at_ms <= 0',
                  [
                    userUuid,
                    adapter.id,
                    facetId,
                    attempt,
                    now + delay,
                    reason,
                    endpoint,
                  ]
                );
              }
              return true;
            });

            if (!persistedForCurrentLink) {
              return {
                success: false as const,
                id: adapter.id,
                reason: 'tracker_link_changed',
                endpoint: undefined,
              };
            }

            // On first connection seed the newly linked provider from the existing
            // merged ledger. Later journal updates fan out only their accepted
            // canonical changes; provider-origin records never echo home.
            let toFanOut = replayable;
            if (initial) {
              const rows = await db.query<{ record_json: string }>(
                'SELECT record_json FROM tracker_records WHERE user_uuid = ? ORDER BY updated_at_ms ASC, record_id ASC',
                [userUuid]
              );
              toFanOut = rows.map((row) =>
                TrackerRecordSchema.parse(JSON.parse(row.record_json))
              );
            }
            return {
              success: true as const,
              id: adapter.id,
              authRef,
              generation,
              initial,
              accepted,
              toFanOut,
              checkpoint: nextCheckpoint,
              checkpointBefore,
              observedSnapshot,
              snapshotFailures,
              completedFacets: [...new Set(completedFacetIds)],
            };
          } catch (error) {
            return {
              success: false as const,
              id: adapter.id,
              reason: trackerRefreshFailureReason(error),
              endpoint: trackerRefreshFailureEndpoint(error),
            };
          }
        })
      );

      const pendingProviders = outcomes.flatMap((outcome) =>
        !outcome.success || outcome.snapshotFailures.length ? [outcome.id] : []
      );
      const pendingDetails: TrackerRefreshFailure[] = outcomes.flatMap(
        (outcome) =>
          !outcome.success
            ? [
                {
                  providerId: outcome.id,
                  stage: 'pull' as const,
                  reason: outcome.reason,
                  endpoint: outcome.endpoint,
                },
              ]
            : outcome.snapshotFailures.map((failure) => ({
                providerId: outcome.id,
                stage: 'pull' as const,
                reason: trackerRefreshFailureReason(failure),
                ...(failure.endpoint ? { endpoint: failure.endpoint } : {}),
              }))
      );
      const availableOutcomes = outcomes.filter((outcome) => outcome.success);
      const queueWriteFailures: string[] = [];
      const providerWriteFailures: string[] = [];
      for (const destination of adapters) {
        const sourceRecords = availableOutcomes.flatMap((outcome) =>
          outcome.toFanOut.filter(
            (record) => record.origin !== destination.adapter.id
          )
        );
        if (!sourceRecords.length) continue;
        try {
          await db.tx(async (tx) => {
            const enqueued = await enqueueProviderRecords(
              tx,
              userUuid,
              destination.adapter.id,
              destination.authRef,
              destination.generation,
              sourceRecords
            );
            if (!enqueued)
              throw new Error('Tracker link changed before fan-out was queued');
          });
        } catch (error) {
          queueWriteFailures.push(destination.adapter.id);
          pendingDetails.push({
            providerId: destination.adapter.id,
            stage: 'queue_write',
            reason: trackerRefreshFailureReason(error),
          });
        }
      }
      const outbox = await flushProviderOutbox(
        db,
        userUuid,
        adapters,
        providerApiFor,
        Date.now(),
        true
      );
      providerWriteFailures.push(...outbox.pendingProviders);
      pendingDetails.push(
        ...outbox.pendingProviders.map((providerId) => ({
          providerId,
          stage: 'write' as const,
          reason:
            outbox.writeFailureReasons[providerId] ?? 'provider_write_pending',
        }))
      );
      const scrobbleOutbox = await flushScrobbleOutbox(
        db,
        userUuid,
        adapters,
        providerApiFor,
        Date.now(),
        true
      );
      providerWriteFailures.push(...scrobbleOutbox.pendingProviders);
      pendingDetails.push(
        ...scrobbleOutbox.pendingProviders.map((providerId) => ({
          providerId,
          stage: 'scrobble' as const,
          reason: 'scrobble_pending',
        }))
      );
      const allPending = [
        ...new Set([
          ...pendingProviders,
          ...queueWriteFailures,
          ...providerWriteFailures,
        ]),
      ];
      // Provider API failures do not block source checkpoints after every
      // accepted record has been durably queued for retry. Queue-write failures
      // still block the checkpoint because the source delta would otherwise be
      // lost. Incomplete snapshot facets retain their existing per-facet retry.
      if (queueWriteFailures.length === 0) {
        for (const outcome of availableOutcomes) {
          const checkpointAt = Date.parse(outcome.checkpoint);
          if (!Number.isFinite(checkpointAt)) {
            allPending.push(outcome.id);
            continue;
          }
          try {
            const checkpointCommitted = await db.tx(async (tx) => {
              if (
                !(await isCurrentTrackerProviderLink(
                  tx,
                  userUuid,
                  outcome.id,
                  outcome.authRef,
                  outcome.generation,
                  true
                ))
              ) {
                return false;
              }
              const current = await tx.maybeOne<{
                checkpoint_at_ms: number | string;
              }>(
                'SELECT checkpoint_at_ms FROM tracker_provider_sync_state WHERE user_uuid = ? AND provider_id = ?',
                [userUuid, outcome.id]
              );
              if (
                outcome.observedSnapshot &&
                (current ? Number(current.checkpoint_at_ms) : null) !==
                  outcome.checkpointBefore
              ) {
                throw new Error(
                  'Concurrent snapshot refresh changed the observed state'
                );
              }
              if (outcome.checkpointBefore === null) {
                if (current) {
                  if (Number(current.checkpoint_at_ms) !== checkpointAt)
                    throw new Error(
                      'Concurrent tracker refresh changed the checkpoint'
                    );
                } else {
                  await tx.exec(
                    'INSERT INTO tracker_provider_sync_state (user_uuid, provider_id, checkpoint_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)',
                    [userUuid, outcome.id, checkpointAt, Date.now()]
                  );
                }
              } else if (Number(current?.checkpoint_at_ms) !== checkpointAt) {
                if (
                  Number(current?.checkpoint_at_ms) !== outcome.checkpointBefore
                ) {
                  throw new Error(
                    'Concurrent tracker refresh changed the checkpoint'
                  );
                }
                const updated = await tx.exec(
                  'UPDATE tracker_provider_sync_state SET checkpoint_at_ms = ?, updated_at_ms = ? WHERE user_uuid = ? AND provider_id = ? AND checkpoint_at_ms = ?',
                  [
                    checkpointAt,
                    Date.now(),
                    userUuid,
                    outcome.id,
                    outcome.checkpointBefore,
                  ]
                );
                if (updated.rowCount !== 1)
                  throw new Error('Tracker checkpoint compare-and-swap failed');
              }

              if (outcome.observedSnapshot) {
                const observedIds = new Set(
                  outcome.observedSnapshot.map(({ id }) => id)
                );
                const existing = await tx.query<{ record_id: string }>(
                  'SELECT record_id FROM tracker_provider_records WHERE user_uuid = ? AND provider_id = ?',
                  [userUuid, outcome.id]
                );
                for (const row of existing) {
                  if (!observedIds.has(row.record_id)) {
                    await tx.exec(
                      'DELETE FROM tracker_provider_records WHERE user_uuid = ? AND provider_id = ? AND record_id = ?',
                      [userUuid, outcome.id, row.record_id]
                    );
                  }
                }
                for (const record of outcome.observedSnapshot) {
                  await tx.exec(
                    'INSERT INTO tracker_provider_records (user_uuid, provider_id, record_id, record_json, updated_at_ms) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_uuid, provider_id, record_id) DO UPDATE SET record_json = excluded.record_json, updated_at_ms = excluded.updated_at_ms',
                    [
                      userUuid,
                      outcome.id,
                      record.id,
                      JSON.stringify(record),
                      record.updatedAt,
                    ]
                  );
                }
              }
              return true;
            });
            if (!checkpointCommitted) {
              allPending.push(outcome.id);
              pendingDetails.push({
                providerId: outcome.id,
                stage: 'checkpoint',
                reason: 'tracker_link_changed',
              });
            }
          } catch (error) {
            allPending.push(outcome.id);
            pendingDetails.push({
              providerId: outcome.id,
              stage: 'checkpoint',
              reason: trackerRefreshFailureReason(error),
            });
          }
        }
      }
      const data = {
        syncedProviders: [
          ...new Set([
            ...availableOutcomes
              .filter((outcome) => outcome.snapshotFailures.length === 0)
              .map((outcome) => outcome.id),
            ...outbox.syncedProviders,
            ...scrobbleOutbox.syncedProviders,
          ]),
        ],
        pulledProviders: availableOutcomes.map((outcome) => outcome.id),
        pendingProviders: allPending,
        pendingDetails: pendingDetails.filter(
          (detail, index, details) =>
            details.findIndex(
              (candidate) =>
                candidate.providerId === detail.providerId &&
                candidate.stage === detail.stage &&
                candidate.reason === detail.reason
            ) === index
        ),
        unsupportedProviders: unsupported,
        unsupportedWrites: outbox.unsupportedWrites,
        scrobbleIgnoredProviders: scrobbleOutbox.ignoredProviders,
        imported: availableOutcomes.reduce(
          (sum, outcome) => sum + outcome.accepted.length,
          0
        ),
      };
      if (allPending.length) {
        res.status(503).json({
          success: false,
          detail: 'Tracker refresh is partially pending; retry safely.',
          data,
        });
        return;
      }
      res.status(200).json(
        createResponse({
          success: true,
          detail: outbox.unsupportedWrites.some(({ skipped }) => skipped > 0)
            ? 'Tracker providers refreshed; some record types are not supported by their adapters.'
            : 'Enabled tracker providers refreshed and merged.',
          data,
        })
      );
    } catch (error) {
      next(error);
    }
  });

  router.get('/snapshot', async (req, res, next) => {
    try {
      const userUuid = await authenticatedUuid(req);
      const cursorParam =
        typeof req.query.cursor === 'string' ? req.query.cursor : '';
      const cursor = parseTrackerCursor(cursorParam);
      if (cursorParam && !cursor)
        throw new APIError(
          constants.ErrorCode.MISSING_REQUIRED_FIELDS,
          undefined,
          'Invalid tracker cursor'
        );
      const rawLimit = Number(req.query.limit ?? 200);
      const limit = Number.isInteger(rawLimit)
        ? Math.min(500, Math.max(1, rawLimit))
        : 200;
      const rows = await dependencies.database().query<{
        record_id: string;
        record_json: string;
        updated_at_ms: number | string;
      }>(cursor ? `SELECT record_id, record_json, updated_at_ms FROM tracker_records WHERE user_uuid = ? AND (updated_at_ms > ? OR (updated_at_ms = ? AND record_id > ?)) ORDER BY updated_at_ms ASC, record_id ASC LIMIT ?` : `SELECT record_id, record_json, updated_at_ms FROM tracker_records WHERE user_uuid = ? ORDER BY updated_at_ms ASC, record_id ASC LIMIT ?`, cursor ? [userUuid, cursor.updatedAt, cursor.updatedAt, cursor.id, limit + 1] : [userUuid, limit + 1]);
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const records = page.map((row) =>
        TrackerRecordSchema.parse(JSON.parse(row.record_json))
      );
      const last = page.at(-1);
      const nextCursor = last
        ? makeTrackerCursor({
            updatedAt: Number(last.updated_at_ms),
            id: last.record_id,
          })
        : null;
      res.status(200).json(
        createResponse({
          success: true,
          detail: 'Tracker snapshot retrieved',
          data: { records, nextCursor: hasMore ? nextCursor : null, hasMore },
        })
      );
    } catch (error) {
      next(error);
    }
  });

  router.post('/scrobble', async (req, res, next) => {
    try {
      const { uuid: userUuid, user } = await authenticatedAccount(req);
      const db = dependencies.database();
      const { adapters, unsupported } = await linkedAdapters(
        userUuid,
        user,
        db
      );
      if (!adapters.length) {
        res.status(unsupported.length ? 501 : 409).json({
          error: unsupported.length
            ? 'Enabled tracker providers do not have an AIOStreams adapter yet.'
            : 'No enabled tracker account is linked to this AIOStreams profile.',
          ...(unsupported.length ? { unsupportedProviders: unsupported } : {}),
        });
        return;
      }
      const body =
        req.body && typeof req.body === 'object'
          ? (req.body as Record<string, unknown>)
          : {};
      const action = body.action;
      const rawEventId = body.eventId;
      if (
        rawEventId !== undefined &&
        (typeof rawEventId !== 'string' ||
          !/^[A-Za-z0-9._~-]{1,128}$/.test(rawEventId))
      ) {
        res.status(400).json({ error: 'Invalid scrobble event id.' });
        return;
      }
      const progress = Number(body.progress);
      const positionMs = body.positionMs;
      const durationMs = body.durationMs;
      const media =
        body.media &&
        typeof body.media === 'object' &&
        !Array.isArray(body.media)
          ? (body.media as Record<string, unknown>)
          : null;
      const kind = media?.kind;
      const title = typeof media?.title === 'string' ? media.title.trim() : '';
      const year = media?.year;
      const rawIds =
        media?.ids && typeof media.ids === 'object' && !Array.isArray(media.ids)
          ? (media.ids as Record<string, unknown>)
          : {};
      const ids = Object.fromEntries(
        Object.entries(rawIds)
          .filter(
            ([key, value]) =>
              /^[a-z][a-z0-9_-]{0,31}$/i.test(key) &&
              typeof value === 'string' &&
              value.trim().length > 0 &&
              value.length <= 160
          )
          .map(([key, value]) => [key, (value as string).trim()])
      );
      if (
        !['start', 'pause', 'stop'].includes(String(action)) ||
        !Number.isFinite(progress) ||
        progress < 0 ||
        progress > 100 ||
        !media ||
        !['movie', 'show', 'anime'].includes(String(kind)) ||
        title.length > 500 ||
        (year !== undefined &&
          (typeof year !== 'number' ||
            !Number.isInteger(year) ||
            year < 1880 ||
            year > 2200)) ||
        Object.keys(ids).length === 0 ||
        (positionMs !== undefined &&
          (typeof positionMs !== 'number' ||
            !Number.isSafeInteger(positionMs) ||
            positionMs < 0 ||
            positionMs > 31_536_000_000)) ||
        (durationMs !== undefined &&
          (typeof durationMs !== 'number' ||
            !Number.isSafeInteger(durationMs) ||
            durationMs <= 0 ||
            durationMs > 31_536_000_000)) ||
        (positionMs === undefined) !== (durationMs === undefined) ||
        (typeof positionMs === 'number' &&
          typeof durationMs === 'number' &&
          positionMs > durationMs)
      ) {
        res.status(400).json({ error: 'Invalid scrobble event.' });
        return;
      }
      const episode =
        media.episode &&
        typeof media.episode === 'object' &&
        !Array.isArray(media.episode)
          ? (media.episode as Record<string, unknown>)
          : null;
      let normalizedMedia: TrackerScrobbleEvent['media'];
      if (kind === 'movie') {
        if (episode) {
          res
            .status(400)
            .json({ error: 'Movie scrobble cannot include episode data.' });
          return;
        }
        normalizedMedia = {
          kind: 'movie',
          ...(title ? { title } : {}),
          ...(year ? { year } : {}),
          ids,
        };
      } else {
        const season = episode?.season;
        const number = episode?.number;
        if (
          !episode ||
          typeof season !== 'number' ||
          !Number.isInteger(season) ||
          season < 0 ||
          season > 500 ||
          typeof number !== 'number' ||
          !Number.isInteger(number) ||
          number < 0 ||
          number > 10_000
        ) {
          res.status(400).json({
            error: 'Show scrobble requires valid season and episode numbers.',
          });
          return;
        }
        normalizedMedia = {
          kind: 'show',
          ...(title ? { title } : {}),
          ...(year ? { year } : {}),
          ids,
          episode: {
            season,
            number,
            ...(typeof episode.title === 'string' && episode.title.length <= 500
              ? { title: episode.title }
              : {}),
          },
        };
      }
      const event: TrackerScrobbleEvent = {
        eventId: typeof rawEventId === 'string' ? rawEventId : randomUUID(),
        action: action as TrackerScrobbleEvent['action'],
        progress,
        ...(typeof positionMs === 'number' ? { positionMs } : {}),
        ...(typeof durationMs === 'number' ? { durationMs } : {}),
        media: normalizedMedia!,
      };
      const staleProviders = await db.tx((tx) =>
        enqueueScrobbleEvents(tx, userUuid, adapters, event)
      );
      const delivery = await flushScrobbleOutbox(
        db,
        userUuid,
        adapters,
        providerApiFor
      );
      const pendingProviders = [
        ...new Set([...delivery.pendingProviders, ...staleProviders]),
      ];
      if (pendingProviders.length) {
        res.status(503).json({
          success: false,
          error: staleProviders.length
            ? 'A tracker link changed during scrobble; retry the event.'
            : 'Scrobble is durably queued for one or more tracker providers.',
          data: {
            action,
            progress,
            syncedProviders: delivery.syncedProviders,
            ignoredProviders: delivery.ignoredProviders,
            pendingProviders,
            unsupportedProviders: unsupported,
          },
        });
        return;
      }
      res.status(200).json({
        success: true,
        data: {
          action,
          progress,
          syncedProviders: delivery.syncedProviders,
          ignoredProviders: delivery.ignoredProviders,
          unsupportedProviders: unsupported,
        },
      });
    } catch (error) {
      if (error instanceof APIError) next(error);
      else
        res
          .status(502)
          .json({ error: 'Linked tracker scrobble request failed.' });
    }
  });

  router.post('/records', async (req, res, next) => {
    try {
      const { uuid: userUuid, user } = await authenticatedAccount(req);
      const parsed = TrackerBatchSchema.safeParse(req.body);
      if (!parsed.success)
        throw new APIError(
          constants.ErrorCode.MISSING_REQUIRED_FIELDS,
          undefined,
          'records must contain 1–200 valid tracker records'
        );
      const db = dependencies.database();
      const { adapters, unsupported } = await linkedAdapters(
        userUuid,
        user,
        db
      );
      const now = Date.now();
      let accepted = 0;
      let staleDestination = false;
      const fanoutCandidates: ReturnType<
        typeof TrackerBatchSchema.parse
      >['records'] = [];
      await db.tx(async (tx) => {
        for (const record of parsed.data.records) {
          const serialized = JSON.stringify(record);
          const existing = await tx.maybeOne<{
            record_json: string;
            updated_at_ms: number | string;
          }>(
            'SELECT record_json, updated_at_ms FROM tracker_records WHERE user_uuid = ? AND record_id = ?',
            [userUuid, record.id]
          );
          const currentUpdatedAt = existing
            ? Number(existing.updated_at_ms)
            : null;
          if (currentUpdatedAt !== null && record.updatedAt < currentUpdatedAt)
            continue;
          if (
            existing &&
            currentUpdatedAt === record.updatedAt &&
            existing.record_json === serialized
          ) {
            // An exact replay is intentionally retained for retrying a provider
            // write that previously failed after the canonical DB commit.
            fanoutCandidates.push(record);
            continue;
          }
          if (
            existing &&
            sameTrackerValue(
              TrackerRecordSchema.parse(JSON.parse(existing.record_json)),
              record
            )
          )
            continue;
          // An exact replay is permitted so a previously failed provider write
          // can be retried. Equal-time but different rows lose to canonical state.
          if (
            currentUpdatedAt === record.updatedAt &&
            existing?.record_json !== serialized
          )
            continue;
          const result = await tx.exec(
            `INSERT INTO tracker_records (user_uuid, record_id, record_json, updated_at_ms) VALUES (?, ?, ?, ?) ON CONFLICT(user_uuid, record_id) DO UPDATE SET record_json = excluded.record_json, updated_at_ms = excluded.updated_at_ms WHERE excluded.updated_at_ms > tracker_records.updated_at_ms`,
            [userUuid, record.id, serialized, record.updatedAt]
          );
          accepted += result.rowCount;
          if (result.rowCount > 0 || currentUpdatedAt === record.updatedAt) {
            fanoutCandidates.push(record);
          }
        }
        for (const { adapter, authRef, generation } of adapters) {
          const providerRecords = fanoutCandidates.filter((record) => {
            if (record.origin === adapter.id) return false;
            if (record.state !== 'in_progress') return true;
            const key = `${userUuid}:${adapter.id}:${record.id}`;
            return now - (lastProviderProgressWrite.get(key) ?? 0) >= 60_000;
          });
          const enqueued = await enqueueProviderRecords(
            tx,
            userUuid,
            adapter.id,
            authRef,
            generation,
            providerRecords,
            now
          );
          if (!enqueued) staleDestination = true;
        }
      });

      if (staleDestination) {
        res.status(409).json(
          createResponse({
            success: false,
            detail: 'A tracker link changed during sync; retry the update.',
          })
        );
        return;
      }

      // Keep accepted changes retryable after transient provider failures.
      const outbox = await flushProviderOutbox(
        db,
        userUuid,
        adapters,
        providerApiFor,
        now
      );
      for (const adapterId of outbox.syncedProviders) {
        for (const record of fanoutCandidates) {
          if (record.origin === adapterId || record.state !== 'in_progress')
            continue;
          if (lastProviderProgressWrite.size >= 5_000) {
            for (const [key, writtenAt] of lastProviderProgressWrite) {
              if (now - writtenAt >= 10 * 60_000)
                lastProviderProgressWrite.delete(key);
              if (lastProviderProgressWrite.size < 4_000) break;
            }
          }
          lastProviderProgressWrite.set(
            `${userUuid}:${adapterId}:${record.id}`,
            now
          );
        }
      }
      const pendingProviders = outbox.pendingProviders;
      const providerSync = {
        synced: outbox.synced,
        skipped: outbox.skipped,
        syncedProviders: outbox.syncedProviders,
        pendingProviders,
        unsupportedProviders: unsupported,
        unsupportedWrites: outbox.unsupportedWrites,
      };
      if (pendingProviders.length) {
        res.status(503).json({
          success: false,
          detail:
            'Tracker records were saved; one or more linked tracker syncs are pending. Retry this batch.',
          data: {
            received: parsed.data.records.length,
            changed: accepted,
            providerSync,
          },
        });
        return;
      }
      res.status(200).json(
        createResponse({
          success: true,
          detail: 'Tracker records merged',
          data: {
            received: parsed.data.records.length,
            changed: accepted,
            ...(adapters.length || unsupported.length ? { providerSync } : {}),
          },
        })
      );
    } catch (error) {
      next(error);
    }
  });

  router.delete('/records/:id', async (req, res, next) => {
    try {
      const { uuid: userUuid, user } = await authenticatedAccount(req);
      const id = String(req.params.id ?? '').trim();
      if (!id || id.length > 220)
        throw new APIError(
          constants.ErrorCode.MISSING_REQUIRED_FIELDS,
          undefined,
          'A valid record id is required'
        );
      const db = dependencies.database();
      let tombstoneForProvider:
        ReturnType<typeof TrackerRecordSchema.parse> | undefined;
      // Compare-and-swap the exact value we read. Without this guard, a concurrent
      // sync POST could write a newer record between the SELECT and UPDATE and the
      // DELETE would silently replace that newer value with a stale tombstone.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const existing = await db.maybeOne<{ record_json: string }>(
          'SELECT record_json FROM tracker_records WHERE user_uuid = ? AND record_id = ?',
          [userUuid, id]
        );
        if (!existing) {
          res.status(404).json(
            createResponse({
              success: false,
              detail: 'Tracker record not found',
            })
          );
          return;
        }
        const parsed = TrackerRecordSchema.parse(
          JSON.parse(existing.record_json)
        );
        const tombstone =
          parsed.state === 'deleted'
            ? parsed
            : makeTrackerTombstone(parsed, 'aiostreams');
        tombstoneForProvider = tombstone;
        if (parsed.state === 'deleted') break;
        const result = await db.exec(
          'UPDATE tracker_records SET record_json = ?, updated_at_ms = ? WHERE user_uuid = ? AND record_id = ? AND record_json = ?',
          [
            JSON.stringify(tombstone),
            tombstone.updatedAt,
            userUuid,
            id,
            existing.record_json,
          ]
        );
        if (result.rowCount > 0) break;
        if (attempt === 3) {
          res.status(409).json(
            createResponse({
              success: false,
              detail: 'Tracker record changed concurrently; retry deletion',
            })
          );
          return;
        }
      }
      const { adapters, unsupported } = await linkedAdapters(
        userUuid,
        user,
        db
      );
      const applicable = adapters.filter(
        ({ adapter }) => adapter.id !== tombstoneForProvider?.origin
      );
      const now = Date.now();
      let staleDestination = false;
      await db.tx(async (tx) => {
        for (const { adapter, authRef, generation } of applicable) {
          const enqueued = await enqueueProviderRecords(
            tx,
            userUuid,
            adapter.id,
            authRef,
            generation,
            [tombstoneForProvider!],
            now
          );
          if (!enqueued) staleDestination = true;
        }
      });
      if (staleDestination) {
        res.status(409).json(
          createResponse({
            success: false,
            detail: 'A tracker link changed during sync; retry the deletion.',
          })
        );
        return;
      }
      const outbox = await flushProviderOutbox(
        db,
        userUuid,
        applicable,
        providerApiFor,
        now,
        true
      );
      const pendingProviders = outbox.pendingProviders;
      if (pendingProviders.length) {
        res.status(503).json({
          success: false,
          detail:
            'Tracker deletion was saved; one or more linked tracker syncs are pending. Retry this deletion.',
          data: {
            providerSync: {
              pendingProviders,
              syncedProviders: outbox.syncedProviders,
              unsupportedWrites: outbox.unsupportedWrites,
              unsupportedProviders: unsupported,
            },
          },
        });
        return;
      }
      res.status(200).json(
        createResponse({
          success: true,
          detail: 'Tracker deletion recorded',
          data: {
            ...(adapters.length || unsupported.length
              ? {
                  providerSync: {
                    syncedProviders: outbox.syncedProviders,
                    unsupportedWrites: outbox.unsupportedWrites,
                    unsupportedProviders: unsupported,
                  },
                }
              : {}),
          },
        })
      );
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createTrackerRouter();
