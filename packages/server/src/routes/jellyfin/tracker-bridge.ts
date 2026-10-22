import { randomUUID } from 'node:crypto';
import {
  getDb,
  WatchStateRepository,
  type WatchScope,
  type WatchIdentity,
  type DbDriver,
  type TrackerRecord,
  TrackerRecordSchema,
  createLogger,
  config as appConfig,
  type ContentRef,
  type PlaybackEventKind,
  type WatchStateRow,
  type JellyfinItem,
  type ListChangeInput,
} from '@aiostreams/core';
import {
  resolveLinkedAdapters,
  enqueueScrobbleEvents,
  flushScrobbleOutbox,
  defaultProviderApiFor,
  fanOutLinkedTrackerRecord,
} from '../api/tracking.js';
import type { JellyfinRequestContext } from './context.js';
import { idsFor } from './handoff.js';
import type { TrackerScrobbleEvent } from '../api/tracker-providers.js';

const logger = createLogger('jellyfin-tracker-bridge');

const BATCH_SIZE = 5000;

const TRACKER_ID_NAMESPACES = ['tmdb', 'tvdb', 'kitsu', 'mal'] as const;

function normalizeBaseId(
  ids: Record<string, string>,
  fallback: string
): string | null {
  const imdb = ids.imdb?.trim();
  if (imdb && /^tt\d+$/i.test(imdb)) return imdb.toLowerCase();
  for (const namespace of TRACKER_ID_NAMESPACES) {
    const value = ids[namespace]?.trim();
    if (value && /^\d+$/.test(value)) return `${namespace}:${value}`;
  }
  if (/^tt\d+$/i.test(fallback)) return fallback.toLowerCase();
  const prefixed = /^(tmdb|tvdb|kitsu|mal):(\d+)$/i.exec(fallback.trim());
  return prefixed ? `${prefixed[1]!.toLowerCase()}:${prefixed[2]}` : null;
}

function canonicalTrackerRecordId(
  kind: 'movie' | 'series' | 'episode',
  baseId: string,
  season?: number | null,
  episode?: number | null,
  facet?: 'rating' | 'watchlist' | 'dropped'
): string | null {
  const id = /^tt\d+$/i.test(baseId)
    ? `${kind}:imdb:${baseId.toLowerCase()}`
    : `${kind}:${baseId}`;
  if (kind === 'episode') {
    if (
      !Number.isInteger(season) ||
      season == null ||
      season < 0 ||
      !Number.isInteger(episode) ||
      episode == null ||
      episode < 0
    )
      return null;
    return `${id}:s${season}:e${episode}${facet ? `|${facet}` : ''}`;
  }
  return `${id}${facet ? `|${facet}` : ''}`;
}

function isTrackerBridgeEnabled(): boolean {
  try {
    return appConfig.jellyfin?.trackerBridgeEnabled !== false;
  } catch {
    return true;
  }
}

export function trackerRecordToWatchIdentity(
  record: TrackerRecord
): WatchIdentity | null {
  const embedded =
    /^(?:movie|series|episode):(imdb:tt\d+|(?:tmdb|tvdb|kitsu|mal):\d+)(?::|\||$)/i.exec(
      record.id
    );
  const embeddedBaseId = embedded?.[1]
    ? embedded[1].replace(/^imdb:/i, '')
    : '';
  const baseId = normalizeBaseId(record.ids || {}, embeddedBaseId);
  if (!baseId) return null;

  if (record.kind === 'movie') {
    return {
      itemKey: `m|${baseId}`,
      kind: 'movie',
      mediaType: 'movie',
      baseId,
    };
  }

  if (record.kind === 'episode') {
    const { season, episode } = record;
    if (
      !Number.isInteger(season) ||
      season == null ||
      !Number.isInteger(episode) ||
      episode == null
    )
      return null;
    const videoId = `${baseId}:${season}:${episode}`;
    return {
      itemKey: `e|${videoId}`,
      kind: 'episode',
      mediaType: 'series',
      baseId,
      season,
      episode,
      videoId,
      seriesKey: `s|${baseId}`,
    };
  }

  if (record.kind === 'series') {
    return {
      itemKey: `s|${baseId}`,
      kind: 'series',
      mediaType: 'series',
      baseId,
    };
  }

  return null;
}

/** User discovery must include deleted-only histories still pending in the feed. */
export async function getPendingTrackerBridgeUsers(
  db: DbDriver = getDb()
): Promise<string[]> {
  const rows = await db.query<{ uuid: string }>(
    `SELECT DISTINCT c.user_uuid AS uuid
       FROM tracker_record_changes c
       LEFT JOIN jellyfin_tracker_bridge_state s ON s.user_uuid = c.user_uuid
      WHERE c.change_id > COALESCE(s.checkpoint_change_id, 0)
      ORDER BY c.user_uuid`
  );
  return rows.map(({ uuid }) => uuid);
}

export async function syncTrackerRecordsToWatchState(
  scope: WatchScope,
  db: DbDriver = getDb()
): Promise<{ imported: number; skipped: number }> {
  // Linked trackers belong to the configuration's primary account. Jellyfin
  // personas have separate watch histories and must not inherit that account's
  // tracker records or send their activity into its tracker credentials.
  if (!isTrackerBridgeEnabled() || scope.persona !== '') {
    return { imported: 0, skipped: 0 };
  }

  let totalImported = 0;
  let totalSkipped = 0;
  const now = Date.now();

  try {
    await db.tx(async (txDb) => {
      // A per-account transaction lock serializes imports across replicas and
      // shares a lock namespace with the Postgres change-feed triggers.
      if (txDb.dialect === 'postgres') {
        await txDb.exec(
          'SELECT pg_advisory_xact_lock(hashtextextended(?, 901001))',
          [scope.uuid]
        );
      }
      await txDb.exec(
        `INSERT INTO jellyfin_tracker_bridge_state (user_uuid, checkpoint_change_id, updated_at_ms)
         VALUES (?, 0, ?) ON CONFLICT(user_uuid) DO NOTHING`,
        [scope.uuid, now]
      );
      const checkpointRow = await txDb.maybeOne<{
        checkpoint_change_id: number | string;
      }>(
        'SELECT checkpoint_change_id FROM jellyfin_tracker_bridge_state WHERE user_uuid = ?',
        [scope.uuid]
      );
      let lastChangeId = Number(checkpointRow?.checkpoint_change_id ?? 0);

      const quarantine = async (
        row: {
          change_id: number | string;
          record_id: string;
          record_json: string | null;
        },
        reason: string
      ) => {
        await txDb.exec(
          `INSERT INTO jellyfin_tracker_bridge_rejections
             (user_uuid, change_id, record_id, reason, record_json, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_uuid, change_id) DO NOTHING`,
          [
            scope.uuid,
            Number(row.change_id),
            row.record_id,
            reason,
            row.record_json?.slice(0, 65536) ?? null,
            now,
          ]
        );
      };

      while (true) {
        const rows = await txDb.query<{
          change_id: number | string;
          record_id: string;
          change_type: 'upsert' | 'delete';
          record_json: string | null;
          record_updated_at_ms: number | string | null;
        }>(
          `SELECT c.change_id, c.record_id, c.change_type, c.record_json,
                  c.record_updated_at_ms
         FROM tracker_record_changes c
         WHERE c.user_uuid = ? AND c.change_id > ?
         ORDER BY c.change_id ASC LIMIT ?`,
          [scope.uuid, lastChangeId, BATCH_SIZE]
        );

        if (!rows.length) break;

        // Multiple changes to the same record can accumulate while the bridge is
        // offline. Apply only the current canonical value, while advancing over
        // every durable change-feed sequence.
        const latestByRecord = new Map<string, (typeof rows)[number]>();
        for (const row of rows) latestByRecord.set(row.record_id, row);
        const batch = [...latestByRecord.values()];
        const nextChangeId = Number(rows.at(-1)!.change_id);

        const importRows: { identity: WatchIdentity; values: any }[] = [];
        const watchlistRows: { identity: WatchIdentity; at: number }[] = [];
        const droppedRows: WatchIdentity[] = [];
        const ratingRows: {
          identity: WatchIdentity;
          rating: number;
          at: number;
        }[] = [];
        const clearRows: Array<{
          identity: WatchIdentity;
          facet: 'playback' | 'watchlist' | 'dropped' | 'rating';
          externalAt: number;
        }> = [];

        for (const row of batch) {
          if (!row.record_json) {
            totalSkipped++;
            await quarantine(row, 'source_record_missing');
            continue;
          }
          let record: TrackerRecord;
          try {
            record = TrackerRecordSchema.parse(JSON.parse(row.record_json));
          } catch {
            totalSkipped++;
            await quarantine(row, 'invalid_tracker_record');
            continue;
          }

          // Jellyfin-originated records already have their authoritative local
          // watch-state write; replaying them as an external import would mark a
          // local row as an import and create a feedback loop.
          if (record.origin === 'jellyfin') continue;

          if (row.change_type === 'delete') {
            const deletedState =
              record.state === 'deleted' ? record.deletedState : record.state;
            if (
              ![
                'watched',
                'in_progress',
                'play',
                'watchlist',
                'favorite',
                'dropped',
                'rated',
              ].includes(deletedState ?? '')
            ) {
              totalSkipped++;
              await quarantine(row, 'unsupported_physical_delete');
              continue;
            }
            record = { ...record, state: 'deleted', deletedState };
          }

          const identity = trackerRecordToWatchIdentity(record);
          if (!identity) {
            totalSkipped++;
            await quarantine(row, 'unsupported_media_identity');
            continue;
          }

          const ledgerUpdatedAt = Number(row.record_updated_at_ms || now);
          const eventAt = Number(record.updatedAt);
          const updatedAt =
            Number.isSafeInteger(eventAt) && eventAt > 0
              ? eventAt
              : ledgerUpdatedAt;

          if (record.state === 'deleted') {
            switch (record.deletedState) {
              case 'watchlist':
              case 'favorite':
                clearRows.push({ identity, facet: 'watchlist', externalAt: updatedAt });
                break;
              case 'dropped':
                clearRows.push({ identity, facet: 'dropped', externalAt: updatedAt });
                break;
              case 'rated':
                clearRows.push({ identity, facet: 'rating', externalAt: updatedAt });
                break;
              case 'watched':
              case 'in_progress':
              case 'play':
                clearRows.push({ identity, facet: 'playback', externalAt: updatedAt });
                break;
              default:
                totalSkipped++;
                await quarantine(row, 'unsupported_deleted_state');
            }
          } else if (
            record.state === 'watched' ||
            record.state === 'in_progress' ||
            record.state === 'play'
          ) {
            const played = record.state === 'watched';
            const positionMs = played ? 0 : (record.positionMs ?? 0);
            const durationMs = record.durationMs ?? 0;

            importRows.push({
              identity,
              values: WatchStateRepository.importValues(scope, identity, {
                positionMs,
                durationMs,
                played,
                lastPlayedAt: played ? updatedAt : null,
                sortAt: ledgerUpdatedAt,
                externalAt: updatedAt,
                sinkId: 'merged-tracker',
                now,
              }),
            });
          } else if (
            record.state === 'watchlist' ||
            record.state === 'favorite'
          ) {
            watchlistRows.push({ identity, at: updatedAt });
          } else if (record.state === 'dropped') {
            droppedRows.push(identity);
          } else if (
            record.state === 'rated' &&
            typeof record.rating === 'number'
          ) {
            ratingRows.push({ identity, rating: record.rating, at: updatedAt });
          } else {
            totalSkipped++;
            await quarantine(row, 'unsupported_tracker_state');
          }
        }

        for (const row of clearRows) {
          await WatchStateRepository.clearImportedFacet(
            scope,
            row.identity,
            row.facet,
            'merged-tracker',
            row.externalAt,
            txDb
          );
        }

        if (importRows.length) {
          await WatchStateRepository.upsertImports(scope, importRows, txDb);
          totalImported += importRows.length;
        }
        if (watchlistRows.length) {
          await WatchStateRepository.upsertWatchlist(
            scope,
            'merged-tracker',
            watchlistRows,
            now,
            txDb
          );
          totalImported += watchlistRows.length;
        }
        if (droppedRows.length) {
          await WatchStateRepository.upsertDropped(
            scope,
            'merged-tracker',
            droppedRows,
            now,
            txDb
          );
          totalImported += droppedRows.length;
        }
        if (ratingRows.length) {
          await WatchStateRepository.upsertRatings(
            scope,
            'merged-tracker',
            ratingRows,
            now,
            txDb
          );
          totalImported += ratingRows.length;
        }

        await txDb.exec(
          `INSERT INTO jellyfin_tracker_bridge_state (user_uuid, checkpoint_change_id, updated_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT(user_uuid) DO UPDATE SET
           checkpoint_change_id = CASE
             WHEN excluded.checkpoint_change_id > jellyfin_tracker_bridge_state.checkpoint_change_id
             THEN excluded.checkpoint_change_id
             ELSE jellyfin_tracker_bridge_state.checkpoint_change_id
           END,
           updated_at_ms = excluded.updated_at_ms`,
          [scope.uuid, nextChangeId, now]
        );
        await txDb.exec(
          'DELETE FROM tracker_record_changes WHERE user_uuid = ? AND change_id <= ?',
          [scope.uuid, nextChangeId]
        );
        lastChangeId = nextChangeId;

        if (rows.length < BATCH_SIZE) break;
      }
    });
  } catch (error) {
    logger.warn(
      {
        uuid: scope.uuid,
        err: error instanceof Error ? error.message : String(error),
      },
      'failed to sync tracker records to watch state'
    );
    throw error;
  }

  return { imported: totalImported, skipped: totalSkipped };
}

export async function reportPlaybackToMergedTracker(
  ctx: JellyfinRequestContext,
  kind: PlaybackEventKind,
  ref: ContentRef,
  opts: {
    row?: WatchStateRow | null;
    item?: JellyfinItem | null;
    positionMs?: number;
    durationMs?: number;
    played?: boolean;
    sessionStartedAt?: number;
  } = {}
): Promise<void> {
  if (!isTrackerBridgeEnabled() || ctx.watch.persona !== '') return;

  const userUuid = ctx.uuid;
  const now = Date.now();
  const db = getDb();

  try {
    const rawIds = await idsFor(ctx, ref, opts.item).catch(() => ({}));
    const providerIds: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawIds)) {
      if (typeof v === 'string' && v.trim()) {
        providerIds[k.toLowerCase()] = v.trim();
      }
    }
    if (ref.baseId.startsWith('tt')) {
      providerIds['imdb'] = ref.baseId;
    } else if (ref.baseId.startsWith('tmdb:')) {
      providerIds['tmdb'] = ref.baseId.replace('tmdb:', '');
    }

    const title =
      opts.item?.Name || (ref.kind === 'movie' ? 'Movie' : 'Episode');
    const year =
      typeof opts.item?.ProductionYear === 'number'
        ? opts.item.ProductionYear
        : undefined;
    const isPlayed = Boolean(opts.played ?? opts.row?.played);
    const positionMs = opts.positionMs ?? opts.row?.positionMs ?? 0;
    const durationMs = opts.durationMs || opts.row?.durationMs || 0;
    const progress =
      durationMs > 0
        ? Math.min(100, Math.max(0, (positionMs / durationMs) * 100))
        : isPlayed
          ? 100
          : 0;

    const user = ctx.userData as any;
    const { adapters } = resolveLinkedAdapters(user);

    if (adapters.length > 0) {
      let action: 'start' | 'pause' | 'stop' = 'start';
      if (kind === 'pause') action = 'pause';
      else if (kind === 'played' || isPlayed) action = 'stop';
      else if (kind === 'start') action = 'start';

      const scrobbleEvent: TrackerScrobbleEvent = {
        eventId: randomUUID(),
        action,
        progress,
        positionMs,
        durationMs,
        media:
          ref.kind === 'movie'
            ? { kind: 'movie', title, year, ids: providerIds }
            : {
                kind: 'show',
                title,
                year,
                ids: providerIds,
                episode: {
                  season: ref.season ?? 0,
                  number: ref.episode ?? 0,
                  title: opts.item?.Name,
                },
              },
      };

      await db.tx(async (tx) => {
        await enqueueScrobbleEvents(tx, userUuid, adapters, scrobbleEvent, now);
      });

      void flushScrobbleOutbox(
        db,
        userUuid,
        adapters,
        defaultProviderApiFor,
        now
      ).catch(() => undefined);
    }

    const baseId = normalizeBaseId(providerIds, ref.baseId);
    if (!baseId || (ref.kind !== 'movie' && ref.kind !== 'episode')) return;
    const recordId = canonicalTrackerRecordId(
      ref.kind,
      baseId,
      ref.season,
      ref.episode
    );
    if (!recordId) return;

    const state = isPlayed
      ? 'watched'
      : progress > 0
        ? 'in_progress'
        : 'in_progress';

    const trackerRecord: TrackerRecord = TrackerRecordSchema.parse({
      id: recordId,
      kind: ref.kind === 'movie' ? 'movie' : 'episode',
      ids: providerIds,
      title,
      ...(ref.kind === 'episode'
        ? { season: ref.season ?? 0, episode: ref.episode ?? 0 }
        : {}),
      state,
      positionMs,
      durationMs,
      updatedAt: now,
      origin: 'jellyfin',
    });

    await db.exec(
      `INSERT INTO tracker_records (user_uuid, record_id, record_json, updated_at_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_uuid, record_id) DO UPDATE SET
         record_json = excluded.record_json,
         updated_at_ms = excluded.updated_at_ms
       WHERE excluded.updated_at_ms >= tracker_records.updated_at_ms`,
      [userUuid, recordId, JSON.stringify(trackerRecord), now]
    );
  } catch (error) {
    logger.warn(
      {
        uuid: userUuid,
        kind,
        err: error instanceof Error ? error.message : String(error),
      },
      'failed to report playback to merged tracker'
    );
  }
}

export async function reportRatingToMergedTracker(
  ctx: JellyfinRequestContext,
  ref: ContentRef,
  rating: number | null,
  item?: JellyfinItem | null
): Promise<void> {
  if (!isTrackerBridgeEnabled() || ctx.watch.persona !== '') return;

  const userUuid = ctx.uuid;
  const now = Date.now();
  const db = getDb();

  try {
    const rawIds = await idsFor(ctx, ref, item).catch(() => ({}));
    const providerIds: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawIds)) {
      if (typeof v === 'string' && v.trim()) {
        providerIds[k.toLowerCase()] = v.trim();
      }
    }
    const baseId = normalizeBaseId(providerIds, ref.baseId);
    if (!baseId || !['movie', 'series', 'episode'].includes(ref.kind)) return;
    const recordId = canonicalTrackerRecordId(
      ref.kind as 'movie' | 'series' | 'episode',
      baseId,
      ref.season,
      ref.episode,
      'rating'
    );
    if (!recordId) return;

    const title = item?.Name || (ref.kind === 'movie' ? 'Movie' : 'Series');

    const trackerRecord: TrackerRecord =
      rating === null
        ? TrackerRecordSchema.parse({
            id: recordId,
            kind:
              ref.kind === 'episode'
                ? 'episode'
                : ref.kind === 'movie'
                  ? 'movie'
                  : 'series',
            ids: providerIds,
            title,
            ...(ref.kind === 'episode'
              ? { season: ref.season, episode: ref.episode }
              : {}),
            state: 'deleted',
            deletedState: 'rated',
            updatedAt: now,
            origin: 'jellyfin',
          })
        : TrackerRecordSchema.parse({
            id: recordId,
            kind:
              ref.kind === 'episode'
                ? 'episode'
                : ref.kind === 'movie'
                  ? 'movie'
                  : 'series',
            ids: providerIds,
            title,
            ...(ref.kind === 'episode'
              ? { season: ref.season ?? 0, episode: ref.episode ?? 0 }
              : {}),
            state: 'rated',
            rating,
            updatedAt: now,
            origin: 'jellyfin',
          });
    await fanOutLinkedTrackerRecord(
      userUuid,
      ctx.userData,
      trackerRecord,
      db,
      async (tx) => {
        await tx.exec(
          `INSERT INTO tracker_records (user_uuid, record_id, record_json, updated_at_ms)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(user_uuid, record_id) DO UPDATE SET
             record_json = excluded.record_json,
             updated_at_ms = excluded.updated_at_ms
           WHERE excluded.updated_at_ms >= tracker_records.updated_at_ms`,
          [userUuid, recordId, JSON.stringify(trackerRecord), now]
        );
      }
    );
  } catch (error) {
    logger.warn(
      {
        uuid: userUuid,
        err: error instanceof Error ? error.message : String(error),
      },
      'failed to report rating to merged tracker'
    );
  }
}

export async function reportListChangeToMergedTracker(
  ctx: JellyfinRequestContext,
  kind: ListChangeInput['kind'],
  ref: ContentRef,
  item?: JellyfinItem | null
): Promise<void> {
  if (!isTrackerBridgeEnabled()) return;
  if (ctx.watch.persona !== '') return;
  if (ref.kind === 'episode') return;

  const userUuid = ctx.uuid;
  const now = Date.now();
  const db = getDb();

  try {
    const rawIds = await idsFor(ctx, ref, item).catch(() => ({}));
    const providerIds: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawIds)) {
      if (typeof v === 'string' && v.trim()) {
        providerIds[k.toLowerCase()] = v.trim();
      }
    }
    const baseId = normalizeBaseId(providerIds, ref.baseId);
    if (!baseId || !['movie', 'series'].includes(ref.kind)) return;
    const isDropped = kind === 'dropped' || kind === 'undropped';
    const isRemoval = kind === 'unwatchlisted' || kind === 'undropped';
    const targetState = isDropped ? 'dropped' : 'watchlist';
    const recordId = canonicalTrackerRecordId(
      ref.kind as 'movie' | 'series',
      baseId,
      undefined,
      undefined,
      targetState
    );
    if (!recordId) return;

    const title = item?.Name || (ref.kind === 'movie' ? 'Movie' : 'Series');

    const trackerRecord: TrackerRecord = isRemoval
      ? TrackerRecordSchema.parse({
          id: recordId,
          kind: ref.kind === 'movie' ? 'movie' : 'series',
          ids: providerIds,
          title,
          state: 'deleted',
          deletedState: targetState,
          updatedAt: now,
          origin: 'jellyfin',
        })
      : TrackerRecordSchema.parse({
          id: recordId,
          kind: ref.kind === 'movie' ? 'movie' : 'series',
          ids: providerIds,
          title,
          state: targetState,
          updatedAt: now,
          origin: 'jellyfin',
        });
    await fanOutLinkedTrackerRecord(
      userUuid,
      ctx.userData,
      trackerRecord,
      db,
      async (tx) => {
        await tx.exec(
          `INSERT INTO tracker_records (user_uuid, record_id, record_json, updated_at_ms)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(user_uuid, record_id) DO UPDATE SET
             record_json = excluded.record_json,
             updated_at_ms = excluded.updated_at_ms
           WHERE excluded.updated_at_ms >= tracker_records.updated_at_ms`,
          [userUuid, recordId, JSON.stringify(trackerRecord), now]
        );
      }
    );
  } catch (error) {
    logger.warn(
      {
        uuid: userUuid,
        err: error instanceof Error ? error.message : String(error),
      },
      'failed to report list change to merged tracker'
    );
  }
}
