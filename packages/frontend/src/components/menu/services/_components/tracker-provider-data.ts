import type { TrackerRecord } from '@aiostreams/core';

export interface WeTrakrCatalogItem extends Record<string, unknown> {
  title?: string;
  name?: string;
  poster_path?: string;
  posterUrl?: string;
  poster_url?: string;
  year?: number | string;
}

const COLLECTION_KEYS = [
  'results',
  'items',
  'records',
  'history',
  'movies',
  'shows',
  'episodes',
  'people',
  'lists',
  'comments',
] as const;

export type CatalogTrackerMutation =
  | { state: 'rated'; rating: number }
  | { state: 'favorite' }
  | { state: 'note'; text: string; spoiler?: boolean }
  | {
      state: 'comment';
      text?: string;
      reaction?: string;
      spoiler?: boolean;
    };

/** Explain WeTrakr API failures caused by a link that is only locally edited. */
export function trackerActionErrorMessage(
  error: unknown,
  fallback: string
): string {
  const message = error instanceof Error ? error.message : '';
  if (
    message.toLowerCase().includes(
      'connect and enable wetrakr in this aiostreams profile first'
    )
  ) {
    return 'The saved AIOStreams profile does not have WeTrakr enabled yet. Use the main Save button to save this configuration, then retry.';
  }
  return message || fallback;
}

function tombstone(record: TrackerRecord, now: number): TrackerRecord {
  const deletedState: TrackerRecord['deletedState'] =
    record.state === 'deleted'
      ? record.deletedState
      : (record.state as Exclude<TrackerRecord['state'], 'deleted'>);
  if (!deletedState) return record;
  return {
    ...record,
    state: 'deleted',
    deletedState,
    updatedAt: Math.max(Math.floor(now), record.updatedAt + 1),
    origin: 'aiostreams-ui',
    revision: record.revision + 1,
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Normalize catalog, account-list, and watched-history response envelopes. */
export function catalogItems(
  data: unknown,
  maxItems = 40
): WeTrakrCatalogItem[] {
  if (Array.isArray(data)) return asItems(data, maxItems);

  const root = object(data);
  if (!root) return [];
  if (Array.isArray(root.data)) return asItems(root.data, maxItems);

  const nested = object(root.data) ?? root;
  const direct = COLLECTION_KEYS.flatMap((key) =>
    Array.isArray(nested[key]) ? (nested[key] as unknown[]) : []
  );
  const fallback = Object.values(nested).find(Array.isArray);
  return asItems(direct.length ? direct : (fallback ?? []), maxItems);
}

function asItems(rows: unknown[], maxItems = 40): WeTrakrCatalogItem[] {
  const seen = new Set<unknown>();
  const result: WeTrakrCatalogItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || seen.has(row))
      continue;
    seen.add(row);
    const item = row as Record<string, unknown>;
    const likedTarget = object(item.list) ?? object(item.comment);
    result.push(
      (likedTarget
        ? {
            ...likedTarget,
            like_added_at: item.like_added_at,
            likedTargetType: item.list ? 'list' : 'comment',
          }
        : item) as WeTrakrCatalogItem
    );
    if (result.length === maxItems) break;
  }
  return result;
}

function portableCatalogIdentity(
  item: WeTrakrCatalogItem,
  mediaType: string
): {
  kind: 'movie' | 'series' | 'person';
  ids: Record<string, string>;
  title?: string;
  baseId: string;
} | null {
  const kind =
    mediaType === 'movie'
      ? 'movie'
      : mediaType === 'show' || mediaType === 'series'
        ? 'series'
        : mediaType === 'person'
          ? 'person'
          : null;
  if (!kind) return null;

  const nested = [item.movie, item.show, item.series, item.person].find(
    (value) => value && typeof value === 'object' && !Array.isArray(value)
  );
  const media = (nested as Record<string, unknown> | undefined) ?? item;
  const sourceIds =
    media.ids && typeof media.ids === 'object' && !Array.isArray(media.ids)
      ? (media.ids as Record<string, unknown>)
      : {};
  const ids = Object.fromEntries(
    Object.entries(sourceIds)
      .filter(
        ([key, value]) =>
          /^[a-z][a-z0-9_-]{0,31}$/i.test(key) &&
          (typeof value === 'string' || typeof value === 'number') &&
          String(value).trim().length > 0 &&
          String(value).length <= 160
      )
      .map(([key, value]) => [key.toLowerCase(), String(value).trim()])
  );
  const stableExternal = [
    'imdb',
    'tmdb',
    'tvdb',
    'trakt',
    'simkl',
    'mal',
    'anidb',
    'anilist',
    'kitsu',
  ].find((key) => ids[key]);
  if (!stableExternal) return null;
  const title = media.title ?? media.name ?? item.title ?? item.name;
  return {
    kind,
    ids,
    ...(typeof title === 'string' ? { title: title.slice(0, 500) } : {}),
    baseId: `${kind}:${stableExternal}:${ids[stableExternal]}`,
  };
}

/** Build a provider-neutral write that AIOStreams can merge and fan out. */
export function makeCatalogTrackerRecord(
  item: WeTrakrCatalogItem,
  mediaType: string,
  mutation: CatalogTrackerMutation,
  now = Date.now(),
  commentId: string | undefined = globalThis.crypto?.randomUUID?.()
): TrackerRecord | null {
  const identity = portableCatalogIdentity(item, mediaType);
  if (!identity) return null;
  if (
    mutation.state === 'rated' &&
    (!Number.isFinite(mutation.rating) ||
      mutation.rating < 0 ||
      mutation.rating > 10)
  ) {
    return null;
  }
  if (
    mutation.state === 'note' &&
    (!mutation.text.trim() || mutation.text.length > 10_000)
  ) {
    return null;
  }
  if (
    mutation.state === 'comment' &&
    !mutation.text?.trim() &&
    !mutation.reaction?.trim()
  ) {
    return null;
  }
  if (
    mutation.state === 'comment' &&
    ((mutation.text?.length ?? 0) > 10_000 ||
      (mutation.reaction?.length ?? 0) > 80)
  ) {
    return null;
  }
  if (mutation.state === 'comment' && !commentId) return null;

  const facetId =
    mutation.state === 'comment'
      ? `comment:${commentId}`
      : mutation.state;
  return {
    id: `${identity.baseId}|${facetId}`,
    kind: identity.kind,
    ids: identity.ids,
    ...(identity.title ? { title: identity.title } : {}),
    state: mutation.state,
    ...(mutation.state === 'rated' ? { rating: mutation.rating } : {}),
    ...('text' in mutation && mutation.text?.trim()
      ? { text: mutation.text.trim() }
      : {}),
    ...('reaction' in mutation && mutation.reaction?.trim()
      ? { reaction: mutation.reaction.trim() }
      : {}),
    ...('spoiler' in mutation && mutation.spoiler !== undefined
      ? { spoiler: mutation.spoiler }
      : {}),
    updatedAt: Math.max(1, Math.floor(now)),
    origin: 'aiostreams-ui',
    revision: 0,
  };
}

/** Delete only provider-neutral facets with safe, item-scoped delete support. */
export function makeCatalogTrackerTombstone(
  item: WeTrakrCatalogItem,
  mediaType: string,
  state: 'favorite' | 'rated',
  now = Date.now()
): TrackerRecord | null {
  const active = makeCatalogTrackerRecord(
    item,
    mediaType,
    state === 'rated' ? { state: 'rated', rating: 0 } : { state: 'favorite' },
    now
  );
  return active ? tombstone(active, now) : null;
}

/** Build the same stable list-membership identity used by WeTrakr imports. */
export function makeListMembershipRecord(
  item: WeTrakrCatalogItem,
  mediaType: string,
  list: WeTrakrCatalogItem,
  state: 'list' | 'deleted' = 'list',
  now = Date.now()
): TrackerRecord | null {
  const listId = String(list.id ?? '');
  const identity = portableCatalogIdentity(item, mediaType);
  if (!identity || !/^\d{1,18}$/.test(listId)) return null;
  // WeTrakr distinguishes its numeric item id from external ids. Do not put
  // that local id in `ids`; writes would treat it as an external identifier.
  // Decline the merged write if this catalog row lacks a portable id.
  const listTitle = String(list.name ?? list.title ?? `WeTrakr list ${listId}`);

  return {
    id: `${identity.baseId}|list:${listId}`,
    kind: identity.kind,
    ids: identity.ids,
    ...(identity.title ? { title: identity.title } : {}),
    state,
    ...(state === 'deleted' ? { deletedState: 'list' as const } : {}),
    listId,
    listIdProvider: 'wetrakr',
    listName: listTitle.slice(0, 200),
    updatedAt: Math.max(1, Math.floor(now)),
    origin: 'aiostreams-ui',
    revision: 0,
  };
}

/** Restrict externally supplied artwork to the known TMDB image host. */
export function catalogPoster(item: WeTrakrCatalogItem): string | null {
  const raw = item.posterUrl ?? item.poster_url ?? item.poster_path;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  if (raw.startsWith('/')) return `https://image.tmdb.org/t/p/w185${raw}`;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' &&
      url.hostname === 'image.tmdb.org' &&
      !url.username &&
      !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
