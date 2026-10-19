import { TrackerRecordSchema, type TrackerRecord } from './types.js';

const FLOPPY_MEDIA_TYPES = ['movie', 'tv', 'anime', 'season', 'episode'] as const;
const PAGE_SIZE = 200;
const MAX_PAGES = 100;
type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim() || undefined
    : undefined;
}

function timestamp(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0)
      return Math.floor(value < 10_000_000_000 ? value * 1000 : value);
    if (typeof value === 'string' && value.trim()) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return Date.now();
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizeIds(
  rawIds: unknown,
  source?: string,
  mediaId?: string
): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const [key, value] of Object.entries(object(rawIds))) {
    const normalized = text(value);
    if (normalized) ids[key.toLowerCase()] = normalized;
  }
  if (source && mediaId) ids[source.toLowerCase()] ??= mediaId;
  return ids;
}

function canonicalId(ids: Record<string, string>, source: string, mediaId: string): string {
  const priority = ['imdb', 'tmdb', 'tvdb', 'mal', 'anilist', 'kitsu', 'trakt'];
  const key = priority.find((candidate) => ids[candidate]);
  return key ? `${key}:${ids[key]}` : `${source}:${mediaId}`;
}

function statusState(value: unknown): TrackerRecord['state'] | undefined {
  switch (String(value).toLowerCase()) {
    case '0':
    case 'planning':
      return 'watchlist';
    case '1':
    case 'in progress':
    case 'in_progress':
    case 'watching':
      return 'in_progress';
    case '2':
    case 'paused':
      return 'paused';
    case '3':
    case 'completed':
    case 'complete':
      return 'watched';
    case '4':
    case 'dropped':
      return 'dropped';
    default:
      return undefined;
  }
}

function mediaKind(type: string): TrackerRecord['kind'] {
  if (type === 'movie') return 'movie';
  if (type === 'episode') return 'episode';
  return 'series';
}

function mediaRecords(value: unknown, fallbackType: string): TrackerRecord[] {
  const row = object(value);
  const item = object(row.item);
  const type = text(item.media_type ?? item.type ?? row.media_type) ?? fallbackType;
  // Floppy emits an empty top-level `source` for some library rows while the
  // canonical source remains populated on the nested media item. Nullish
  // coalescing would keep the empty string and incorrectly reject the row.
  const source = text(row.source) ?? text(item.source);
  const mediaId = text(row.item_id ?? item.media_id ?? item.id);
  if (!source || !mediaId) throw new Error('Floppy library item is missing its provider identity');

  const ids = normalizeIds(item.ids ?? row.ids, source, mediaId);
  const primary = `${mediaKind(type)}:${canonicalId(ids, source, mediaId)}`;
  const season = positiveInteger(row.season_number ?? item.season_number);
  const episode = positiveInteger(row.episode_number ?? item.episode_number);
  const isEpisode = type === 'episode' || (season !== undefined && episode !== undefined);
  const kind: TrackerRecord['kind'] = isEpisode ? 'episode' : mediaKind(type);
  const identity = isEpisode
    ? `${primary}:s${season ?? 0}e${episode ?? 0}`
    : primary;
  const state = statusState(row.status);
  // Floppy's library row has separate dates for progress and completion.
  // For a completed item, end_date is the watch date; progressed_at can be
  // newer (for example after an edit/import) and must not replace it.
  const statusUpdatedAt = state === 'watched'
    ? timestamp(
        row.end_date,
        item.end_date,
        row.progressed_at,
        item.progressed_at,
        row.updated_at,
        row.created_at,
        row.start_date
      )
    : timestamp(
        row.progressed_at,
        item.progressed_at,
        row.updated_at,
        row.created_at,
        item.updated_at,
        row.start_date,
        row.end_date
      );
  const title = text(item.title ?? row.title);
  const seriesTitle = text(item.series_title ?? item.parent_title ?? row.series_title);
  const base = {
    kind,
    ids,
    ...(title ? { title } : {}),
    ...(seriesTitle ? { seriesTitle } : {}),
    ...(season !== undefined ? { season } : {}),
    ...(episode !== undefined ? { episode } : {}),
    providerId: `${type}:${source}:${mediaId}`,
    providerIdProvider: 'floppy',
    updatedAt: statusUpdatedAt,
    origin: 'floppy',
    revision: 0,
  };
  const records: TrackerRecord[] = [];
  if (state) {
    records.push(
      TrackerRecordSchema.parse({ ...base, id: `${identity}|status`, state })
    );
  }
  const rating = Number(row.score ?? item.score);
  if (Number.isFinite(rating) && rating >= 0 && rating <= 10) {
    records.push(
      TrackerRecordSchema.parse({
        ...base,
        id: `${identity}|rating`,
        state: 'rated',
        rating,
        updatedAt: timestamp(row.scored_at, row.rating_updated_at, row.updated_at, row.created_at),
      })
    );
  }
  const notes = text(row.notes);
  if (notes) {
    records.push(
      TrackerRecordSchema.parse({
        ...base,
        id: `${identity}|note`,
        state: 'note',
        text: notes.slice(0, 10_000),
      })
    );
  }
  const lists = Array.isArray(row.lists)
    ? row.lists
    : Array.isArray(item.lists)
      ? item.lists
      : [];
  for (const listValue of lists) {
    const list = object(listValue);
    const listId = text(list.id ?? list.list_id);
    if (!listId) continue;
    records.push(
      TrackerRecordSchema.parse({
        ...base,
        id: `${identity}|list:${listId}`,
        state: 'list',
        listId,
        listIdProvider: 'floppy',
        ...(text(list.name ?? list.title) ? { listName: text(list.name ?? list.title) } : {}),
        ...(positiveInteger(list.position ?? list.rank) !== undefined
          ? { listRank: positiveInteger(list.position ?? list.rank) }
          : {}),
        updatedAt: timestamp(list.updated_at, row.updated_at, row.created_at),
      })
    );
  }
  return records;
}

function playbackRecords(value: unknown): TrackerRecord[] {
  const row = object(value);
  const mediaType = text(row.media_type);
  if (mediaType !== 'movie' && mediaType !== 'episode') return [];
  const ids = normalizeIds(row.ids, text(row.source), text(row.media_id));
  const source = text(row.source) ?? Object.keys(ids)[0];
  const mediaId = text(row.media_id) ?? (source ? ids[source] : undefined);
  if (!source || !mediaId) throw new Error('Floppy playback item is missing its provider identity');
  const positionMs = Number(row.position_seconds) * 1000;
  const durationMs = Number(row.duration_seconds) * 1000;
  if (!Number.isFinite(positionMs) || positionMs < 0 || positionMs > 31_536_000_000)
    throw new Error('Floppy returned an invalid playback position');
  const season = positiveInteger(row.season_number);
  const episode = positiveInteger(row.episode_number);
  if (mediaType === 'episode' && (season === undefined || episode === undefined))
    throw new Error('Floppy episode progress is missing its season or episode number');
  const identity = `${mediaType}:${canonicalId(ids, source, mediaId)}${mediaType === 'episode' ? `:s${season}e${episode}` : ''}`;
  const record = {
    id: `${identity}|resume`,
    kind: mediaType === 'movie' ? 'movie' as const : 'episode' as const,
    ids,
    ...(text(row.title) ? { title: text(row.title) } : {}),
    ...(text(row.series_title) ? { seriesTitle: text(row.series_title) } : {}),
    ...(season !== undefined ? { season } : {}),
    ...(episode !== undefined ? { episode } : {}),
    state: row.completed === true ? 'watched' as const : 'in_progress' as const,
    positionMs: Math.floor(positionMs),
    ...(Number.isFinite(durationMs) && durationMs > 0 && durationMs <= 31_536_000_000
      ? { durationMs: Math.floor(durationMs) }
      : {}),
    providerId: `${mediaType}:${source}:${mediaId}`,
    providerIdProvider: 'floppy',
    updatedAt: timestamp(row.updated_at),
    origin: 'floppy',
    revision: 0,
  };
  return [TrackerRecordSchema.parse(record)];
}

function historyRecords(value: unknown): TrackerRecord[] {
  const row = object(value);
  const item = object(row.item ?? row.media);
  const type = text(row.media_type ?? item.media_type ?? item.type) ?? 'movie';
  const source = text(row.source) ?? text(item.source);
  const mediaId = text(row.media_id ?? row.item_id ?? item.media_id ?? item.id);
  const playId = text(row.consumption_id ?? row.history_id ?? row.id ?? row.entry_key);
  if (!source || !mediaId || !playId)
    throw new Error('Floppy history entry is missing its identity');
  const ids = normalizeIds(item.ids ?? row.ids, source, mediaId);
  const season = positiveInteger(row.season_number ?? item.season_number);
  const episode = positiveInteger(row.episode_number ?? item.episode_number);
  const isEpisode = type === 'episode' || (season !== undefined && episode !== undefined);
  const kind: TrackerRecord['kind'] = isEpisode ? 'episode' : mediaKind(type);
  const base = `${mediaKind(type)}:${canonicalId(ids, source, mediaId)}`;
  return [
    TrackerRecordSchema.parse({
      id: `${base}${isEpisode ? `:s${season ?? 0}e${episode ?? 0}` : ''}|play:${playId}`,
      kind,
      ids,
      ...(text(item.title ?? row.title) ? { title: text(item.title ?? row.title) } : {}),
      ...(text(item.series_title ?? row.series_title)
        ? { seriesTitle: text(item.series_title ?? row.series_title) }
        : {}),
      ...(season !== undefined ? { season } : {}),
      ...(episode !== undefined ? { episode } : {}),
      state: 'play',
      providerId: `${type}:${source}:${mediaId}:${playId}`,
      providerIdProvider: 'floppy',
      updatedAt: timestamp(
        row.end_date,
        row.played_at_local,
        row.played_at,
        row.watched_at,
        row.progressed_at,
        row.created_at,
        row.created,
        row.updated_at
      ),
      origin: 'floppy',
      revision: 0,
    }),
  ];
}

export type FloppySnapshotRequest = (
  path: string
) => Promise<{ data: unknown; headers?: Headers }>;

function snapshotFailure(error: unknown, endpoint: string): Error {
  const candidate = error && typeof error === 'object'
    ? error as { message?: unknown; name?: unknown; status?: unknown; reason?: unknown; errorName?: unknown }
    : {};
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  const status = Number(candidate.status);
  const errorName = typeof candidate.errorName === 'string'
    ? candidate.errorName
    : typeof candidate.name === 'string'
      ? candidate.name
      : undefined;
  let reason = typeof candidate.reason === 'string' ? candidate.reason : undefined;
  if (!reason) {
    if (Number.isInteger(status) && status >= 400 && status <= 599)
      reason = `upstream_http_${status}`;
    else if (/exceeded (the )?allowed size/i.test(message)) reason = 'response_too_large';
    else if (/exceeded the safe pagination limit/i.test(message)) reason = 'pagination_limit';
    else if (errorName === 'AbortError' || errorName === 'TimeoutError') reason = 'timeout';
    else if (errorName === 'TypeError') reason = 'upstream_transport_error';
    else reason = 'invalid_upstream_response';
  }
  return Object.assign(new Error('Floppy snapshot failed'), {
    ...(Number.isInteger(status) && status >= 400 && status <= 599 ? { status } : {}),
    ...(reason ? { reason } : {}),
    ...(errorName ? { errorName } : {}),
    endpoint,
  });
}

async function atSnapshotEndpoint<T>(
  endpoint: string,
  read: () => Promise<T>
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw snapshotFailure(error, endpoint);
  }
}

function parseSnapshotEndpoint<T>(endpoint: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw snapshotFailure(error, endpoint);
  }
}

async function fetchPages(
  request: FloppySnapshotRequest,
  path: string
): Promise<unknown[]> {
  const result: unknown[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
    const response = await request(`${path}${path.includes('?') ? '&' : '?'}${query}`);
    const data = response.data;
    const entries = Array.isArray(data) ? data : object(data).results;
    if (!Array.isArray(entries)) throw new Error(`Floppy ${path} response was not a list`);
    result.push(...entries);
    const pagination = object(object(data).pagination);
    const count = Number(pagination.count ?? pagination.total ?? pagination.item_count);
    if (Number.isFinite(count) && count >= 0 && result.length >= count) return result;
    if (entries.length < PAGE_SIZE) return result;
  }
  throw new Error(`Floppy ${path} exceeded the safe pagination limit`);
}

/** Complete snapshot; any failed list aborts the snapshot so omissions never delete ledger data. */
export async function fetchFloppySnapshot(
  request: FloppySnapshotRequest
): Promise<TrackerRecord[]> {
  const groups = await Promise.all(
    FLOPPY_MEDIA_TYPES.map(async (type) => ({
      type,
      entries: await atSnapshotEndpoint(`floppy_media_${type}`, () =>
        fetchPages(request, `/api/v1/media/${type}/`)
      ),
    }))
  );
  const records = groups.flatMap(({ type, entries }) =>
    parseSnapshotEndpoint(`floppy_media_${type}`, () =>
      entries.flatMap((entry) => mediaRecords(entry, type))
    )
  );
  const playback = await atSnapshotEndpoint('floppy_playback_progress', () =>
    fetchPages(request, '/api/v1/playback/progress/?media_type=movie%2Cepisode')
  );
  records.push(...parseSnapshotEndpoint('floppy_playback_progress', () =>
    playback.flatMap(playbackRecords)
  ));
  const history = await atSnapshotEndpoint('floppy_history', () =>
    fetchPages(request, '/api/v1/history/?flat=1')
  );
  records.push(...parseSnapshotEndpoint('floppy_history', () =>
    history.flatMap(historyRecords)
  ));
  const unique = new Map<string, TrackerRecord>();
  for (const record of records) {
    const current = unique.get(record.id);
    if (!current || record.updatedAt > current.updatedAt)
      unique.set(record.id, record);
  }
  return [...unique.values()];
}

export function floppyMediaRecordsForTest(value: unknown, type: string) {
  return mediaRecords(value, type);
}

export function floppyPlaybackRecordsForTest(value: unknown) {
  return playbackRecords(value);
}

export function floppyHistoryRecordsForTest(value: unknown) {
  return historyRecords(value);
}
