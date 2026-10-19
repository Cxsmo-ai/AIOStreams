import {
  fetchWeTrakrAccountSnapshot,
  fetchWeTrakrJournalDelta,
  pushWeTrakrRecords,
  mapTraktSnapshot,
  planTraktWrites,
  requestTraktApi,
  requestWeTrakrApi,
  fetchFloppySnapshot,
  requestFloppyApi,
  type TrackerRecord,
} from '@aiostreams/core';

export type TrackerProviderLink = {
  authRef?: string;
  enabled?: boolean;
  baseUrl?: string;
};

export type TrackerProviderApiRequest = (
  authRef: string,
  path: string,
  init: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    idempotencyKey?: string;
  }
) => Promise<{ data: unknown; headers?: Headers }>;

export type TrackerScrobbleEvent = {
  /** Stable caller-generated event identity for idempotent provider writes. */
  eventId: string;
  action: 'start' | 'pause' | 'stop';
  progress: number;
  positionMs?: number;
  durationMs?: number;
  media: {
    kind: 'movie' | 'show';
    title?: string;
    year?: number;
    ids: Record<string, string>;
    episode?: { season: number; number: number; title?: string };
  };
};

export type TrackerScrobbleResult = void | {
  status: 'ignored';
  reason?: string;
};

function ignoredScrobbleResult(data: unknown): TrackerScrobbleResult {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  const response = data as Record<string, unknown>;
  if (response.ignored !== true) return;
  const reason =
    typeof response.reason === 'string'
      ? response.reason
          .replace(/[\u0000-\u001f\u007f]/g, ' ')
          .replace(/\b(?:bearer\s+)?[A-Za-z0-9_-]{32,}\b/gi, '[redacted]')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 240)
      : '';
  return { status: 'ignored', ...(reason ? { reason } : {}) };
}

export type TrackerProviderDelta = {
  records: TrackerRecord[];
  checkpoint: string;
};

export type TrackerProviderSnapshot = {
  records: TrackerRecord[];
  /** Non-empty failures mean the records are useful but not authoritative. */
  failures: Array<{
    /** Internal retry key; the HTTP API deliberately omits it. */
    facetId?: string;
    status?: number;
    providerCode?: 'PRIVATE' | 'FRIENDS_ONLY' | 'COMMENTS_DISABLED';
    endpoint?: string;
    reason?:
      | 'invalid_history_cursor'
      | 'history_cursor_limit'
      | 'pagination_limit'
      | 'response_too_large'
      | 'invalid_upstream_response';
    errorName?: 'AbortError' | 'TimeoutError' | 'TypeError';
  }>;
  /** Provider facets fully acquired by this response. */
  completedFacets?: string[];
  /** False when only incomplete facets were retried or some were skipped. */
  authoritative?: boolean;
};

export interface TrackerProviderAdapter {
  readonly id: string;
  /** Provider-owned API transport/auth resolver; authRef remains opaque to the hub. */
  readonly requestApi?: TrackerProviderApiRequest;
  /**
   * `journal` providers return ordered deltas and a source checkpoint.
   * `snapshot` providers return their complete, authoritative current state on
   * every refresh; the server computes additions, edits, and removals.
   */
  readonly syncMode?: 'journal' | 'snapshot';
  /** Retry incomplete facets on each refresh while retaining successful ones. */
  readonly retryIncompleteSnapshotFacets?: boolean;
  pushRecords(
    authRef: string,
    records: TrackerRecord[],
    requestApi: TrackerProviderApiRequest
  ): Promise<{ synced: number; skipped: number }>;
  /**
   * Optional per-record write path for APIs where one invalid media item must
   * not hold an entire durable batch hostage. `false` means unsupported.
   */
  pushRecord?(
    authRef: string,
    record: TrackerRecord,
    requestApi: TrackerProviderApiRequest
  ): Promise<boolean>;
  scrobble(
    authRef: string,
    event: TrackerScrobbleEvent,
    requestApi: TrackerProviderApiRequest
  ): Promise<TrackerScrobbleResult>;
  removeRecord?(
    authRef: string,
    record: TrackerRecord,
    requestApi: TrackerProviderApiRequest
  ): Promise<void>;
  pullSnapshot?(
    authRef: string,
    requestApi: TrackerProviderApiRequest,
    options?: { completedFacets?: readonly string[] }
  ): Promise<TrackerRecord[] | TrackerProviderSnapshot>;
  pullChanges?(
    authRef: string,
    checkpoint: string,
    requestApi: TrackerProviderApiRequest
  ): Promise<TrackerProviderDelta>;
}

/** WeTrakr's API contract is isolated behind the same adapter boundary used by other trackers. */
export const weTrakrTrackerAdapter: TrackerProviderAdapter = {
  id: 'wetrakr',
  syncMode: 'journal',
  retryIncompleteSnapshotFacets: true,

  async pushRecords(authRef, records, requestApi) {
    const safeRecords = records.filter((record) => {
      const deletingProviderComment =
        record.state === 'deleted' && record.deletedState === 'comment';
      const mutatingProviderReaction =
        record.state === 'liked' ||
        (record.state === 'deleted' && record.deletedState === 'liked');
      const mutatingProviderList =
        record.state === 'list' ||
        (record.state === 'deleted' && record.deletedState === 'list');
      const safe =
        (!deletingProviderComment && !mutatingProviderReaction) ||
        record.providerIdProvider === 'wetrakr';
      const listSafe =
        !mutatingProviderList || record.listIdProvider === 'wetrakr';
      return safe && listSafe;
    });
    const result = await pushWeTrakrRecords(safeRecords, (path, init) =>
      requestApi(authRef, path, init)
    );
    return { ...result, skipped: result.skipped + records.length - safeRecords.length };
  },

  async scrobble(authRef, event, requestApi) {
    const { kind, title, year, ids, episode } = event.media;
    let media: Record<string, unknown>;
    if (kind === 'movie') {
      if (episode)
        throw new Error('movie scrobble cannot contain episode fields');
      media = {
        movie: { ...(title ? { title } : {}), ...(year ? { year } : {}), ids },
      };
    } else {
      if (!episode) throw new Error('show scrobble requires episode fields');
      media = {
        show: { ...(title ? { title } : {}), ...(year ? { year } : {}), ids },
        episode,
      };
    }
    const response = await requestApi(authRef, `/scrobble/${event.action}`, {
      method: 'POST',
      body: { ...media, progress: event.progress },
      idempotencyKey: event.eventId,
    });
    return ignoredScrobbleResult(response.data);
  },

  async removeRecord(authRef, record, requestApi) {
    // Keep the destructive-provider boundary safe even when a server process
    // is running against a stale core build. Numeric IDs are not globally
    // unique across trackers, so never let an ambiguous tombstone delete a
    // comment or list reaction owned by another provider.
    if (
      record.state === 'deleted' &&
      (record.deletedState === 'comment' ||
        (record.deletedState === 'liked' &&
          (record.kind === 'list' || record.kind === 'comment'))) &&
      record.providerIdProvider !== 'wetrakr'
    ) {
      return;
    }
    if (
      record.state === 'deleted' &&
      record.deletedState === 'list' &&
      record.listIdProvider !== 'wetrakr'
    ) {
      return;
    }
    await pushWeTrakrRecords([record], (path, init) =>
      requestApi(authRef, path, init)
    );
  },

  pullSnapshot(authRef, requestApi, options) {
    return fetchWeTrakrAccountSnapshot(async (path) => {
      const response = await requestApi(authRef, path, { method: 'GET' });
      return {
        data: response.data,
        headers: response.headers ?? new Headers(),
      };
    }, options);
  },

  async pullChanges(authRef, checkpoint, requestApi) {
    const result = await fetchWeTrakrJournalDelta(async (path) => {
      const response = await requestApi(authRef, path, { method: 'GET' });
      return {
        data: response.data,
        headers: response.headers ?? new Headers(),
      };
    }, checkpoint);
    return { records: result.records, checkpoint: result.checkpoint };
  },
};

const TRAKT_PAGE_SIZE = 100;
const TRAKT_MAX_PAGES = 100;

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value))
    throw new Error(`Trakt ${label} response was not a list`);
  return value;
}

async function fetchTraktPages(
  authRef: string,
  path: string,
  requestApi: TrackerProviderApiRequest
): Promise<unknown[]> {
  const items: unknown[] = [];
  let expectedPages: number | undefined;
  for (let page = 1; page <= TRAKT_MAX_PAGES; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const response = await requestApi(
      authRef,
      `${path}${separator}page=${page}&limit=${TRAKT_PAGE_SIZE}`,
      { method: 'GET' }
    );
    const current = asArray(response.data, path);
    items.push(...current);
    const pageCount = Number(response.headers?.get('x-pagination-page-count'));
    if (Number.isFinite(pageCount) && pageCount > 0) expectedPages = pageCount;
    if (expectedPages !== undefined && page >= expectedPages) return items;
    if (current.length < TRAKT_PAGE_SIZE) return items;
  }
  if (expectedPages === undefined || expectedPages > TRAKT_MAX_PAGES)
    throw new Error(`Trakt ${path} exceeded the safe pagination limit`);
  return items;
}

function scrobbleBody(event: TrackerScrobbleEvent): Record<string, unknown> {
  const { kind, title, year, ids, episode } = event.media;
  if (kind === 'movie') {
    if (episode)
      throw new Error('movie scrobble cannot contain episode fields');
    return {
      movie: { ...(title ? { title } : {}), ...(year ? { year } : {}), ids },
      progress: event.progress,
    };
  }
  if (!episode) throw new Error('show scrobble requires episode fields');
  return {
    show: { ...(title ? { title } : {}), ...(year ? { year } : {}), ids },
    episode,
    progress: event.progress,
  };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function idsMatch(left: unknown, right: unknown): boolean {
  const a = object(left);
  const b = object(right);
  return Object.entries(a).some(
    ([key, value]) =>
      value !== null &&
      value !== undefined &&
      b[key] !== null &&
      b[key] !== undefined &&
      String(value).toLowerCase() === String(b[key]).toLowerCase()
  );
}

function filterAlreadyWatched(
  body: Record<string, unknown>,
  watchedMovies: unknown[],
  watchedShows: unknown[]
): { body: Record<string, unknown>; removed: number; remaining: number } {
  const result = { ...body };
  let removed = 0;
  let remaining = 0;
  const movies = Array.isArray(body.movies) ? body.movies : [];
  const pendingMovies = movies.filter((entry) => {
    const ids = object(object(entry).ids);
    const alreadyWatched = watchedMovies.some((row) =>
      idsMatch(ids, object(object(row).movie).ids)
    );
    if (alreadyWatched) removed++;
    else remaining++;
    return !alreadyWatched;
  });
  if (Array.isArray(body.movies)) result.movies = pendingMovies;

  const shows = Array.isArray(body.shows) ? body.shows : [];
  const pendingShows: unknown[] = [];
  for (const entry of shows) {
    const show = object(entry);
    const ids = object(show.ids);
    const target = watchedShows.find((row) =>
      idsMatch(ids, object(object(row).show).ids)
    );
    const seasons = Array.isArray(show.seasons) ? show.seasons : undefined;
    if (!seasons) {
      if (target) removed++;
      else {
        remaining++;
        pendingShows.push(entry);
      }
      continue;
    }
    const watchedSeasonRows = Array.isArray(object(target).seasons)
      ? (object(target).seasons as unknown[])
      : [];
    const pendingSeasons: unknown[] = [];
    for (const seasonValue of seasons) {
      const season = object(seasonValue);
      const seasonNumber = Number(season.number);
      const watchedSeason = watchedSeasonRows.find(
        (row) => Number(object(row).number) === seasonNumber
      );
      const watchedEpisodes = Array.isArray(object(watchedSeason).episodes)
        ? (object(watchedSeason).episodes as unknown[])
        : [];
      const episodes = Array.isArray(season.episodes) ? season.episodes : [];
      const pendingEpisodes = episodes.filter((episode) => {
        const episodeNumber = Number(object(episode).number);
        const alreadyWatched = watchedEpisodes.some(
          (row) => Number(object(row).number) === episodeNumber
        );
        if (alreadyWatched) removed++;
        else remaining++;
        return !alreadyWatched;
      });
      if (pendingEpisodes.length)
        pendingSeasons.push({ ...season, episodes: pendingEpisodes });
    }
    if (pendingSeasons.length)
      pendingShows.push({ ...show, seasons: pendingSeasons });
  }
  if (Array.isArray(body.shows)) result.shows = pendingShows;
  return { body: result, removed, remaining };
}

/** Trakt is a live provider: sync snapshots, canonical mutations, and player scrobbles. */
export const traktTrackerAdapter: TrackerProviderAdapter = {
  id: 'trakt',
  syncMode: 'snapshot',
  requestApi: (authRef, path, init) =>
    requestTraktApi(authRef, path, init),

  async pullSnapshot(authRef, requestApi) {
    const [
      historyMovies,
      historyEpisodes,
      watchlistMovies,
      watchlistShows,
      ratingsMovies,
      ratingsShows,
      playbackMovies,
      playbackEpisodes,
    ] = await Promise.all([
      fetchTraktPages(authRef, '/sync/history?type=movies', requestApi),
      fetchTraktPages(authRef, '/sync/history?type=episodes', requestApi),
      fetchTraktPages(authRef, '/sync/watchlist/movies', requestApi),
      fetchTraktPages(authRef, '/sync/watchlist/shows', requestApi),
      fetchTraktPages(authRef, '/sync/ratings/movies', requestApi),
      fetchTraktPages(authRef, '/sync/ratings/shows', requestApi),
      fetchTraktPages(authRef, '/sync/playback/movies', requestApi),
      fetchTraktPages(authRef, '/sync/playback/episodes', requestApi),
    ]);
    return mapTraktSnapshot({
      history: [...historyMovies, ...historyEpisodes],
      watchlistMovies,
      watchlistShows,
      ratingsMovies,
      ratingsShows,
      playback: [...playbackMovies, ...playbackEpisodes],
    });
  },

  async pushRecords(authRef, records, requestApi) {
    const plan = planTraktWrites(records);
    let synced = 0;
    let watchedMovies: unknown[] = [];
    let watchedShows: unknown[] = [];
    if (plan.operations.some(({ path }) => path === '/sync/history')) {
      [watchedMovies, watchedShows] = await Promise.all([
        fetchTraktPages(authRef, '/sync/watched/movies', requestApi),
        fetchTraktPages(authRef, '/sync/watched/shows', requestApi),
      ]);
    }
    for (const operation of plan.operations) {
      const history =
        operation.path === '/sync/history'
          ? filterAlreadyWatched(operation.body, watchedMovies, watchedShows)
          : {
              body: operation.body,
              removed: 0,
              remaining: operation.recordIds.length,
            };
      if (history.remaining === 0) continue;
      await requestApi(authRef, operation.path, {
        method: 'POST',
        body: history.body,
      });
      synced += history.remaining;
    }
    return { synced, skipped: plan.skipped };
  },

  async scrobble(authRef, event, requestApi) {
    // Trakt explicitly rejects stop events below 1%; there is no remote state
    // to save in that case, so treat the documented no-op as successful.
    if (event.action === 'stop' && event.progress < 1)
      return {
        status: 'ignored',
        reason: 'Trakt ignores stop events below 1%.',
      };
    const response = await requestApi(authRef, `/scrobble/${event.action}`, {
      method: 'POST',
      body: scrobbleBody(event),
    });
    return ignoredScrobbleResult(response.data);
  },

  async removeRecord(authRef, record, requestApi) {
    const state =
      record.state === 'deleted' ? record.deletedState : record.state;
    if (state === 'in_progress') {
      // Trakt playback-removal requires its provider-owned numeric playback id;
      // canonical cross-provider IDs are not interchangeable with that id.
      throw new Error('Trakt playback deletion needs a Trakt playback item id');
    }
    const plan = planTraktWrites([record]);
    for (const operation of plan.operations) {
      await requestApi(authRef, operation.path, {
        method: 'POST',
        body: operation.body,
      });
    }
  },
};

function floppyIdentity(record: TrackerRecord): {
  mediaType: 'movie' | 'tv';
  source: string;
  mediaId: string;
} | null {
  if (record.providerIdProvider === 'floppy' && record.providerId) {
    const match = /^(movie|tv|anime|season|episode):([^:]+):(.+)$/.exec(record.providerId);
    if (match) {
      return {
        mediaType: match[1] === 'movie' ? 'movie' : 'tv',
        source: match[2],
        mediaId: match[3].split(':')[0],
      };
    }
  }
  const ids = record.ids;
  // Floppy's native TV/movie routes are centered on metadata-provider IDs.
  // Prefer TMDB when a cross-provider record has several IDs so we do not
  // send IMDb as the route's source for a TMDB-backed catalog item.
  const source = ['tmdb', 'tvdb', 'imdb', 'mal', 'anilist', 'kitsu', 'trakt']
    .find((key) => ids[key]);
  if (!source) return null;
  return {
    mediaType: record.kind === 'movie' ? 'movie' : 'tv',
    source,
    mediaId: ids[source],
  };
}

async function requestFloppyWrite(
  requestApi: TrackerProviderApiRequest,
  authRef: string,
  path: string,
  init: Parameters<TrackerProviderApiRequest>[2],
  missingIsSuccess = false
): Promise<void> {
  try {
    await requestApi(authRef, path, init);
  } catch (error) {
    // Deletions describe desired absence. Floppy returns 404 when the target
    // rating/list/history row is already absent, so retrying that tombstone
    // forever cannot improve convergence.
    if (
      missingIsSuccess &&
      error instanceof Error &&
      /^Floppy API request failed \(404\)$/.test(error.message)
    )
      return;
    throw error;
  }
}

async function writeFloppyRecord(
  authRef: string,
  record: TrackerRecord,
  requestApi: TrackerProviderApiRequest
): Promise<boolean> {
  const state = record.state === 'deleted' ? record.deletedState : record.state;
  if (state === 'list' && record.listIdProvider === 'floppy' && record.listId) {
    const identity = floppyIdentity(record);
    if (!identity || !/^\d+$/.test(record.listId))
      return false;
    const seasonPath = record.season !== undefined
      ? `/${record.season}`
      : '';
    const path = `/api/v1/media/${identity.mediaType}/${encodeURIComponent(identity.source)}/${encodeURIComponent(identity.mediaId)}${seasonPath}/lists/${encodeURIComponent(record.listId)}/`;
    await requestFloppyWrite(
      requestApi,
      authRef,
      path,
      { method: record.state === 'deleted' ? 'DELETE' : 'PUT' },
      record.state === 'deleted'
    );
    return true;
  }

  const identity = floppyIdentity(record);
  if (!identity) return false;

  if (state === 'watched' && record.state !== 'deleted' &&
      (record.kind === 'movie' || record.kind === 'episode')) {
    const ids = floppyScrobbleIds(record.ids);
    if (!ids || (record.kind === 'episode' &&
        (record.season === undefined || record.episode === undefined)))
      return false;

    const mediaType = record.kind === 'movie' ? 'movie' : 'tv';
    const historyPath = record.kind === 'episode'
      ? `/api/v1/media/tv/${encodeURIComponent(identity.source)}/${encodeURIComponent(identity.mediaId)}/${record.season}/${record.episode}/history/`
      : `/api/v1/media/movie/${encodeURIComponent(identity.source)}/${encodeURIComponent(identity.mediaId)}/history/`;
    const expectedPlayedAt = new Date(record.updatedAt).toISOString();
    // The watched-status endpoint always stamps the current time. Read the
    // exact title/episode history first: patch its latest consumption date
    // when one exists, or create a backdated scrobble otherwise. This also
    // repairs old bad timestamps and avoids duplicate plays after retries.
    let history: unknown;
    try {
      ({ data: history } = await requestApi(authRef, historyPath, { method: 'GET' }));
    } catch (error) {
      if (!(error instanceof Error && /^Floppy API request failed \(404\)$/.test(error.message)))
        throw error;
    }
    const existingPlay = floppyHistoryPlay(history, record.updatedAt);
    if (existingPlay?.exact) return true;
    if (existingPlay?.consumptionId) {
      const patchPath = record.kind === 'episode'
        ? `/api/v1/media/tv/${encodeURIComponent(identity.source)}/${encodeURIComponent(identity.mediaId)}/${record.season}/${record.episode}/history/${encodeURIComponent(existingPlay.consumptionId)}/`
        : `/api/v1/media/movie/${encodeURIComponent(identity.source)}/${encodeURIComponent(identity.mediaId)}/history/${encodeURIComponent(existingPlay.consumptionId)}/`;
      await requestApi(authRef, patchPath, {
        method: 'PATCH',
        body: { end_date: expectedPlayedAt },
      });
      return true;
    }

    await requestApi(authRef, '/api/v1/scrobble/', {
      method: 'POST',
      body: {
        action: 'stop',
        media_type: record.kind,
        ids,
        ...(record.title ? { title: record.title } : {}),
        ...(record.kind === 'episode' && record.seriesTitle
          ? { series_title: record.seriesTitle }
          : {}),
        ...(record.kind === 'episode' ? {
          season_number: record.season,
          episode_number: record.episode,
        } : {}),
        completed: true,
        played_at: expectedPlayedAt,
      },
    });
    return true;
  }

  if (state === 'in_progress' && record.positionMs !== undefined) {
    if (record.state === 'deleted' || !record.durationMs) return false;
    if (record.kind === 'episode' && !record.seriesTitle) return false;
    const ids = floppyScrobbleIds(record.ids);
    if (!ids) return false;
    await requestApi(authRef, '/api/v1/scrobble/', {
      method: 'POST',
      body: {
        action: 'stop',
        media_type: record.kind === 'movie' ? 'movie' : 'episode',
        ids,
        ...(record.title ? { title: record.title } : {}),
        ...(record.kind === 'episode' && record.seriesTitle
          ? { series_title: record.seriesTitle }
          : {}),
        ...(record.kind === 'episode' && record.season !== undefined
          ? { season_number: record.season }
          : {}),
        ...(record.kind === 'episode' && record.episode !== undefined
          ? { episode_number: record.episode }
          : {}),
        position_seconds: Math.floor(record.positionMs / 1000),
        duration_seconds: Math.floor(record.durationMs / 1000),
        completed: false,
        played_at: new Date(record.updatedAt).toISOString(),
      },
    });
    return true;
  }

  if (record.kind === 'episode') {
    if (state === 'rated' && record.season !== undefined && record.episode !== undefined) {
      await requestFloppyWrite(
        requestApi,
        authRef,
        `/api/v1/media/tv/${encodeURIComponent(identity.source)}/${encodeURIComponent(identity.mediaId)}/${record.season}/episodes/${record.episode}/score/`,
        { method: 'PATCH', body: { score: record.state === 'deleted' ? null : record.rating ?? null } },
        record.state === 'deleted'
      );
      return true;
    }
    if (record.state === 'deleted' && state === 'watched' && record.season !== undefined && record.episode !== undefined) {
      await requestFloppyWrite(
        requestApi,
        authRef,
        `/api/v1/media/tv/${encodeURIComponent(identity.source)}/${encodeURIComponent(identity.mediaId)}/${record.season}/episodes/${record.episode}/drop/`,
        { method: 'POST', body: {} },
        true
      );
      return true;
    }
    return false;
  }

  // Floppy exposes deletion by history-row identity, not by a title-level
  // completed flag. Only delete a play when it came from Floppy and carries
  // that exact provider history ID.
  if (record.state === 'deleted' && state === 'play' && record.providerIdProvider === 'floppy' && record.providerId) {
    const parts = record.providerId.split(':');
    const historyId = parts.length >= 4 ? parts.slice(3).join(':') : undefined;
    const mediaType = parts[0] === 'movie' ? 'movie' : 'tv';
    if (!historyId || /[\\/\u0000-\u001f]/.test(historyId)) return false;
    await requestFloppyWrite(
      requestApi,
      authRef,
      `/api/v1/history/${mediaType}/${encodeURIComponent(historyId)}/`,
      { method: 'DELETE' },
      true
    );
    return true;
  }

  // Floppy's public API deliberately exposes only a subset of its web UI as
  // write endpoints. Do not send invented PUTs for status, notes, or movie
  // ratings; those records remain canonical in AIOStreams and are reported
  // as unsupported for this destination.
  return false;
}

function floppyHistoryPlay(
  value: unknown,
  playedAtMs: number
): { exact: boolean; consumptionId?: string } | undefined {
  const root = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const candidates = Array.isArray(value)
    ? value
    : [root.results, root.consumptions, root.history, root.items]
        .find(Array.isArray) as unknown[] | undefined ?? [];
  const plays = candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const row = candidate as Record<string, unknown>;
    // Episode callers use an episode-specific history endpoint, so the API
    // need not repeat season/episode coordinates inside each consumption row.
    const status = String(row.status ?? '').toLowerCase();
    if (status && !['3', 'completed', 'complete'].includes(status)) return [];
    const consumptionId = row.consumption_id ?? row.history_id ?? row.id;
    const dateValue = row.end_date ?? row.played_at ?? row.played_at_local ?? row.watched_at;
    const date = typeof dateValue === 'number'
      ? (dateValue < 10_000_000_000 ? dateValue * 1000 : dateValue)
      : typeof dateValue === 'string'
        ? Date.parse(dateValue)
        : Number.NaN;
    if (!Number.isFinite(date)) return [];
    return [{
      consumptionId: typeof consumptionId === 'number' || typeof consumptionId === 'string'
        ? String(consumptionId)
        : undefined,
      date,
    }];
  });
  const exact = plays.find(({ date }) => Math.abs(date - playedAtMs) < 1000);
  if (exact) return { exact: true, consumptionId: exact.consumptionId };
  const latest = plays
    .filter(({ consumptionId }) => consumptionId && /^\d+$/.test(consumptionId))
    .sort((left, right) => right.date - left.date)[0];
  return latest ? { exact: false, consumptionId: latest.consumptionId } : undefined;
}

async function writeFloppyRecordSafely(
  authRef: string,
  record: TrackerRecord,
  requestApi: TrackerProviderApiRequest
): Promise<boolean> {
  try {
    return await writeFloppyRecord(authRef, record, requestApi);
  } catch (error) {
    // A valid canonical media identity can still be absent from Floppy's own
    // catalog. That destination cannot represent the item, but unrelated
    // records should continue draining from the outbox.
    if (
      error instanceof Error &&
      /^Floppy API request failed \(404\)$/.test(error.message)
    )
      return false;
    if (error instanceof Error) {
      const status = /^Floppy API request failed \((\d{3})\)$/.exec(error.message)?.[1];
      if (status) {
        const state = record.state === 'deleted'
          ? record.deletedState ?? 'deleted'
          : record.state;
        throw new Error(
          `Floppy API request failed (${status}); record=${record.kind}-${state}`
        );
      }
    }
    throw error;
  }
}

function floppyScrobbleIds(ids: Record<string, string>): Record<string, string> | undefined {
  const supported = ['tmdb', 'imdb', 'tvdb', 'anidb'];
  const filtered = Object.fromEntries(
    supported.flatMap((key) => {
      const value = ids[key]?.trim();
      return value ? [[key, value]] : [];
    })
  );
  return ['tmdb', 'imdb', 'tvdb'].some((key) => filtered[key])
    ? filtered
    : undefined;
}

function floppySnapshotEndpoint(path: string): string | undefined {
  const media = /^\/api\/v1\/media\/(movie|tv|anime|season|episode)\/?(?:\?|$)/.exec(path);
  if (media) return `floppy_media_${media[1]}`;
  if (path.startsWith('/api/v1/playback/progress/'))
    return 'floppy_playback_progress';
  if (path.startsWith('/api/v1/history/')) return 'floppy_history';
  return undefined;
}

/** Official Floppy REST adapter; unsupported record types are reported, never silently rewritten. */
export const floppyTrackerAdapter: TrackerProviderAdapter = {
  id: 'floppy',
  syncMode: 'snapshot',
  requestApi: (authRef, path, init) => requestFloppyApi(authRef, path, init),
  pushRecord: (authRef, record, requestApi) =>
    writeFloppyRecordSafely(authRef, record, requestApi),

  pullSnapshot(authRef, requestApi) {
    return fetchFloppySnapshot(async (path) => {
      try {
        const result = await requestApi(authRef, path, { method: 'GET' });
        return { data: result.data, headers: result.headers ?? new Headers() };
      } catch (error) {
        const status = error instanceof Error
          ? /^Floppy API request failed \((\d{3})\)$/.exec(error.message)?.[1]
          : undefined;
        if (!status) throw error;
        throw Object.assign(new Error('Floppy snapshot request failed'), {
          status: Number(status),
          endpoint: floppySnapshotEndpoint(path),
        });
      }
    });
  },

  async pushRecords(authRef, records, requestApi) {
    let synced = 0;
    let skipped = 0;
    for (const record of records) {
      if (await writeFloppyRecordSafely(authRef, record, requestApi)) synced += 1;
      else skipped += 1;
    }
    return { synced, skipped };
  },

  async scrobble(authRef, event, requestApi) {
    const ids = floppyScrobbleIds(event.media.ids);
    if (!ids)
      return { status: 'ignored', reason: 'Floppy needs a TMDB, IMDb, or TVDB ID for scrobbling.' };
    if (event.media.kind === 'show' && !event.media.episode)
      return { status: 'ignored', reason: 'Floppy needs an exact episode for TV scrobbling.' };
    if (event.action === 'stop' && (event.positionMs === undefined || event.durationMs === undefined || event.durationMs <= 0))
      return { status: 'ignored', reason: 'Floppy needs exact playback position and duration to persist a stop event.' };
    const episode = event.media.episode;
    await requestApi(authRef, '/api/v1/scrobble/', {
      method: 'POST',
      body: {
        action: event.action,
        media_type: event.media.episode ? 'episode' : 'movie',
        ids,
        ...(episode?.title ? { title: episode.title } : event.media.title ? { title: event.media.title } : {}),
        ...(episode && event.media.title ? { series_title: event.media.title } : {}),
        ...(event.positionMs !== undefined
          ? { position_seconds: Math.floor(event.positionMs / 1000) }
          : {}),
        ...(event.durationMs !== undefined
          ? { duration_seconds: Math.floor(event.durationMs / 1000) }
          : {}),
        ...(episode
          ? { season_number: episode.season, episode_number: episode.number }
          : {}),
        ...(event.action === 'stop' ? { completed: event.progress >= 95 } : {}),
      },
      idempotencyKey: event.eventId,
    });
  },

  async removeRecord(authRef, record, requestApi) {
    const supported = await writeFloppyRecord(authRef, record, requestApi);
    if (!supported) throw new Error('Floppy does not support deleting this tracker record type');
  },
};

export const defaultTrackerProviderAdapters: TrackerProviderAdapter[] = [
  weTrakrTrackerAdapter,
  traktTrackerAdapter,
  floppyTrackerAdapter,
];

export const defaultTrackerProviderApiRequest: TrackerProviderApiRequest = (
  authRef,
  path,
  init
) => requestWeTrakrApi(authRef, path, init);
