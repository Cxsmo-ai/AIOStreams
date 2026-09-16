import {
  createLogger,
  getTimeTakenSincePoint,
  ExtrasParser,
  getSimpleTextHash,
  maskSensitiveInfo,
  userScopeKey,
} from '../utils/index.js';
import { Wrapper } from './wrapper.js';
import { createPosterService } from '../poster/index.js';
import { getAddonName } from '../utils/general.js';
import { IdParser } from '../utils/id-parser.js';
import { normaliseTitle } from '../parser/utils.js';
import type {
  MetaPreview,
  MergedCatalog,
  Meta,
  Preset,
} from '../db/schemas.js';
import type { Manifest } from '../db/index.js';
import type { AIOStreamsContext, AIOStreamsResponse } from './types.js';
import {
  shuffleCache,
  mergedCatalogCache,
  type MergedCatalogSkipState,
} from './caches.js';

const logger = createLogger('core');

function hasCatalogValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function rootSeriesCatalogId(id: string): string {
  const parsed = IdParser.parse(id, 'series');
  if (!parsed || (!parsed.season && !parsed.episode)) return id;

  // Catalog providers occasionally expose one preview per season/episode using
  // the Stremio playback-ID suffix. A series catalog must point at the root
  // series ID so the client opens one show with its complete season list.
  const suffix =
    parsed.season && parsed.episode
      ? `:${parsed.season}:${parsed.episode}`
      : `:${parsed.episode}`;
  return id.endsWith(suffix) ? id.slice(0, -suffix.length) : id;
}

function seriesTitleWithoutSeasonSuffix(name: string): string {
  return name
    .replace(/\s*[-:|]?\s*(?:season|series)\s*\d+\s*$/i, '')
    .replace(/\s*[-:|]?\s*s\d{1,2}(?:e\d{1,4})?\s*$/i, '')
    .trim();
}

function withoutSeriesEpisodeFields(
  item: MetaPreview,
  id: string
): MetaPreview {
  const normalized = { ...item, id } as MetaPreview & {
    season?: unknown;
    episode?: unknown;
  };
  delete normalized.season;
  delete normalized.episode;
  return normalized;
}

function mergeCatalogPreview(
  primary: MetaPreview,
  fallback: MetaPreview
): MetaPreview {
  const primaryScore = catalogPreviewRichness(primary);
  const fallbackScore = catalogPreviewRichness(fallback);
  const preferred = canonicalCatalogPreview(
    primary,
    fallback,
    primaryScore >= fallbackScore
  );
  const secondary = preferred === primary ? fallback : primary;
  const merged = { ...secondary, ...preferred };

  // Prefer a populated value, while allowing a root preview to replace a
  // season-only placeholder. This keeps one stable poster and useful text.
  for (const key of [
    'name',
    'poster',
    'posterShape',
    'description',
    'imdbRating',
    'releaseInfo',
  ] as const) {
    if (!hasCatalogValue(preferred[key]) && hasCatalogValue(secondary[key])) {
      (merged as any)[key] = secondary[key];
    }
  }

  if (primary.genres || fallback.genres) {
    merged.genres = [
      ...new Set([...(fallback.genres ?? []), ...(primary.genres ?? [])]),
    ];
  }
  merged.links = mergeCatalogLinks(primary.links, fallback.links);
  merged.trailers = mergeCatalogTrailers(primary.trailers, fallback.trailers);

  const primaryRating = Number(primary.imdbRating);
  const fallbackRating = Number(fallback.imdbRating);
  if (
    Number.isFinite(primaryRating) &&
    Number.isFinite(fallbackRating) &&
    fallbackRating > primaryRating
  ) {
    merged.imdbRating = fallback.imdbRating;
  }
  return merged;
}

function catalogPreviewRichness(item: MetaPreview): number {
  let score = 0;
  if (hasCatalogValue(item.poster)) score += 3;
  if (hasCatalogValue(item.description)) score += 2;
  if (hasCatalogValue(item.releaseInfo)) score += 1;
  if (hasCatalogValue(item.imdbRating)) score += 1;
  if (item.genres?.length) score += 1;
  if (item.links?.length) score += 1;
  if (item.trailers?.length) score += 1;
  for (const key of [
    'imdb_id',
    'imdbId',
    'tmdb_id',
    'tmdbId',
    'tvdb_id',
    'tvdbId',
  ]) {
    if (hasCatalogValue((item as any)[key])) score += 2;
  }
  return score;
}

function catalogIdentityRank(item: MetaPreview): number {
  const id = String(item.id || '').toLowerCase();
  if (/^tt\d+(?::\d+:\d+)?$/.test(id)) return 3;
  if (/^tmdb[:-]\d+(?::\d+:\d+)?$/.test(id)) return 2;
  if (/^tvdb[:-]\d+(?::\d+:\d+)?$/.test(id)) return 1;
  if (
    hasCatalogValue((item as any).imdb_id) ||
    hasCatalogValue((item as any).imdbId)
  )
    return 3;
  if (
    hasCatalogValue((item as any).tmdb_id) ||
    hasCatalogValue((item as any).tmdbId)
  )
    return 2;
  if (
    hasCatalogValue((item as any).tvdb_id) ||
    hasCatalogValue((item as any).tvdbId)
  )
    return 1;
  return 0;
}

function canonicalCatalogPreview(
  primary: MetaPreview,
  fallback: MetaPreview,
  preferPrimary: boolean
): MetaPreview {
  const primaryRank = catalogIdentityRank(primary);
  const fallbackRank = catalogIdentityRank(fallback);
  if (primaryRank !== fallbackRank) {
    return primaryRank > fallbackRank ? primary : fallback;
  }
  return preferPrimary ? primary : fallback;
}

function mergeCatalogLinks(
  primary: MetaPreview['links'],
  fallback: MetaPreview['links']
): MetaPreview['links'] {
  const links = [...(primary ?? []), ...(fallback ?? [])];
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${link.name}\u0000${link.category}\u0000${link.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeCatalogTrailers(
  primary: MetaPreview['trailers'],
  fallback: MetaPreview['trailers']
): MetaPreview['trailers'] {
  const trailers = [...(primary ?? []), ...(fallback ?? [])];
  const seen = new Set<string>();
  return trailers.filter((trailer) => {
    const key = `${trailer.source}\u0000${trailer.type}\u0000${trailer.video_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Catalog providers sometimes return a series once for every season or first
 * episode (for example `tt1234567:1:1` through `tt1234567:10:1`). Those are
 * playback IDs, not distinct catalog titles. Canonicalize only recognized
 * series IDs and merge the previews so Stremio shows one poster/card for the
 * complete series. Movies and unknown/provider-specific IDs are unchanged.
 */
export function normalizeSeriesCatalogItems(
  items: MetaPreview[],
  type: string
): MetaPreview[] {
  if (type !== 'series' || items.length === 0) return items;

  const grouped = new Map<string, { item: MetaPreview; root: boolean }>();
  for (const item of items) {
    const rootId = rootSeriesCatalogId(item.id);
    const root = rootId === item.id;
    const normalized = withoutSeriesEpisodeFields(item, rootId);
    if (!root && typeof normalized.name === 'string') {
      const canonicalTitle = seriesTitleWithoutSeasonSuffix(normalized.name);
      if (canonicalTitle) normalized.name = canonicalTitle;
    }
    const existing = grouped.get(rootId);

    if (!existing) {
      grouped.set(rootId, { item: normalized, root });
      continue;
    }

    // A true root preview is more authoritative than a season-generated one,
    // but retain useful poster/text fields from both entries.
    if (root && !existing.root) {
      grouped.set(rootId, {
        item: mergeCatalogPreview(normalized, existing.item),
        root: true,
      });
    } else {
      existing.item = mergeCatalogPreview(existing.item, normalized);
    }
  }
  return [...grouped.values()].map(({ item }) => item);
}

export function convertDiscoverDeepLinks(
  ctx: Pick<AIOStreamsContext, 'addons' | 'manifestUrl'>,
  items: Meta['links']
): Meta['links'] {
  if (!items) {
    return items;
  }
  return items.map((link) => {
    try {
      if (link.url.startsWith('stremio:///discover/')) {
        const linkUrl = new URL(decodeURIComponent(link.url.split('/')[4]));
        const addon = ctx.addons.find(
          (a) => new URL(a.manifestUrl).hostname === linkUrl.hostname
        );
        if (addon) {
          const [_, linkType, catalogIdAndQuery] = link.url
            .replace('stremio:///discover/', '')
            .split('/');
          const newCatalogId = `${addon.instanceId}.${catalogIdAndQuery}`;
          const newTransportUrl = encodeURIComponent(ctx.manifestUrl);
          link.url = `stremio:///discover/${newTransportUrl}/${linkType}/${newCatalogId}`;
        }
      }
    } catch {}
    return link;
  });
}

export async function fetchRawCatalogItems(
  ctx: AIOStreamsContext,
  addonInstanceId: string,
  catalogId: string,
  type: string,
  parsedExtras?: ExtrasParser
): Promise<{
  success: boolean;
  items: MetaPreview[];
  error?: { title: string; description: string };
}> {
  const addon = ctx.addons.find((a) => a.instanceId === addonInstanceId);

  if (!addon) {
    const initError = (
      ctx.addonInitialisationErrors as { addon: Preset; error: string }[]
    ).find((e) => addonInstanceId.startsWith(e.addon.instanceId || ''));
    if (initError) {
      return {
        success: false,
        items: [],
        error: {
          title: `[❌] ${initError.error}`,
          description: `Addon ${addonInstanceId} failed to initialise. Try reinstalling/disabling/uninstalling the addon.`,
        },
      };
    }
    return {
      success: false,
      items: [],
      error: {
        title: `Addon ${addonInstanceId} not found. Try reinstalling the addon.`,
        description: 'Addon not found',
      },
    };
  }

  // Check for type override in modifications
  let actualType = type;
  const modification = ctx.userData.catalogModifications?.find(
    (mod) =>
      mod.id === `${addonInstanceId}.${catalogId}` &&
      (mod.type === type || mod.overrideType === type)
  );
  if (modification?.overrideType) {
    actualType = modification.type;
  }

  if (parsedExtras?.genre === 'None') {
    parsedExtras.genre = undefined;
  }
  const extrasString = parsedExtras?.toString();

  try {
    const start = Date.now();
    let catalog = await new Wrapper(addon).getCatalog(
      actualType,
      catalogId,
      extrasString
    );

    // Deep catalog fetching: fetch additional pages in parallel to keep latency low (~3s) while populating up to 200 items
    if (
      !parsedExtras?.search &&
      catalog &&
      catalog.length > 0 &&
      catalog.length < 200
    ) {
      try {
        const pageSize = catalog.length;
        const startSkip = (parsedExtras?.skip || 0) + pageSize;
        const pageSkips = [
          startSkip,
          startSkip + pageSize,
          startSkip + pageSize * 2,
        ];
        const pageResults = await Promise.all(
          pageSkips.map(async (skip) => {
            try {
              const nextExtras = new ExtrasParser(extrasString);
              nextExtras.skip = skip;
              return await new Wrapper(addon).getCatalog(
                actualType,
                catalogId,
                nextExtras.toString()
              );
            } catch {
              return [];
            }
          })
        );
        const seenIds = new Set(catalog.map((i) => i.id));
        for (const pageItems of pageResults) {
          if (Array.isArray(pageItems)) {
            for (const item of pageItems) {
              if (item?.id && !seenIds.has(item.id)) {
                seenIds.add(item.id);
                catalog.push(item);
              }
            }
          }
        }
      } catch {}
    }

    catalog = normalizeSeriesCatalogItems(catalog, actualType);
    catalog = deduplicateCatalogItems(catalog, ['id', 'title'], actualType);

    logger.debug(
      {
        addon: addon.name,
        catalogId,
        type: actualType,
        count: catalog?.length || 0,
        took: getTimeTakenSincePoint(start),
      },
      'received catalog'
    );
    return { success: true, items: catalog };
  } catch (error) {
    return {
      success: false,
      items: [],
      error: {
        title: `[❌] ${addon.name}`,
        description: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function getCatalogExtras(
  ctx: Pick<AIOStreamsContext, 'manifests'>,
  addonInstanceId: string,
  catalogId: string,
  catalogType: string
): Manifest['catalogs'][number]['extra'] | undefined {
  const manifest = ctx.manifests[addonInstanceId];
  if (!manifest) return undefined;

  const catalog = manifest.catalogs?.find(
    (c) => c.id === catalogId && c.type === catalogType
  );
  return catalog?.extra;
}

/**
 * Applies poster modifications to catalog items.
 */
export async function applyPosterModifications(
  ctx: AIOStreamsContext,
  items: MetaPreview[],
  type: string,
  applyPosterService: boolean = true
): Promise<MetaPreview[]> {
  const posterApi = applyPosterService
    ? createPosterService(ctx.userData)
    : null;

  return Promise.all(
    items.map(async (item) => {
      if (posterApi && item.poster) {
        let posterUrl = item.poster;
        if (posterApi.isPosterFromThisService(posterUrl)) {
          // already a poster from this service, do nothing
        } else if (ctx.userData.usePosterRedirectApi) {
          const itemId = (item as any).imdb_id || item.id;
          posterUrl = posterApi.buildRedirectUrl(itemId, type, item.poster);
        } else {
          const servicePosterUrl = await posterApi.getPosterUrl(
            type,
            (item as any).imdb_id || item.id,
            false
          );
          if (servicePosterUrl) {
            posterUrl = servicePosterUrl;
          }
        }
        item.poster = posterUrl;
      }
      if (!item.poster && item.id && /^tt\d+/i.test(item.id)) {
        item.poster = `https://images.metahub.space/poster/medium/${item.id}/img.jpg`;
      }

      if (item.links) {
        item.links = convertDiscoverDeepLinks(ctx, item.links);
      }
      return item;
    })
  );
}

/**
 * Applies catalog modifications like shuffle, reverse, poster service, etc.
 * Used by getCatalog for standalone catalogs and getMergedCatalog for source catalogs.
 */
export function isNsfwContent(item: {
  name?: string;
  title?: string;
  description?: string;
  genres?: string[];
  tags?: string[];
  isAdult?: boolean;
  adult?: boolean;
}): boolean {
  if (item.isAdult || item.adult) return true;
  const nsfwPatterns =
    /\b(xxx|porn|porno|pornography|erotica?|hentai|jav|adult|nsfw|sensual|18\+|sex\s*tape|brazzers|onlyfans|blowjob|hardcore|softcore|nude|nudity|milf|shemale|femdom|incest|dildo|vibrator|fetish)\b/i;
  const text = `${item.name || ''} ${item.title || ''} ${item.description || ''} ${(item.genres || []).join(' ')} ${(item.tags || []).join(' ')}`;
  if (nsfwPatterns.test(text)) return true;
  if (
    item.genres?.some((g: string) =>
      ['Adult', 'Erotica', 'Hentai', 'Pornography', 'XXX', 'NSFW'].includes(g)
    )
  )
    return true;
  return false;
}

export function filterNsfwCatalogItems(items: MetaPreview[]): MetaPreview[] {
  return items.filter((item) => !isNsfwContent(item as any));
}

export async function applyCatalogModifications(
  ctx: AIOStreamsContext,
  items: MetaPreview[],
  catalogId: string,
  type: string,
  parsedExtras?: ExtrasParser,
  shuffleCacheKey?: string
): Promise<MetaPreview[]> {
  let catalog = [...items];
  const isSearch = parsedExtras?.search;

  const modification = ctx.userData.catalogModifications?.find(
    (mod) =>
      mod.id === catalogId && (mod.type === type || mod.overrideType === type)
  );
  const applyShuffle = modification?.shuffle && !isSearch && shuffleCacheKey;
  const applyReverse = !applyShuffle && modification?.reverse && !isSearch;

  logger.debug(
    {
      catalogId,
      type,
      modificationFound: !!modification,
      shuffle: !!applyShuffle,
      reverse: !!applyReverse,
    },
    'applying catalog modifications'
  );

  if (applyShuffle) {
    const cachedShuffle = await shuffleCache.get(shuffleCacheKey);
    if (cachedShuffle) {
      catalog = cachedShuffle;
    } else {
      for (let i = catalog.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [catalog[i], catalog[j]] = [catalog[j], catalog[i]];
      }
      if (modification.persistShuffleFor) {
        await shuffleCache.set(
          shuffleCacheKey,
          catalog,
          modification.persistShuffleFor * 3600
        );
      }
    }
  } else if (applyReverse) {
    catalog = catalog.reverse();
  }

  const applyPosterService = modification?.usePosterService === true;
  catalog = await applyPosterModifications(
    ctx,
    catalog,
    type,
    applyPosterService
  );

  catalog = filterNsfwCatalogItems(catalog);
  return catalog;
}

/**
 * Extracts a year from releaseInfo which can be a number (year) or string (year or year-year range).
 * For ranges like "2020-2024", returns the first year.
 */
function extractYear(releaseInfo: number | string | undefined | null): number {
  if (releaseInfo === undefined || releaseInfo === null) return 0;
  if (typeof releaseInfo === 'number') return releaseInfo;
  const match = String(releaseInfo).match(/^(\d{4})/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Applies merge method to combine items from multiple source catalogs.
 */
function applyMergeMethod(
  itemsBySource: MetaPreview[][],
  method?: MergedCatalog['mergeMethod']
): MetaPreview[] {
  const mergeMethod = method || 'sequential';

  switch (mergeMethod) {
    case 'interleave': {
      const result: MetaPreview[] = [];
      const maxLength = Math.max(0, ...itemsBySource.map((arr) => arr.length));
      for (let i = 0; i < maxLength; i++) {
        for (const sourceItems of itemsBySource) {
          if (i < sourceItems.length) {
            result.push(sourceItems[i]);
          }
        }
      }
      return result;
    }

    case 'imdbRating': {
      const allItems = itemsBySource.flat();
      return allItems.sort((a, b) => {
        const ratingA = parseFloat(a.imdbRating?.toString() ?? '0');
        const ratingB = parseFloat(b.imdbRating?.toString() ?? '0');
        if (isNaN(ratingA) && isNaN(ratingB)) return 0;
        if (isNaN(ratingA)) return 1;
        if (isNaN(ratingB)) return -1;
        return ratingB - ratingA;
      });
    }

    case 'releaseDateAsc': {
      const allItems = itemsBySource.flat();
      return allItems.sort(
        (a, b) => extractYear(a.releaseInfo) - extractYear(b.releaseInfo)
      );
    }

    case 'releaseDateDesc': {
      const allItems = itemsBySource.flat();
      return allItems.sort(
        (a, b) => extractYear(b.releaseInfo) - extractYear(a.releaseInfo)
      );
    }

    case 'sequential':
    default:
      return itemsBySource.flat();
  }
}

function catalogYear(item: MetaPreview): number | undefined {
  const year = extractYear(item.releaseInfo);
  return year > 0 ? year : undefined;
}

function catalogCountry(item: MetaPreview): string | undefined {
  const country = (item as any).country ?? (item as any).origin_country;
  if (Array.isArray(country))
    return country[0] ? String(country[0]).toLowerCase() : undefined;
  return hasCatalogValue(country) ? String(country).toLowerCase() : undefined;
}

function catalogTitle(item: MetaPreview): string {
  return normaliseTitle(
    String(item.name ?? '')
      .replace(/\s*\((?:19|20)\d{2}\)\s*$/i, '')
      .replace(/\s*[-:|]?\s*(?:season|series)\s*\d+\s*$/i, '')
      .replace(/\s*[-:|]?\s*s\d{1,2}(?:e\d{1,4})?\s*$/i, '')
  );
}

function catalogIdentityKeys(item: MetaPreview, type: string): string[] {
  const keys: string[] = [];
  const add = (namespace: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return;
    const normalized = String(value).trim().toLowerCase();
    if (normalized) keys.push(`${namespace}:${normalized}`);
  };

  for (const [namespace, names] of [
    ['imdb', ['imdb_id', 'imdbId']],
    ['tmdb', ['tmdb_id', 'tmdbId']],
    ['tvdb', ['tvdb_id', 'tvdbId']],
  ] as const) {
    for (const name of names) add(namespace, (item as any)[name]);
  }

  const parsed = IdParser.parse(item.id, type);
  if (parsed) {
    const namespace =
      parsed.type === 'imdbId'
        ? 'imdb'
        : parsed.type === 'themoviedbId'
          ? 'tmdb'
          : parsed.type === 'thetvdbId'
            ? 'tvdb'
            : undefined;
    if (namespace) add(namespace, parsed.value);
  }
  return [...new Set(keys)];
}

interface CatalogDedupGroup {
  item: MetaPreview;
  identityKeys: Set<string>;
  title: string;
  year?: number;
  country?: string;
}

function catalogIdentityNamespaces(keys: Iterable<string>): Set<string> {
  return new Set(
    [...keys].map((key) => key.slice(0, key.indexOf(':'))).filter(Boolean)
  );
}

function sameCatalogTitle(
  group: CatalogDedupGroup,
  item: MetaPreview,
  itemIdentityKeys: Set<string>
): boolean {
  const title = catalogTitle(item);
  if (!title || !group.title || title !== group.title) return false;
  const groupNamespaces = catalogIdentityNamespaces(group.identityKeys);
  const itemNamespaces = catalogIdentityNamespaces(itemIdentityKeys);
  const sharedNamespace = [...groupNamespaces].some((namespace) =>
    itemNamespaces.has(namespace)
  );
  if (
    sharedNamespace &&
    ![...itemIdentityKeys].some((key) => group.identityKeys.has(key))
  ) {
    return false;
  }
  const year = catalogYear(item);
  if (group.year !== undefined && year !== undefined && group.year !== year) {
    return false;
  }
  const country = catalogCountry(item);
  return !(group.country && country && group.country !== country);
}

/**
 * Deduplicate catalog records from different providers without collapsing
 * same-title reboots. Provider IDs are the strongest key; title matching is
 * only allowed when normalized titles agree and available years/countries do
 * not conflict. Duplicate records are merged so artwork, links, ratings, and
 * descriptions are retained instead of silently dropping the later source.
 */
export function deduplicateCatalogItems(
  items: MetaPreview[],
  methods: ('id' | 'title')[] = ['id', 'title'],
  type = 'series'
): MetaPreview[] {
  if (methods.length === 0 || items.length < 2) return items;

  const groups: CatalogDedupGroup[] = [];

  for (const item of items) {
    const identityKeys = new Set(catalogIdentityKeys(item, type));
    const matches = groups.filter((group) => {
      const identityMatch =
        methods.includes('id') &&
        [...identityKeys].some((key) => group.identityKeys.has(key));
      const titleMatch =
        methods.includes('title') &&
        sameCatalogTitle(group, item, identityKeys);
      return identityMatch || titleMatch;
    });

    if (matches.length === 0) {
      groups.push({
        item,
        identityKeys,
        title: catalogTitle(item),
        year: catalogYear(item),
        country: catalogCountry(item),
      });
      continue;
    }

    const target = matches[0]!;
    target.item = mergeCatalogPreview(target.item, item);
    for (const key of identityKeys) target.identityKeys.add(key);
    // Keep the blocking facts in sync with the enriched canonical record. This
    // prevents a sparse first record from becoming a bridge that incorrectly
    // merges a later reboot with a different year or country.
    target.title = catalogTitle(target.item);
    target.year = catalogYear(target.item);
    target.country = catalogCountry(target.item);
  }
  return groups.map((group) => group.item);
}

export async function getMergedCatalog(
  ctx: AIOStreamsContext,
  type: string,
  id: string,
  extras?: string
): Promise<AIOStreamsResponse<MetaPreview[]>> {
  const start = Date.now();
  const mergedCatalog = ctx.userData.mergedCatalogs?.find((mc) => mc.id === id);

  if (!mergedCatalog) {
    logger.error({ id }, 'merged catalog not found');
    return {
      success: false,
      data: [],
      errors: [
        {
          title: `Merged catalog ${id} not found`,
          description: 'Try reinstalling the addon.',
        },
      ],
    };
  }

  if (mergedCatalog.type !== type) {
    logger.error(
      { id, expected: mergedCatalog.type, got: type },
      'merged catalog type mismatch'
    );
    return {
      success: false,
      data: [],
      errors: [
        {
          title: `Type mismatch for merged catalog ${id}`,
          description: `Expected ${mergedCatalog.type}, got ${type}`,
        },
      ],
    };
  }

  const parsedExtras = new ExtrasParser(extras);
  const requestedSkip = parsedExtras.skip || 0;
  const isSearchRequest = !!parsedExtras.search;
  const requestedGenre = parsedExtras.genre;

  const extrasForCacheKey = new ExtrasParser(extras);
  extrasForCacheKey.skip = undefined;
  const extrasCacheKeyPart = extrasForCacheKey.toString();
  const deduplicationMethods = mergedCatalog.deduplicationMethods ?? [
    'id',
    'title',
  ];

  const configHash = getSimpleTextHash(
    JSON.stringify({
      catalogIds: mergedCatalog.catalogIds,
      deduplicationMethods,
      mergeMethod: mergedCatalog.mergeMethod,
    })
  );
  const baseCacheKey = `${id}-${userScopeKey(ctx.userData)}-${configHash}${extrasCacheKeyPart ? `-${extrasCacheKeyPart}` : ''}`;
  const skipCacheKey = `${baseCacheKey}-skip=${requestedSkip}`;

  let skipState: MergedCatalogSkipState | undefined;

  if (requestedSkip === 0) {
    skipState = { sourceSkips: {} };
    for (const encodedCatalogId of mergedCatalog.catalogIds) {
      skipState.sourceSkips[encodedCatalogId] = 0;
    }
  } else {
    skipState = await mergedCatalogCache.get(skipCacheKey);
    if (!skipState) {
      logger.warn(
        { id, skip: requestedSkip },
        'no cached skip state for merged catalog — cache may have expired or skip is invalid'
      );
      return { success: true, data: [], errors: [] };
    }
  }

  const nextSourceSkips: Record<string, number> = {
    ...skipState.sourceSkips,
  };

  const fetchPromises = mergedCatalog.catalogIds.map(
    async (encodedCatalogId: string) => {
      logger.debug({ encodedCatalogId }, 'handling merged catalog source');
      const params = new URLSearchParams(encodedCatalogId);
      const catalogId = params.get('id');
      const catalogType = params.get('type');
      if (!catalogId || !catalogType) {
        return {
          encodedCatalogId,
          items: [],
          fetched: 0,
          success: false,
          skipped: false,
        };
      }

      const addonInstanceId = catalogId.split('.', 2)[0];
      const actualCatalogId = catalogId.split('.').slice(1).join('.');

      const catalogExtras = getCatalogExtras(
        ctx,
        addonInstanceId,
        actualCatalogId,
        catalogType
      );

      if (isSearchRequest && !catalogExtras?.some((e) => e.name === 'search')) {
        logger.debug(
          { encodedCatalogId, catalog: mergedCatalog.name },
          'skipping merged catalog source: no search support'
        );
        return {
          encodedCatalogId,
          items: [],
          fetched: 0,
          success: true,
          skipped: true,
        };
      }

      if (requestedGenre && requestedGenre !== 'None') {
        const genreExtra = catalogExtras?.find((e) => e.name === 'genre');
        if (!genreExtra) {
          logger.debug(
            { encodedCatalogId, catalog: mergedCatalog.name },
            'skipping merged catalog source: no genre extra support'
          );
          return {
            encodedCatalogId,
            items: [],
            fetched: 0,
            success: true,
            skipped: true,
          };
        }
        if (genreExtra.options && genreExtra.options.length > 0) {
          const hasGenre = genreExtra.options.some(
            (opt) => opt === requestedGenre || opt === null
          );
          if (!hasGenre) {
            logger.debug(
              {
                encodedCatalogId,
                catalog: mergedCatalog.name,
                genre: requestedGenre,
              },
              'skipping merged catalog source: genre not offered'
            );
            return {
              encodedCatalogId,
              items: [],
              fetched: 0,
              success: true,
              skipped: true,
            };
          }
        }
      }

      const sourceSkip = skipState!.sourceSkips[encodedCatalogId] || 0;
      const supportsSkip = catalogExtras?.some((e) => e.name === 'skip');

      if (!supportsSkip && sourceSkip > 0) {
        logger.debug(
          { encodedCatalogId, catalog: mergedCatalog.name },
          'skipping merged catalog source: no skip support and already exhausted'
        );
        return {
          encodedCatalogId,
          items: [],
          fetched: 0,
          success: true,
          skipped: true,
        };
      }

      const sourceExtras = new ExtrasParser(extras);
      if (supportsSkip) {
        sourceExtras.skip = sourceSkip > 0 ? sourceSkip : undefined;
      } else {
        sourceExtras.skip = undefined;
      }

      const requiredExtras = catalogExtras?.filter((e) => e.isRequired);
      if (requiredExtras && requiredExtras.length > 0) {
        for (const reqExtra of requiredExtras) {
          if (!sourceExtras.has(reqExtra.name)) {
            logger.debug(
              {
                encodedCatalogId,
                catalog: mergedCatalog.name,
                extra: reqExtra.name,
              },
              'skipping merged catalog source: missing required extra'
            );
            return {
              encodedCatalogId,
              items: [],
              fetched: 0,
              success: true,
              skipped: true,
            };
          }
        }
      }

      logger.debug(
        {
          encodedCatalogId,
          addonInstanceId,
          catalogType,
          extras: sourceExtras.toString(),
        },
        'fetching merged catalog source'
      );

      const result = await fetchRawCatalogItems(
        ctx,
        addonInstanceId,
        actualCatalogId,
        catalogType,
        sourceExtras
      );

      if (!result.success) {
        logger.warn(
          {
            encodedCatalogId,
            catalog: mergedCatalog.name,
            skip: requestedSkip,
            err: result.error
              ? maskSensitiveInfo(result.error.description || '')
              : 'unknown',
          },
          'failed to fetch merged catalog source'
        );
        return {
          encodedCatalogId,
          items: [],
          fetched: 0,
          success: false,
          skipped: false,
        };
      }

      return {
        encodedCatalogId,
        items: result.items,
        fetched: result.items.length,
        success: true,
        skipped: false,
      };
    }
  );

  logger.debug(
    {
      catalog: mergedCatalog.name,
      skip: requestedSkip,
      sources: fetchPromises.length,
    },
    'fetching merged catalog'
  );

  const fetchResults = await Promise.all(fetchPromises);

  const nonSkippedResults = fetchResults.filter((r) => !r.skipped);
  const allFailed =
    nonSkippedResults.length > 0 && nonSkippedResults.every((r) => !r.success);
  if (allFailed) {
    logger.error(
      { catalog: mergedCatalog.name },
      'all sources failed for merged catalog'
    );
    return {
      success: false,
      data: [],
      errors: [
        {
          title: `All sources failed for merged catalog ${mergedCatalog.name}`,
          description:
            'Unable to fetch items from any source catalog. Please try again later.',
        },
      ],
    };
  }

  const itemsBySource: MetaPreview[][] = [];
  for (const { encodedCatalogId, items, fetched, skipped } of fetchResults) {
    if (skipped) continue;
    nextSourceSkips[encodedCatalogId] =
      (skipState.sourceSkips[encodedCatalogId] || 0) + fetched;
    itemsBySource.push(items);
  }

  let allItems: MetaPreview[] = applyMergeMethod(
    itemsBySource,
    mergedCatalog.mergeMethod
  );

  logger.debug(
    { catalog: mergedCatalog.name, count: allItems.length },
    'merged catalog items before deduplication'
  );

  allItems = deduplicateCatalogItems(allItems, deduplicationMethods, type);

  const shuffleCacheKey = `${baseCacheKey}-skip=${requestedSkip}-shuffle`;

  allItems = await applyCatalogModifications(
    ctx,
    allItems,
    id,
    type,
    parsedExtras,
    shuffleCacheKey
  );

  const nextSkip = requestedSkip + allItems.length;

  if (allItems.length > 0) {
    const nextSkipCacheKey = `${baseCacheKey}-skip=${nextSkip}`;
    await mergedCatalogCache.set(
      nextSkipCacheKey,
      { sourceSkips: nextSourceSkips },
      3600
    );
  }

  logger.debug(
    {
      catalog: mergedCatalog.name,
      count: allItems.length,
      skip: requestedSkip,
      nextSkip,
      took: getTimeTakenSincePoint(start),
    },
    'merged catalog complete'
  );

  return { success: true, data: allItems, errors: [] };
}

export async function getCatalog(
  ctx: AIOStreamsContext,
  type: string,
  id: string,
  extras?: string
): Promise<AIOStreamsResponse<MetaPreview[]>> {
  logger.debug({ type, id, extras }, 'handling catalog request');

  if (id.startsWith('aiostreams.merged.')) {
    return getMergedCatalog(ctx, type, id, extras);
  }

  const addonInstanceId = id.split('.', 2)[0];
  let actualCatalogId = id.split('.').slice(1).join('.');

  const parsedExtras = new ExtrasParser(extras);

  // Map individual streaming platform catalogs back to tc-streaming-top with genre injected
  const platformGenres: Record<string, string> = {
    'tc-streaming-netflix': 'Netflix',
    'tc-streaming-prime': 'Prime Video',
    'tc-streaming-disney': 'Disney+',
    'tc-streaming-hbo': 'HBO Max',
    'tc-streaming-apple': 'Apple TV+',
  };
  if (platformGenres[actualCatalogId]) {
    parsedExtras.genre = platformGenres[actualCatalogId];
    actualCatalogId = 'tc-streaming-top';
  }

  const result = await fetchRawCatalogItems(
    ctx,
    addonInstanceId,
    actualCatalogId,
    type,
    parsedExtras
  );

  // If this is the watchlist catalog, normalize any single-season/episode entries to the whole series
  if (
    result.success &&
    (actualCatalogId.includes('watchlist') ||
      actualCatalogId.includes('tc-watchlist'))
  ) {
    result.items = result.items.map((item) => {
      if (item.type === 'series' && item.id && item.id.includes(':')) {
        const rootId = item.id.split(':')[0];
        return {
          ...item,
          id: rootId,
        };
      }
      return item;
    });
  }

  if (!result.success) {
    if (extras && extras.includes('skip')) {
      return { success: true, data: [], errors: [] };
    }
    return {
      success: false,
      data: [],
      errors: result.error ? [result.error] : [],
    };
  }

  const shuffleCacheKey = `${type}-${actualCatalogId}-${parsedExtras?.toString() || ''}-${userScopeKey(ctx.userData)}`;

  const catalog = await applyCatalogModifications(
    ctx,
    result.items,
    id,
    type,
    parsedExtras,
    shuffleCacheKey
  );

  return { success: true, data: catalog, errors: [] };
}
