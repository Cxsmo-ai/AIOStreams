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
} from '../api/tracking.js';
import type { JellyfinRequestContext } from './context.js';
import { idsFor } from './handoff.js';
import type { TrackerScrobbleEvent } from '../api/tracker-providers.js';

const logger = createLogger('jellyfin-tracker-bridge');

const BRIDGE_PROVIDER_ID = 'jellyfin-watch-state-bridge';
const BATCH_SIZE = 5000;

export function trackerRecordToWatchIdentity(
  record: TrackerRecord
): WatchIdentity | null {
  const ids = record.ids || {};
  const imdbId =
    ids.imdb ||
    (record.id.includes(':imdb:')
      ? record.id.split(':imdb:')[1].split(':')[0]
      : null);
  const baseId =
    imdbId ||
    (ids.tmdb ? `tmdb:${ids.tmdb}` : null) ||
    (ids.tvdb ? `tvdb:${ids.tvdb}` : null) ||
    (ids.kitsu ? `kitsu:${ids.kitsu}` : null) ||
    (ids.mal ? `mal:${ids.mal}` : null);

  if (record.kind === 'movie') {
    const id =
      baseId ||
      (record.id.startsWith('movie:') ? record.id.split(':')[2] : record.id);
    if (!id) return null;
    return {
      itemKey: `m|${id}`,
      kind: 'movie',
      mediaType: 'movie',
      baseId: id,
    };
  }

  if (record.kind === 'episode') {
    const seriesId =
      baseId ||
      (record.id.startsWith('episode:') ? record.id.split(':')[2] : null);
    if (!seriesId) return null;
    const season = record.season ?? 0;
    const episode = record.episode ?? 0;
    const videoId = `${seriesId}:${season}:${episode}`;
    return {
      itemKey: `e|${videoId}`,
      kind: 'episode',
      mediaType: 'series',
      baseId: seriesId,
      season,
      episode,
      videoId,
      seriesKey: `s|${seriesId}`,
    };
  }

  if (record.kind === 'series') {
    const id =
      baseId ||
      (record.id.startsWith('series:') ? record.id.split(':')[2] : record.id);
    if (!id) return null;
    return {
      itemKey: `s|${id}`,
      kind: 'series',
      mediaType: 'series',
      baseId: id,
    };
  }

  return null;
}

export async function syncTrackerRecordsToWatchState(
  scope: WatchScope,
  db: DbDriver = getDb()
): Promise<{ imported: number; skipped: number }> {
  if (appConfig.jellyfin.trackerBridgeEnabled === false) {
    return { imported: 0, skipped: 0 };
  }

  let totalImported = 0;
  let totalSkipped = 0;
  const now = Date.now();

  try {
    const checkpointRow = await db
      .maybeOne<{ checkpoint_at_ms: number | string }>(
        'SELECT checkpoint_at_ms FROM tracker_provider_sync_state WHERE user_uuid = ? AND provider_id = ?',
        [scope.uuid, BRIDGE_PROVIDER_ID]
      )
      .catch(() => null);

    let lastCheckpoint = Number(checkpointRow?.checkpoint_at_ms ?? 0);

    while (true) {
      const rows = await db.query<{
        record_id: string;
        record_json: string;
        updated_at_ms: number | string;
      }>(
        'SELECT record_id, record_json, updated_at_ms FROM tracker_records WHERE user_uuid = ? AND updated_at_ms > ? ORDER BY updated_at_ms ASC LIMIT ?',
        [scope.uuid, lastCheckpoint, BATCH_SIZE]
      );

      if (!rows.length) break;

      const importRows: { identity: WatchIdentity; values: any }[] = [];
      const watchlistRows: { identity: WatchIdentity; at: number }[] = [];
      const droppedRows: WatchIdentity[] = [];
      const ratingRows: { identity: WatchIdentity; rating: number; at: number }[] = [];

      for (const row of rows) {
        let record: TrackerRecord;
        try {
          record = JSON.parse(row.record_json) as TrackerRecord;
        } catch {
          totalSkipped++;
          continue;
        }

        const identity = trackerRecordToWatchIdentity(record);
        if (!identity) {
          totalSkipped++;
          continue;
        }

        const updatedAt = Number(record.updatedAt || row.updated_at_ms || now);

        if (record.state === 'watched' || record.state === 'in_progress') {
          const played = record.state === 'watched';
          const positionMs = played ? 0 : (record.positionMs ?? 0);
          const durationMs = record.durationMs ?? 0;

          importRows.push({
            identity,
            values: WatchStateRepository.importValues(scope, identity, {
              positionMs,
              durationMs,
              played,
              lastPlayedAt: updatedAt,
              sortAt: updatedAt,
              externalAt: updatedAt,
              sinkId: 'merged-tracker',
              now,
            }),
          });
        } else if (record.state === 'watchlist' || record.state === 'favorite') {
          watchlistRows.push({ identity, at: updatedAt });
        } else if (record.state === 'dropped') {
          droppedRows.push(identity);
        } else if (record.state === 'rated' && typeof record.rating === 'number') {
          ratingRows.push({ identity, rating: record.rating, at: updatedAt });
        } else {
          totalSkipped++;
        }

        const rowUpdated = Number(row.updated_at_ms);
        if (rowUpdated > lastCheckpoint) {
          lastCheckpoint = rowUpdated;
        }
      }

      if (importRows.length) {
        await WatchStateRepository.upsertImports(scope, importRows, db);
        totalImported += importRows.length;
      }
      if (watchlistRows.length) {
        await WatchStateRepository.upsertWatchlist(
          scope,
          'merged-tracker',
          watchlistRows,
          now,
          db
        );
        totalImported += watchlistRows.length;
      }
      if (droppedRows.length) {
        await WatchStateRepository.upsertDropped(
          scope,
          'merged-tracker',
          droppedRows,
          now,
          db
        );
        totalImported += droppedRows.length;
      }
      if (ratingRows.length) {
        await WatchStateRepository.upsertRatings(
          scope,
          'merged-tracker',
          ratingRows,
          now,
          db
        );
        totalImported += ratingRows.length;
      }

      await db.exec(
        `INSERT INTO tracker_provider_sync_state (user_uuid, provider_id, checkpoint_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_uuid, provider_id) DO UPDATE SET
           checkpoint_at_ms = excluded.checkpoint_at_ms,
           updated_at_ms = excluded.updated_at_ms`,
        [scope.uuid, BRIDGE_PROVIDER_ID, lastCheckpoint, now]
      );

      if (rows.length < BATCH_SIZE) break;
    }
  } catch (error) {
    logger.warn(
      {
        uuid: scope.uuid,
        err: error instanceof Error ? error.message : String(error),
      },
      'failed to sync tracker records to watch state'
    );
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
  if (appConfig.jellyfin.trackerBridgeEnabled === false) return;

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

    const user = (ctx.userData as any);
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

    const primaryId =
      providerIds['imdb'] ||
      (providerIds['tmdb'] ? `tmdb:${providerIds['tmdb']}` : ref.baseId);
    const recordId =
      ref.kind === 'movie'
        ? `movie:imdb:${primaryId}`
        : `episode:imdb:${primaryId}:s${ref.season ?? 0}:e${ref.episode ?? 0}`;

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

    await db.exec(
      `INSERT INTO tracker_provider_sync_state (user_uuid, provider_id, checkpoint_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_uuid, provider_id) DO UPDATE SET
         checkpoint_at_ms = CASE WHEN excluded.checkpoint_at_ms > tracker_provider_sync_state.checkpoint_at_ms THEN excluded.checkpoint_at_ms ELSE tracker_provider_sync_state.checkpoint_at_ms END,
         updated_at_ms = excluded.updated_at_ms`,
      [userUuid, BRIDGE_PROVIDER_ID, now, now]
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
  if (appConfig.jellyfin.trackerBridgeEnabled === false) return;

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
    const primaryId =
      providerIds['imdb'] ||
      (providerIds['tmdb'] ? `tmdb:${providerIds['tmdb']}` : ref.baseId);
    const recordId =
      ref.kind === 'movie'
        ? `movie:imdb:${primaryId}|rating`
        : ref.kind === 'series'
        ? `series:imdb:${primaryId}|rating`
        : `episode:imdb:${primaryId}:s${ref.season ?? 0}:e${ref.episode ?? 0}|rating`;

    const title =
      item?.Name || (ref.kind === 'movie' ? 'Movie' : 'Series');

    if (rating === null) {
      const tombstone: TrackerRecord = TrackerRecordSchema.parse({
        id: recordId,
        kind:
          ref.kind === 'episode'
            ? 'episode'
            : ref.kind === 'movie'
            ? 'movie'
            : 'series',
        ids: providerIds,
        title,
        state: 'deleted',
        deletedState: 'rated',
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
        [userUuid, recordId, JSON.stringify(tombstone), now]
      );
    } else {
      const trackerRecord: TrackerRecord = TrackerRecordSchema.parse({
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
      await db.exec(
        `INSERT INTO tracker_records (user_uuid, record_id, record_json, updated_at_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_uuid, record_id) DO UPDATE SET
           record_json = excluded.record_json,
           updated_at_ms = excluded.updated_at_ms
         WHERE excluded.updated_at_ms >= tracker_records.updated_at_ms`,
        [userUuid, recordId, JSON.stringify(trackerRecord), now]
      );
    }
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
  if (appConfig.jellyfin.trackerBridgeEnabled === false) return;
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
    const primaryId =
      providerIds['imdb'] ||
      (providerIds['tmdb'] ? `tmdb:${providerIds['tmdb']}` : ref.baseId);
    const isDropped = kind === 'dropped' || kind === 'undropped';
    const isRemoval = kind === 'unwatchlisted' || kind === 'undropped';
    const targetState = isDropped ? 'dropped' : 'watchlist';
    const recordId =
      ref.kind === 'movie'
        ? `movie:imdb:${primaryId}|${targetState}`
        : `series:imdb:${primaryId}|${targetState}`;

    const title =
      item?.Name || (ref.kind === 'movie' ? 'Movie' : 'Series');

    if (isRemoval) {
      const tombstone: TrackerRecord = TrackerRecordSchema.parse({
        id: recordId,
        kind: ref.kind === 'movie' ? 'movie' : 'series',
        ids: providerIds,
        title,
        state: 'deleted',
        deletedState: targetState,
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
        [userUuid, recordId, JSON.stringify(tombstone), now]
      );
    } else {
      const trackerRecord: TrackerRecord = TrackerRecordSchema.parse({
        id: recordId,
        kind: ref.kind === 'movie' ? 'movie' : 'series',
        ids: providerIds,
        title,
        state: targetState,
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
    }
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

