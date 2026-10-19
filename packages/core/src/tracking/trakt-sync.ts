import { TrackerRecordSchema, type TrackerRecord } from './types.js';

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function epoch(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value))
    return Math.max(1, Math.floor(value < 10_000_000_000 ? value * 1000 : value));
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Math.max(1, fallback);
}

function externalIds(value: unknown): Record<string, string> {
  const source = object(value);
  return Object.fromEntries(
    Object.entries(source)
      .filter(([key, raw]) =>
        ['trakt', 'slug', 'imdb', 'tmdb', 'tvdb'].includes(key.toLowerCase()) &&
        (typeof raw === 'string' || typeof raw === 'number') &&
        String(raw).trim().length > 0
      )
      .map(([key, raw]) => [key.toLowerCase(), String(raw).trim()])
  );
}

// Must match the shared ledger's preferred identity order so Trakt records
// coalesce with WeTrakr and Nuvio instead of creating provider-specific dupes.
const ID_PRIORITY = ['imdb', 'tmdb', 'tvdb', 'trakt', 'slug'];

function canonicalId(
  kind: TrackerRecord['kind'],
  ids: Record<string, string>,
  season?: number,
  episode?: number,
  facet?: string
): string | undefined {
  const key = ID_PRIORITY.find((id) => ids[id]);
  const value = key ? `${key}:${ids[key]}` : undefined;
  if (!value) return undefined;
  const media = kind === 'episode'
    ? season !== undefined && episode !== undefined
      ? `episode:${value}:s${season}:e${episode}`
      : undefined
    : `${kind}:${value}`;
  return media ? `${media}${facet ? `|${facet}` : ''}` : undefined;
}

function record(
  item: unknown,
  state: TrackerRecord['state'],
  now: number,
  timestamp: unknown,
  facet?: string,
  extras: Partial<TrackerRecord> = {}
): TrackerRecord | null {
  const root = object(item);
  const movie = object(root.movie);
  const show = object(root.show);
  const episodeItem = object(root.episode);
  const hasEpisode = Object.keys(episodeItem).length > 0 ||
    (Number.isInteger(root.season) && Number.isInteger(root.number));
  const entity = Object.keys(movie).length
    ? movie
    : hasEpisode
      ? show
      : show;
  const kind: TrackerRecord['kind'] = Object.keys(movie).length
    ? 'movie'
    : hasEpisode
      ? 'episode'
      : Object.keys(show).length
        ? 'series'
        : 'movie';
  const ids = externalIds(entity.ids ?? root.ids);
  const season = hasEpisode ? Number(root.season ?? episodeItem.season) : undefined;
  const episode = hasEpisode ? Number(root.number ?? episodeItem.number) : undefined;
  if (kind === 'episode' && (!Number.isInteger(season) || !Number.isInteger(episode)))
    return null;
  const id = canonicalId(kind, ids, season, episode, facet);
  if (!id) return null;
  const seriesTitle = text(show.title);
  const episodeTitle = text(episodeItem.title);
  const title = kind === 'episode' ? seriesTitle : text(entity.title);
  const updatedAt = epoch(timestamp ?? root.watched_at ?? root.rated_at ?? root.listed_at, now);
  const duration = Number(entity.runtime ?? episodeItem.runtime);
  const data: Record<string, unknown> = {
    id,
    kind,
    ids,
    state,
    updatedAt,
    origin: 'trakt',
    ...(title ? { title } : {}),
    ...(seriesTitle ? { seriesTitle } : {}),
    ...(episodeTitle ? { episodeTitle } : {}),
    ...(season !== undefined ? { season } : {}),
    ...(episode !== undefined ? { episode } : {}),
    ...(Number.isFinite(duration) && duration > 0
      ? { durationMs: Math.round(duration * 60_000) }
      : {}),
    ...extras,
  };
  const parsed = TrackerRecordSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

export type TraktSnapshotPayloads = {
  history?: unknown[];
  watchlistMovies?: unknown[];
  watchlistShows?: unknown[];
  ratingsMovies?: unknown[];
  ratingsShows?: unknown[];
  playback?: unknown[];
};

/** Converts Trakt's native snapshot responses into provider-neutral canonical records. */
export function mapTraktSnapshot(
  payloads: TraktSnapshotPayloads,
  now = Date.now()
): TrackerRecord[] {
  const byId = new Map<string, TrackerRecord>();
  const add = (candidate: TrackerRecord | null) => {
    if (!candidate) return;
    const current = byId.get(candidate.id);
    if (!current || candidate.updatedAt > current.updatedAt)
      byId.set(candidate.id, candidate);
  };

  for (const row of payloads.history ?? []) {
    const root = object(row);
    const media = Object.keys(object(root.movie)).length
      ? { movie: root.movie }
      : { show: root.show, episode: root.episode, season: root.season, number: root.number };
    add(record(media, 'watched', now, root.watched_at));
  }
  for (const row of payloads.watchlistMovies ?? []) {
    const root = object(row);
    add(record({ movie: root.movie }, 'watchlist', now, root.listed_at, 'watchlist'));
  }
  for (const row of payloads.watchlistShows ?? []) {
    const root = object(row);
    add(record({ show: root.show }, 'watchlist', now, root.listed_at, 'watchlist'));
  }
  for (const [rows, kind] of [
    [payloads.ratingsMovies ?? [], 'movie'],
    [payloads.ratingsShows ?? [], 'show'],
  ] as const) {
    for (const row of rows) {
      const root = object(row);
      const entity = object(root[kind]);
      const rating = Number(root.rating);
      add(record(
        { [kind]: entity },
        'rated',
        now,
        root.rated_at,
        'rated',
        Number.isFinite(rating) ? { rating } : {}
      ));
    }
  }
  for (const row of payloads.playback ?? []) {
    const root = object(row);
    const media = Object.keys(object(root.movie)).length
      ? { movie: root.movie }
      : { show: root.show, episode: root.episode, season: root.season, number: root.number };
    const base = record(media, 'in_progress', now, root.paused_at, 'progress');
    if (!base) continue;
    const percent = Number(root.progress);
    const durationMs = base.durationMs;
    add({
      ...base,
      ...(Number.isFinite(percent) && durationMs !== undefined
        ? { positionMs: Math.max(0, Math.min(durationMs, Math.round(durationMs * percent / 100))) }
        : {}),
    });
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export type TraktWriteOperation = {
  path: '/sync/history' | '/sync/history/remove' | '/sync/ratings' |
    '/sync/ratings/remove' | '/sync/watchlist' | '/sync/watchlist/remove';
  body: Record<string, unknown>;
  recordIds: string[];
};

/** Maps only states Trakt's Sync API can represent without inventing a facet. */
export function planTraktWrites(records: TrackerRecord[]): {
  operations: TraktWriteOperation[];
  skipped: number;
} {
  const groups = new Map<string, TraktWriteOperation>();
  let skipped = 0;

  for (const record of records) {
    const state = record.state === 'deleted' ? record.deletedState : record.state;
    // Live progress is sent through Trakt's scrobble lifecycle by the dedicated
    // /scrobble endpoint. Replaying a periodic ledger snapshot as "pause" would
    // incorrectly pause a title that is still playing.
    if (state === 'in_progress' && record.state !== 'deleted') continue;
    if (!state || !['watched', 'watchlist', 'rated'].includes(state)) {
      skipped++;
      continue;
    }
    const removing = record.state === 'deleted';
    const path = state === 'watched'
      ? removing ? '/sync/history/remove' : '/sync/history'
      : state === 'watchlist'
        ? removing ? '/sync/watchlist/remove' : '/sync/watchlist'
        : removing ? '/sync/ratings/remove' : '/sync/ratings';
    const key = path;
    let operation = groups.get(key);
    if (!operation) {
      operation = { path, body: {}, recordIds: [] };
      groups.set(key, operation);
    }
    const ids = externalIds(record.ids);
    if (!Object.keys(ids).length) {
      skipped++;
      continue;
    }
    if (record.kind === 'movie') {
      const field = 'movies';
      const entries = (operation.body[field] as unknown[] | undefined) ?? [];
      entries.push({ ids, ...(state === 'rated' && record.rating !== undefined ? { rating: Math.max(1, Math.min(10, Math.round(record.rating))) } : {}) });
      operation.body[field] = entries;
    } else if (record.kind === 'series') {
      const entries = (operation.body.shows as unknown[] | undefined) ?? [];
      entries.push({ ids, ...(state === 'rated' && record.rating !== undefined ? { rating: Math.max(1, Math.min(10, Math.round(record.rating))) } : {}) });
      operation.body.shows = entries;
    } else if (record.kind === 'episode' && record.season !== undefined && record.episode !== undefined && state !== 'rated') {
      const entries = (operation.body.shows as Array<Record<string, unknown>> | undefined) ?? [];
      let show = entries.find((entry) => JSON.stringify(entry.ids) === JSON.stringify(ids));
      if (!show) {
        show = { ids, seasons: [] };
        entries.push(show);
      }
      const seasons = show.seasons as Array<Record<string, unknown>>;
      let season = seasons.find((entry) => entry.number === record.season);
      if (!season) {
        season = { number: record.season, episodes: [] };
        seasons.push(season);
      }
      (season.episodes as unknown[]).push({ number: record.episode });
      operation.body.shows = entries;
    } else {
      skipped++;
      continue;
    }
    operation.recordIds.push(record.id);
  }
  return { operations: [...groups.values()].filter((operation) => operation.recordIds.length > 0), skipped };
}
