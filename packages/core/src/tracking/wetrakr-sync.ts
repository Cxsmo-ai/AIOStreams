import { createHash } from 'node:crypto';
import { TrackerRecordSchema, type TrackerRecord } from './types.js';

type JsonObject = Record<string, unknown>;
const MAX_WETRAKR_SNAPSHOT_CONCURRENCY = 4;

/** Bound provider API fan-out while preserving input order and stopping new work on failure. */
async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error('Concurrency must be a positive integer');
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let didFail = false;
  let failure: unknown;

  const worker = async () => {
    while (!didFail) {
      const index = nextIndex++;
      if (index >= values.length) return;
      try {
        results[index] = await mapper(values[index]!, index);
      } catch (error) {
        if (!didFail) {
          didFail = true;
          failure = error;
        }
      }
    }
  };

  const workers = Math.min(values.length, concurrency);
  await Promise.all(Array.from({ length: workers }, worker));
  if (didFail) throw failure;
  return results;
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Run every bounded task and retain successful facets when one is forbidden. */
async function mapSettledWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<Array<Settled<R>>> {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error('Concurrency must be a positive integer');
  const results = new Array<Settled<R>>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      try {
        results[index] = {
          ok: true,
          value: await mapper(values[index]!, index),
        };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(values.length, concurrency) },
      () => worker()
    )
  );
  return results;
}

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function identifier(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    return String(value);
  return text(value);
}

function number(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function epoch(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value))
    return Math.max(
      1,
      Math.floor(value < 10_000_000_000 ? value * 1000 : value)
    );
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return epoch(numeric, fallback);
  }
  return Math.max(1, fallback);
}

function externalIds(value: unknown): Record<string, string> {
  const ids = object(value);
  return Object.fromEntries(
    Object.entries(ids)
      .filter(
        ([key, raw]) =>
          /^[a-z][a-z0-9_-]{0,31}$/i.test(key) &&
          (typeof raw === 'string' || typeof raw === 'number') &&
          String(raw).trim().length > 0
      )
      .map(([key, raw]) => [key.toLowerCase(), String(raw).trim()])
  );
}

const ID_PRIORITY = [
  'imdb',
  'tmdb',
  'tvdb',
  'trakt',
  'simkl',
  'mal',
  'anidb',
  'anilist',
  'kitsu',
];

function mediaType(value: unknown): TrackerRecord['kind'] | undefined {
  switch (text(value)?.toLowerCase()) {
    case 'movie':
      return 'movie';
    case 'movies':
      return 'movie';
    case 'show':
    case 'shows':
    case 'series':
    case 'season':
      return 'series';
    case 'seasons':
      return 'series';
    case 'episode':
      return 'episode';
    case 'episodes':
      return 'episode';
    case 'person':
      return 'person';
    case 'people':
      return 'person';
    case 'comment':
    case 'comments':
      return 'comment';
    case 'list':
      return 'list';
    case 'lists':
      return 'list';
    default:
      return undefined;
  }
}

function stableMediaKey(
  kind: TrackerRecord['kind'],
  ids: Record<string, string>,
  providerId: unknown
): string | undefined {
  const preferred = ID_PRIORITY.find((key) => ids[key]);
  const external = preferred ? `${preferred}:${ids[preferred]}` : undefined;
  const id = identifier(providerId);
  const fallback = id ? `wetrakr:${kind}:${id}` : undefined;
  const stable = external ?? fallback;
  if (!stable) return undefined;
  if (kind === 'episode') {
    const season = number((ids as JsonObject).__season);
    const episode = number((ids as JsonObject).__episode);
    return season !== undefined && episode !== undefined
      ? `episode:${stable}:s${season}:e${episode}`
      : `episode:${stable}`;
  }
  if (kind === 'list' || kind === 'person') return `${kind}:${stable}`;
  return `${kind}:${stable}`;
}

function mappedState(
  category: string,
  status: string
): TrackerRecord['state'] | undefined {
  if (status === 'removed') return 'deleted';
  switch (category) {
    case 'watched':
      return 'watched';
    case 'watching':
    case 'playing':
      return 'in_progress';
    case 'planning':
      return 'watchlist';
    case 'waiting':
      return 'waiting';
    case 'paused':
      return 'paused';
    case 'dropped':
      return 'dropped';
    case 'ignored':
      return 'ignored';
    case 'ratings':
      return 'rated';
    case 'favorites':
      return 'favorite';
    case 'notes':
      return 'note';
    case 'comments':
      return 'comment';
    case 'lists':
      return 'list';
    case 'likes':
      return 'liked';
    default:
      return undefined;
  }
}

function separateStateId(
  baseId: string,
  state: TrackerRecord['state'],
  category: string
): string {
  // Progress is shared with Nuvio's established movie:<id>/episode:<id>:sN:eN
  // keys. Other facets need independent records so a favorite or rating cannot
  // overwrite playback progress for the same title.
  if (state === 'in_progress' || state === 'watched') return baseId;
  const facet = state === 'deleted' ? mappedState(category, 'added') : state;
  return facet === 'in_progress' || facet === 'watched' || !facet
    ? baseId
    : `${baseId}|${facet}`;
}

/** Converts a WeTrakr journal entry or compact account item to the merged ledger. */
export function mapWeTrakrItemToTrackerRecord(
  input: unknown,
  options: {
    category?: string;
    status?: string;
    now?: number;
    listId?: string;
    listTitle?: string;
  } = {}
): TrackerRecord | null {
  const root = object(input);
  const target = object(root.target);
  let media = root;
  let kind =
    mediaType(root.type) ?? mediaType(root.target) ?? mediaType(target.type);
  for (const key of [
    'movie',
    'show',
    'season',
    'episode',
    'person',
    'list',
    'comment',
  ]) {
    if (
      root[key] &&
      typeof root[key] === 'object' &&
      (!kind || mediaType(key) === kind)
    ) {
      media = object(root[key]);
      kind ??= mediaType(key);
      break;
    }
  }
  const category = options.category ?? text(root.category) ?? '';
  const status = options.status ?? text(root.status) ?? 'added';
  if (!kind && category === 'lists') kind = 'list';
  if (!kind) return null;
  const state = mappedState(category, status);
  if (!state) return null;

  const embeddedShow = object(media.show ?? media.series ?? root.show);
  const ids = externalIds(
    kind === 'episode'
      ? (embeddedShow.ids ?? root.show_ids ?? media.ids)
      : (media.ids ?? root.ids)
  );
  const season = number(
    root.season_number ?? root.season ?? media.season_number ?? media.season
  );
  const episode = number(
    root.number ?? root.episode_number ?? media.number ?? media.episode_number
  );
  const idIds = { ...ids } as JsonObject;
  if (season !== undefined) idIds.__season = season;
  if (episode !== undefined) idIds.__episode = episode;
  let baseId = stableMediaKey(
    kind,
    idIds as Record<string, string>,
    media.id ?? root.id ?? target.id
  );
  if (!baseId) return null;
  if (category === 'comments' && identifier(root.id))
    baseId = `${baseId}|comment:${identifier(root.id)}`;

  const parentTitle = text(
    embeddedShow.title ?? root.show_title ?? root.series_title
  );
  const title = text(media.title ?? root.title ?? media.name ?? root.name);
  const updatedAt = epoch(
    root.action_at ??
      root.watched_at ??
      root.rated_at ??
      root.rating_updated_at ??
      root.note_updated_at ??
      root.note_added_at ??
      root.comment_updated_at ??
      root.comment_added_at ??
      root.like_added_at ??
      root.favorite_added_at ??
      root.list_updated_at ??
      root.list_added_at ??
      root.added_at ??
      root.updated_at ??
      root.created_at,
    options.now ?? 1
  );
  const note = object(root.note);
  const deletedState = mappedState(category, 'added');
  const record: TrackerRecord = {
    id:
      state === 'list' && options.listId
        ? `${baseId}|list:${options.listId}`
        : state === 'comment' && category === 'comments'
          ? baseId
          : separateStateId(baseId, state, category),
    kind,
    ids,
    ...(kind === 'episode'
      ? {
          title: parentTitle ?? title,
          seriesTitle: parentTitle ?? title,
          episodeTitle: title,
        }
      : { title }),
    ...(season !== undefined ? { season } : {}),
    ...(episode !== undefined ? { episode } : {}),
    state,
    ...(state === 'deleted' && deletedState && deletedState !== 'deleted'
      ? { deletedState }
      : {}),
    ...(number(root.position_ms ?? root.positionMs) !== undefined
      ? { positionMs: number(root.position_ms ?? root.positionMs) }
      : {}),
    ...(number(root.duration_ms ?? root.durationMs) !== undefined
      ? { durationMs: number(root.duration_ms ?? root.durationMs) }
      : {}),
    ...(number(root.rating) !== undefined
      ? { rating: number(root.rating) }
      : {}),
    ...(text(
      options.listTitle ?? media.text ?? root.text ?? note.text ?? root.name
    )
      ? {
          text: text(
            options.listTitle ??
              media.text ??
              root.text ??
              note.text ??
              root.name
          ),
        }
      : {}),
    ...(text(root.reaction) ? { reaction: text(root.reaction) } : {}),
    ...(text(
      options.listId ??
        root.list_id ??
        root.listId ??
        (kind === 'list' ? (media.id ?? root.id) : undefined)
    )
      ? {
          listId: text(
            options.listId ??
              root.list_id ??
              root.listId ??
              (kind === 'list' ? (media.id ?? root.id) : undefined)
          ),
          listIdProvider: 'wetrakr',
        }
      : {}),
    ...(text(options.listTitle ?? root.list_name)
      ? { listName: text(options.listTitle ?? root.list_name) }
      : {}),
    ...(number(root.rank ?? root.editor_rank) !== undefined
      ? { listRank: number(root.rank ?? root.editor_rank) }
      : {}),
    ...(identifier(
      root.play_id ??
        (kind === 'list' || category === 'comments'
          ? kind === 'list'
            ? (media.id ?? root.id)
            : root.id
          : kind === 'comment'
            ? media.id
            : undefined)
    )
      ? {
          providerId: identifier(
            root.play_id ??
              (kind === 'list' || category === 'comments'
                ? kind === 'list'
                  ? (media.id ?? root.id)
                  : root.id
                  : kind === 'comment'
                    ? media.id
                    : undefined)
          ),
          providerIdProvider: 'wetrakr',
        }
      : {}),
    ...(identifier(root.parent_id)
      ? { parentId: identifier(root.parent_id) }
      : {}),
    ...(typeof root.spoiler === 'boolean' ? { spoiler: root.spoiler } : {}),
    updatedAt,
    origin: 'wetrakr',
    revision: 0,
  };
  const parsed = TrackerRecordSchema.safeParse(record);
  return parsed.success ? parsed.data : null;
}

export function mapWeTrakrJournalEntry(entry: unknown): TrackerRecord | null {
  return mapWeTrakrItemToTrackerRecord(entry, {
    category: text(object(entry).category),
    status: text(object(entry).status),
  });
}

export type WeTrakrPageRequest = (
  path: string
) => Promise<{ data: unknown; headers: Headers }>;

function pageRows(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.map(object);
  const root = object(value);
  for (const key of ['results', 'items', 'records', 'journal', 'data']) {
    if (Array.isArray(root[key])) return (root[key] as unknown[]).map(object);
  }
  return [];
}

async function collectPages(
  request: WeTrakrPageRequest,
  basePath: string,
  category: string,
  status = 'added',
  list?: { listId: string; listTitle: string }
): Promise<TrackerRecord[]> {
  const result: TrackerRecord[] = [];
  const pageLimit = 100;
  const maxPages = 100;
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = basePath.includes('?') ? '&' : '?';
    const response = await request(
      `${basePath}${separator}page=${page}&limit=${pageLimit}`
    );
    const rows = pageRows(response.data);
    for (const row of rows) {
      const record = mapWeTrakrItemToTrackerRecord(row, {
        category,
        status: text(row.status) ?? status,
        ...list,
      });
      if (record) {
        result.push(record);
        // Keep each watched play as its own provider record while also retaining
        // the stable latest-progress key consumed by Nuvio.
        if (category === 'watched' && identifier(row.play_id)) {
          const playId = identifier(row.play_id)!;
          const playRecord = TrackerRecordSchema.safeParse({
            ...record,
            id: `${record.id}|play:${playId}`,
            ...(record.state === 'deleted'
              ? { state: 'deleted', deletedState: 'play' }
              : { state: 'play' }),
          });
          if (playRecord.success) result.push(playRecord.data);
        }
      }
    }
    const pageCount = Number(response.headers.get('x-pagination-page-count'));
    if (Number.isFinite(pageCount) && pageCount > 0) {
      if (page >= pageCount) break;
    } else if (rows.length < pageLimit) {
      break;
    }
    if (page === maxPages)
      throw new Error(
        `WeTrakr pagination exceeded the safe limit for ${basePath}`
      );
  }
  return result;
}

/**
 * WeTrakr's watched-history endpoint only accepts movies or episodes. Its
 * compact cursor mode is intended for first syncs. Keep pages at 1,000 rows so
 * long episode histories remain below the bounded 1 MiB API response limit;
 * cursor paging avoids the unstable offsets of a changing history.
 */
async function collectCompactWatchedHistory(
  request: WeTrakrPageRequest,
  target: 'movies' | 'episodes',
  maxPages = 1_000
): Promise<TrackerRecord[]> {
  const basePath = `/sync/tracking/watched/history/${target}`;
  const records: TrackerRecord[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({ compact: 'true', limit: '1000' });
    if (cursor) params.set('after', cursor);
    const response = await request(`${basePath}?${params}`);
    const rows = pageRows(response.data);

    for (const row of rows) {
      const record = mapWeTrakrItemToTrackerRecord(row, {
        category: 'watched',
        status: 'added',
      });
      if (!record) continue;
      records.push(record);

      // In compact history rows `id` is the play_id; some API response shapes
      // also include an explicit play_id, so accept both without losing it.
      const playId = identifier(row.play_id ?? row.id);
      if (playId) {
        const playRecord = TrackerRecordSchema.safeParse({
          ...record,
          id: `${record.id}|play:${playId}`,
          state: 'play',
        });
        if (playRecord.success) records.push(playRecord.data);
      }
    }

    const nextCursor = response.headers.get('x-pagination-next');
    if (!nextCursor) return records;
    if (
      nextCursor.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(nextCursor) ||
      seenCursors.has(nextCursor)
    ) {
      throw new Error('WeTrakr returned an invalid or repeated history cursor');
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new Error(
    `WeTrakr watched history exceeded the safe cursor limit for ${target}`
  );
}

async function collectRawPages(
  request: WeTrakrPageRequest,
  basePath: string,
  pageLimit = 100,
  maxPages = 100
): Promise<JsonObject[]> {
  const result: JsonObject[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = basePath.includes('?') ? '&' : '?';
    const response = await request(
      `${basePath}${separator}page=${page}&limit=${pageLimit}`
    );
    const rows = pageRows(response.data);
    result.push(...rows);
    const pageCount = Number(response.headers.get('x-pagination-page-count'));
    if (Number.isFinite(pageCount) && pageCount > 0) {
      if (page >= pageCount) break;
    } else if (rows.length < pageLimit) {
      break;
    }
    if (page === maxPages)
      throw new Error(
        `WeTrakr pagination exceeded the safe limit for ${basePath}`
      );
  }
  return result;
}

export type WeTrakrSnapshotFailure = {
  endpoint: string;
  /** Stable internal key used to retry this facet without re-fetching peers. */
  facetId?: string;
  status?: number;
  providerCode?: 'PRIVATE' | 'FRIENDS_ONLY' | 'COMMENTS_DISABLED';
  reason?:
    | 'invalid_history_cursor'
    | 'history_cursor_limit'
    | 'pagination_limit'
    | 'response_too_large'
    | 'invalid_upstream_response';
  errorName?: 'AbortError' | 'TimeoutError' | 'TypeError';
};

export type WeTrakrAccountSnapshot = {
  records: TrackerRecord[];
  failures: WeTrakrSnapshotFailure[];
  completedFacets: string[];
  /** False when some facets were skipped because they were already complete. */
  authoritative: boolean;
};

const SAFE_SNAPSHOT_PROVIDER_CODES = new Set([
  'PRIVATE',
  'FRIENDS_ONLY',
  'COMMENTS_DISABLED',
]);

function snapshotFailure(
  endpoint: string,
  error: unknown
): WeTrakrSnapshotFailure {
  const candidate =
    error && typeof error === 'object'
      ? (error as { status?: unknown; providerCode?: unknown })
      : {};
  const status = Number(candidate.status);
  const providerCode = candidate.providerCode;
  const message = error instanceof Error ? error.message : '';
  const reason: WeTrakrSnapshotFailure['reason'] =
    message === 'WeTrakr returned an invalid or repeated history cursor'
      ? 'invalid_history_cursor'
      : message.startsWith('WeTrakr watched history exceeded the safe cursor limit')
        ? 'history_cursor_limit'
        : message.startsWith('WeTrakr pagination exceeded the safe limit')
          ? 'pagination_limit'
          : message === 'WeTrakr response exceeded the allowed size'
            ? 'response_too_large'
            : message === 'WeTrakr returned an invalid response'
              ? 'invalid_upstream_response'
              : undefined;
  const errorName = error instanceof Error ? error.name : undefined;
  return {
    endpoint,
    ...(Number.isInteger(status) && status >= 400 && status <= 599
      ? { status }
      : {}),
    ...(typeof providerCode === 'string' &&
    SAFE_SNAPSHOT_PROVIDER_CODES.has(providerCode)
      ? { providerCode: providerCode as WeTrakrSnapshotFailure['providerCode'] }
      : {}),
    ...(reason ? { reason } : {}),
    ...(errorName === 'AbortError' ||
    errorName === 'TimeoutError' ||
    errorName === 'TypeError'
      ? { errorName }
      : {}),
  };
}

/**
 * Read the account snapshot facet-by-facet. A denied facet is reported without
 * discarding independent progress, history, ratings, comments, or list data.
 * Callers must not treat this as authoritative while `failures` is non-empty.
 */
export async function fetchWeTrakrAccountSnapshot(
  request: WeTrakrPageRequest,
  options: { completedFacets?: readonly string[] } = {}
): Promise<WeTrakrAccountSnapshot> {
  const completed = new Set(options.completedFacets ?? []);
  const tasks: Array<{
    endpoint: string;
    facetId: string;
    run: () => Promise<TrackerRecord[] | JsonObject[]>;
  }> = [
    ...[
      'watching',
      'playing',
      'waiting',
      'planning',
      'dropped',
      'paused',
    ].map((status) => ({
      endpoint: `sync_tracking_${status}_all`,
      facetId: `sync_tracking_${status}_all`,
      run: () => collectPages(request, `/sync/tracking/${status}/all`, status),
    })),
    {
      endpoint: 'sync_tracking_watched_all',
      facetId: 'sync_tracking_watched_all',
      run: () => collectPages(request, '/sync/tracking/watched/all', 'watched'),
    },
    { endpoint: 'sync_ratings_all', facetId: 'sync_ratings_all', run: () => collectPages(request, '/sync/ratings/all', 'ratings') },
    { endpoint: 'sync_favorites_all', facetId: 'sync_favorites_all', run: () => collectPages(request, '/sync/favorites/all', 'favorites') },
    { endpoint: 'likes_all', facetId: 'likes_all', run: () => collectPages(request, '/sync/likes/all', 'likes') },
    { endpoint: 'sync_notes_all', facetId: 'sync_notes_all', run: () => collectPages(request, '/sync/notes/all', 'notes') },
    { endpoint: 'sync_comments_all', facetId: 'sync_comments_all', run: () => collectPages(request, '/sync/comments/all?include_replies=true', 'comments') },
    {
      endpoint: 'sync_tracking_watched_history_movies',
      facetId: 'sync_tracking_watched_history_movies',
      run: () => collectCompactWatchedHistory(request, 'movies'),
    },
    {
      endpoint: 'sync_tracking_watched_history_episodes',
      facetId: 'sync_tracking_watched_history_episodes',
      run: () => collectCompactWatchedHistory(request, 'episodes'),
    },
    {
      endpoint: 'sync_lists',
      facetId: 'sync_lists',
      run: () => collectRawPages(request, '/sync/lists'),
    },
  ];
  const pendingTasks = tasks.filter((task) => !completed.has(task.facetId));
  const settled = await mapSettledWithConcurrency(
    pendingTasks,
    MAX_WETRAKR_SNAPSHOT_CONCURRENCY,
    (task) => task.run()
  );
  const all: TrackerRecord[] = [];
  const failures: WeTrakrSnapshotFailure[] = [];
  const completedFacets: string[] = [];
  let listRows: JsonObject[] = [];
  settled.forEach((result, index) => {
    const task = pendingTasks[index]!;
    if (!result.ok) {
      failures.push({
        ...snapshotFailure(task.endpoint, result.error),
        facetId: task.facetId,
      });
      return;
    }
    if (task.facetId !== 'sync_lists') completedFacets.push(task.facetId);
    if (task.endpoint === 'sync_lists') listRows = result.value as JsonObject[];
    else all.push(...(result.value as TrackerRecord[]));
  });
  // The list index is rediscovered while any list facet is incomplete. Once
  // every list's item facet is complete, the index can be skipped like peers.
  if (completed.has('sync_lists') && completed.has('sync_lists_items')) {
    listRows = [];
  }
  for (const list of listRows) {
    const listId = identifier(list.id);
    if (!listId || !/^\d{1,18}$/.test(listId)) continue;
    const listTitle = text(list.name ?? list.title) ?? `WeTrakr list ${listId}`;
    const metadata = mapWeTrakrItemToTrackerRecord(list, {
      category: 'lists',
      status: 'added',
      listId,
      listTitle,
    });
    if (metadata) all.push(metadata);
  }
  const listItemTasks = listRows.flatMap((list) => {
      const listId = identifier(list.id);
      if (!listId || !/^\d{1,18}$/.test(listId)) return [];
      const facetId = `sync_lists_items:${listId}`;
      if (completed.has(facetId)) return [];
      const listTitle =
        text(list.name ?? list.title) ?? `WeTrakr list ${listId}`;
      return [
        { listId, listTitle, facetId },
      ];
    });
  const listItems = await mapSettledWithConcurrency(
    listItemTasks,
    MAX_WETRAKR_SNAPSHOT_CONCURRENCY,
    ({ listId, listTitle }) =>
      collectPages(
          request,
          `/sync/lists/${encodeURIComponent(listId)}/items`,
          'lists',
          'added',
          { listId, listTitle }
        )
  );
  listItems.forEach((result, index) => {
    const task = listItemTasks[index]!;
    if (result.ok) {
      all.push(...result.value);
      completedFacets.push(task.facetId);
    } else {
      failures.push({
        ...snapshotFailure('sync_lists_items', result.error),
        facetId: task.facetId,
      });
    }
  });
  const listItemsComplete = listRows.every((list) => {
    const listId = identifier(list.id);
    return listId && (completed.has(`sync_lists_items:${listId}`) || completedFacets.includes(`sync_lists_items:${listId}`));
  });
  if (listItemsComplete && failures.every((failure) => failure.endpoint !== 'sync_lists')) {
    completedFacets.push('sync_lists_items');
    if (completed.has('sync_lists') || settled.some((result, index) =>
      pendingTasks[index]?.facetId === 'sync_lists' && result.ok
    )) completedFacets.push('sync_lists');
  }
  const latestById = new Map<string, TrackerRecord>();
  for (const record of all) {
    const current = latestById.get(record.id);
    if (!current || record.updatedAt > current.updatedAt)
      latestById.set(record.id, record);
  }
  return {
    records: [...latestById.values()],
    failures,
    completedFacets,
    authoritative: completed.size === 0 && failures.length === 0,
  };
}

/** Strict compatibility wrapper for call sites that require a complete snapshot. */
export async function fetchWeTrakrAccountRecords(
  request: WeTrakrPageRequest
): Promise<TrackerRecord[]> {
  const snapshot = await fetchWeTrakrAccountSnapshot(request);
  if (snapshot.failures.length) {
    const failure = snapshot.failures[0]!;
    const error = Object.assign(
      new Error('WeTrakr account snapshot is incomplete'),
      failure
    );
    throw error;
  }
  return snapshot.records;
}

export type WeTrakrJournalDelta = {
  records: TrackerRecord[];
  entryIds: string[];
  checkpoint: string;
};

/**
 * Read WeTrakr's incremental journal. The visible_until checkpoint is supplied
 * by the API so delayed journal entries are not skipped; entry IDs are returned
 * separately because several changes can share the same action timestamp.
 */
export async function fetchWeTrakrJournalDelta(
  request: WeTrakrPageRequest,
  fromDate: string,
  maxPages = 100
): Promise<WeTrakrJournalDelta> {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1_000)
    throw new Error('Invalid WeTrakr journal page limit');
  if (!fromDate.trim() || !Number.isFinite(Date.parse(fromDate)))
    throw new Error('A valid WeTrakr journal checkpoint is required');

  const records: TrackerRecord[] = [];
  const entryIds: string[] = [];
  let checkpoint: string | undefined;
  let pageCount: number | undefined;
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await request(
      `/sync/journal?from_date=${encodeURIComponent(fromDate)}&page=${page}&limit=1000`
    );
    const payload = object(response.data);
    const rows = pageRows(payload);
    const visibleUntil = text(payload.visible_until);
    if (
      visibleUntil &&
      (!checkpoint || Date.parse(visibleUntil) < Date.parse(checkpoint))
    ) {
      checkpoint = visibleUntil;
    }
    for (const row of rows) {
      const entryId = text(row.entry_id);
      if (entryId && entryId.length <= 220) entryIds.push(entryId);
      const record = mapWeTrakrJournalEntry(row);
      if (record) {
        records.push(record);
        if (text(row.category) === 'watched' && identifier(row.play_id)) {
          const playId = identifier(row.play_id)!;
          const playRecord = TrackerRecordSchema.safeParse({
            ...record,
            id: `${record.id}|play:${playId}`,
            ...(record.state === 'deleted'
              ? { state: 'deleted', deletedState: 'play' }
              : { state: 'play' }),
          });
          if (playRecord.success) records.push(playRecord.data);
        }
      }
    }
    if (pageCount === undefined) {
      const parsedPageCount = Number(
        response.headers.get('x-pagination-page-count')
      );
      if (Number.isInteger(parsedPageCount) && parsedPageCount > 0)
        pageCount = parsedPageCount;
      else if (rows.length < 1_000) pageCount = 1;
    }
    if (pageCount !== undefined) {
      if (page >= pageCount) break;
    } else if (rows.length < 1_000) {
      break;
    }
    if (page === maxPages) {
      throw new Error('WeTrakr journal exceeded the safe pagination limit');
    }
  }
  if (!checkpoint || !Number.isFinite(Date.parse(checkpoint))) {
    throw new Error(
      'WeTrakr journal response omitted a valid visible_until checkpoint'
    );
  }
  return {
    records,
    entryIds: [...new Set(entryIds)],
    checkpoint,
  };
}

export type WeTrakrWriteOperation = {
  method: 'POST' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
  recordIds: string[];
};

type MutableMediaBucket = Record<string, JsonObject[]>;

function providerIds(record: TrackerRecord): Record<string, string> | null {
  const ids = Object.fromEntries(
    Object.entries(record.ids).filter(
      ([key, value]) =>
        /^[a-z][a-z0-9_-]{0,31}$/i.test(key) &&
        typeof value === 'string' &&
        value.trim().length > 0
    )
  );
  return Object.keys(ids).length ? ids : null;
}

function upsertShow(
  shows: JsonObject[],
  ids: Record<string, string>
): JsonObject {
  const existing = shows.find(
    (show) => JSON.stringify(show.ids) === JSON.stringify(ids)
  );
  if (existing) return existing;
  const created: JsonObject = { ids };
  shows.push(created);
  return created;
}

/**
 * Build provider-side writes for ledger changes. Imported WeTrakr rows are
 * deliberately excluded, which prevents a pull -> merge -> push echo loop.
 * Writes use WeTrakr's Idempotency-Key contract so a retry after a timeout is
 * safe. Destructive note removals are intentionally omitted because WeTrakr's
 * endpoint removes every note for a title, not one specific note.
 */
export function planWeTrakrWrites(records: TrackerRecord[]): {
  operations: WeTrakrWriteOperation[];
  skipped: number;
} {
  const buckets = new Map<
    string,
    { media: MutableMediaBucket; recordIds: string[] }
  >();
  const directOperations: WeTrakrWriteOperation[] = [];
  let skipped = 0;

  for (const record of [...records].sort((a, b) => a.id.localeCompare(b.id))) {
    if (record.origin === 'wetrakr' || record.state === 'play') continue;
    const state =
      record.state === 'deleted' ? record.deletedState : record.state;
    const removing = record.state === 'deleted';
    const likeTarget =
      state === 'liked' &&
      (record.kind === 'list' || record.kind === 'comment') &&
      record.providerIdProvider === 'wetrakr' &&
      Boolean(record.providerId && /^\d{1,18}$/.test(record.providerId));
    const ids = providerIds(record);
    if ((!ids || record.kind === 'list') && !likeTarget) {
      skipped += 1;
      continue;
    }

    if (state === 'list') {
      if (
        record.kind === 'episode' ||
        record.listIdProvider !== 'wetrakr' ||
        !record.listId ||
        !/^\d{1,18}$/.test(record.listId)
      ) {
        skipped += 1;
        continue;
      }
      const field =
        record.kind === 'movie'
          ? 'movies'
          : record.kind === 'person'
            ? 'people'
            : 'shows';
      const path = `/sync/lists/${record.listId}/items${removing ? '/remove' : ''}`;
      const key = `list:${path}`;
      const bucket = buckets.get(key) ?? { media: {}, recordIds: [] };
      buckets.set(key, bucket);
      bucket.media[field] ??= [];
      bucket.media[field].push({
        ids,
        ...(!removing && record.listRank !== undefined
          ? { rank: record.listRank }
          : {}),
      });
      bucket.recordIds.push(record.id);
      continue;
    }

    if (state === 'note') {
      if (
        removing ||
        !record.text?.trim() ||
        record.kind === 'episode' ||
        record.text.length > 10_000
      ) {
        skipped += 1;
        continue;
      }
      const field =
        record.kind === 'movie'
          ? 'movies'
          : record.kind === 'person'
            ? 'people'
            : 'shows';
      const key = 'note:/notes';
      const bucket = buckets.get(key) ?? { media: {}, recordIds: [] };
      buckets.set(key, bucket);
      bucket.media[field] ??= [];
      bucket.media[field].push({
        ids,
        text: record.text,
        ...(record.spoiler !== undefined ? { spoiler: record.spoiler } : {}),
      });
      bucket.recordIds.push(record.id);
      continue;
    }

    if (state === 'comment') {
      if (removing) {
        if (
          record.providerIdProvider !== 'wetrakr' ||
          !record.providerId ||
          !/^\d{1,18}$/.test(record.providerId)
        ) {
          skipped += 1;
          continue;
        }
        directOperations.push({
          method: 'DELETE',
          path: `/sync/comments/${encodeURIComponent(record.providerId)}`,
          recordIds: [record.id],
        });
        continue;
      }
      if (
        ((!record.text || !record.text.trim()) && !record.reaction?.trim()) ||
        (record.text?.length ?? 0) > 10_000 ||
        record.kind === 'episode'
      ) {
        skipped += 1;
        continue;
      }
      const mediaField =
        record.kind === 'movie'
          ? 'movie'
          : record.kind === 'person'
            ? 'person'
            : 'show';
      directOperations.push({
        method: 'POST',
        path: '/sync/comments',
        body: {
          [mediaField]: { ids },
          ...(record.text?.trim() ? { text: record.text } : {}),
          ...(record.reaction?.trim()
            ? { reaction: record.reaction.trim() }
            : {}),
          ...(record.spoiler !== undefined ? { spoiler: record.spoiler } : {}),
        },
        recordIds: [record.id],
      });
      continue;
    }

    if (state === 'liked') {
      const targetId = record.providerId;
      if (
        (record.kind !== 'list' && record.kind !== 'comment') ||
        record.providerIdProvider !== 'wetrakr' ||
        !targetId ||
        !/^\d{1,18}$/.test(targetId)
      ) {
        skipped += 1;
        continue;
      }
      directOperations.push({
        method: removing ? 'DELETE' : 'POST',
        path: `/${record.kind === 'list' ? 'lists' : 'comments'}/${targetId}/like`,
        recordIds: [record.id],
      });
      continue;
    }

    // Like-only list/comment rows intentionally carry a provider ID instead
    // of global media IDs; all remaining writes require global IDs.
    if (!ids) {
      skipped += 1;
      continue;
    }

    let path: string;
    let field: string;
    let status: string | undefined;
    let operation: 'tracking' | 'ratings' | 'favorites';

    if (
      state === 'watched' ||
      state === 'in_progress' ||
      state === 'watchlist' ||
      state === 'waiting' ||
      state === 'paused' ||
      state === 'ignored' ||
      state === 'dropped'
    ) {
      operation = 'tracking';
      path = removing ? '/sync/tracking/remove' : '/sync/tracking';
      status =
        state === 'in_progress'
          ? 'watching'
          : state === 'watchlist'
            ? 'planning'
            : state;
      field = record.kind === 'movie' ? 'movies' : 'shows';
      if (
        record.kind !== 'movie' &&
        record.kind !== 'series' &&
        record.kind !== 'episode'
      ) {
        skipped += 1;
        continue;
      }
    } else if (state === 'rated') {
      operation = 'ratings';
      path = removing ? '/sync/ratings/remove' : '/sync/ratings';
      field =
        record.kind === 'movie'
          ? 'movies'
          : record.kind === 'person'
            ? 'people'
            : 'shows';
      if (
        record.kind !== 'movie' &&
        record.kind !== 'series' &&
        record.kind !== 'episode' &&
        record.kind !== 'person'
      ) {
        skipped += 1;
        continue;
      }
    } else if (state === 'favorite') {
      operation = 'favorites';
      path = removing ? '/sync/favorites/remove' : '/sync/favorites';
      field =
        record.kind === 'movie'
          ? 'movies'
          : record.kind === 'person'
            ? 'people'
            : 'shows';
      if (
        record.kind !== 'movie' &&
        record.kind !== 'series' &&
        record.kind !== 'episode' &&
        record.kind !== 'person'
      ) {
        skipped += 1;
        continue;
      }
    } else {
      // Unsupported facets stay in the shared ledger instead of being silently
      // coerced into a different provider object or state.
      skipped += 1;
      continue;
    }

    const bucketKey = `${operation}:${path}`;
    const bucket = buckets.get(bucketKey) ?? { media: {}, recordIds: [] };
    buckets.set(bucketKey, bucket);
    bucket.media[field] ??= [];
    bucket.recordIds.push(record.id);

    const item: JsonObject = { ids };
    if (operation === 'tracking') item.status = status;
    if (operation === 'ratings' && !removing) {
      if (record.rating === undefined) {
        skipped += 1;
        bucket.recordIds.pop();
        continue;
      }
      item.rating = Math.round(record.rating * 10) / 10;
    }
    if (operation === 'favorites' && !removing && record.text)
      item.why = record.text.slice(0, 240);

    if (record.kind === 'episode') {
      if (record.season === undefined || record.episode === undefined) {
        skipped += 1;
        bucket.recordIds.pop();
        continue;
      }
      const show = upsertShow(bucket.media.shows, ids);
      const seasons = (show.seasons ??= []) as JsonObject[];
      let season = seasons.find((entry) => entry.number === record.season);
      if (!season) {
        season = { number: record.season };
        seasons.push(season);
      }
      const episodes = (season.episodes ??= []) as JsonObject[];
      episodes.push({
        number: record.episode,
        ...(status ? { status } : {}),
        ...(item.rating !== undefined ? { rating: item.rating } : {}),
      });
    } else {
      bucket.media[field].push(item);
    }
  }

  const operations = [...buckets.entries()]
    .map(([key, bucket]) => {
      const separator = key.indexOf(':');
      const [, path] = [key.slice(0, separator), key.slice(separator + 1)];
      return {
        method: 'POST' as const,
        path,
        body: {
          ...bucket.media,
          ...(path === '/sync/tracking' ? { allow_rewatch: false } : {}),
        },
        recordIds: [...new Set(bucket.recordIds)],
      };
    })
    .filter(
      (operation) =>
        operation.body !== undefined &&
        Object.values(operation.body).some(
          (value) => Array.isArray(value) && value.length > 0
        )
    );

  return { operations: [...operations, ...directOperations], skipped };
}

/** Apply safe, idempotent ledger mutations to the linked WeTrakr account. */
export async function pushWeTrakrRecords(
  records: TrackerRecord[],
  request: (
    path: string,
    init: { method: 'POST' | 'DELETE'; body?: unknown; idempotencyKey: string }
  ) => Promise<{ data: unknown }>
): Promise<{ synced: number; skipped: number }> {
  const plan = planWeTrakrWrites(records);
  const recordsById = new Map(records.map((record) => [record.id, record]));
  let synced = 0;
  for (const operation of plan.operations) {
    const versions = operation.recordIds
      .map((id) => `${id}@${recordsById.get(id)?.updatedAt ?? 0}`)
      .sort();
    const idempotencyKey = createHash('sha256')
      .update(operation.path)
      .update('\0')
      .update(
        operation.body === undefined ? '' : JSON.stringify(operation.body)
      )
      .update('\0')
      .update(versions.join('\n'))
      .digest('hex');
    await request(operation.path, {
      method: operation.method,
      ...(operation.body ? { body: operation.body } : {}),
      idempotencyKey,
    });
    synced += operation.recordIds.length;
  }
  return { synced, skipped: plan.skipped };
}
