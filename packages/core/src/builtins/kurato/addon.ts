import type { CatalogResponse, Manifest, Meta, MetaPreview } from '../../db/index.js';
import { ExtrasParser } from '../../utils/extras.js';
import { KuratoApiClient, KuratoConfigSchema, type KuratoConfig } from './api.js';

const NSFW_RE = /\b(?:18\+|adult|erotic|erotica|hentai|porn|xxx|nsfw|sex)\b/i;
const MAX_CATALOG_ITEMS = 200;
const MAX_COLLECTIONS_PER_REQUEST = 12;

type KuratoType = 'movie' | 'series';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(item: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

function itemType(
  item: Record<string, unknown>,
  fallback: KuratoType
): KuratoType | undefined {
  const value = firstString(item, [
    'type',
    'contentType',
    'content_type',
    'media_type',
    'mediaType',
  ])?.toLowerCase();
  if (value === 'tv' || value === 'series' || value === 'show' || value === 'tv_show' || value === 'tv-show') return 'series';
  if (value === 'movie' || value === 'movies') return 'movie';
  if (value && !['all', 'content'].includes(value)) return undefined;
  return fallback;
}

function collectItems(value: unknown, output: Record<string, unknown>[] = [], seen = new Set<object>()) {
  if (Array.isArray(value)) {
    for (const entry of value) collectItems(entry, output, seen);
    return output;
  }
  const current = record(value);
  if (!current || seen.has(current)) return output;
  seen.add(current);
  const hasTitle = Boolean(firstString(current, ['title', 'name', 'original_title', 'original_name']));
  const hasId = Boolean(
    firstString(current, ['imdb_id', 'tmdb_id', 'contentId', 'content_id', 'id', '_id'])
  );
  if (hasTitle && hasId) output.push(current);
  for (const [key, child] of Object.entries(current)) {
    if (/^(data|results|items|contents|movies|series|tv|movie|details|result|payload|recommendations|recommendation|trending|rows|sections|content|discovered|discover|collectionContents)$/i.test(key)) {
      collectItems(child, output, seen);
    }
  }
  return output;
}

function collectionId(item: Record<string, unknown>) {
  return firstString(item, ['collectionId', 'collection_id', 'id', '_id']);
}

function collectionName(item: Record<string, unknown>) {
  return firstString(item, ['name', 'title', 'collectionName', 'collection_name']) ?? 'Kurato Collection';
}

function isGeneratedCollection(item: Record<string, unknown>) {
  const flag = (value: unknown) =>
    value === true || value === 1 || value === 'true' || value === '1';
  return Boolean(
    flag(item.isGenerated) ||
      flag(item.is_generated) ||
      flag(item.generated) ||
      item.collectionType === 'generated' ||
      item.type === 'generated'
  );
}

function looksLikeCollection(item: Record<string, unknown>) {
  const id = collectionId(item);
  const name = collectionName(item);
  const hasCollectionShape =
    item.isGenerated !== undefined ||
    item.is_generated !== undefined ||
    item.isPublic !== undefined ||
    item.is_public !== undefined ||
    item.subscribed !== undefined ||
    item.collectionId !== undefined ||
    item.collection_id !== undefined ||
    item.contents !== undefined;
  return Boolean(id && name && hasCollectionShape);
}

function collectCollections(
  value: unknown,
  output: Record<string, unknown>[] = [],
  seen = new Set<object>()
) {
  if (Array.isArray(value)) {
    for (const entry of value) collectCollections(entry, output, seen);
    return output;
  }
  const current = record(value);
  if (!current || seen.has(current)) return output;
  seen.add(current);
  if (looksLikeCollection(current)) output.push(current);
  for (const [key, child] of Object.entries(current)) {
    if (/^(data|results|items|collections|collection|generated|generatedCollections|recommendations|sections)$/i.test(key)) {
      collectCollections(child, output, seen);
    }
  }
  return output;
}

function imageUrl(value: unknown, base: string) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return /^https?:\/\//i.test(value) ? value : `${base}${value.startsWith('/') ? value : `/${value}`}`;
}

function isNsfw(item: MetaPreview) {
  return Boolean(
    (item as any).isAdult ||
      NSFW_RE.test([item.name, item.description, ...(item.genres ?? [])].filter(Boolean).join(' '))
  );
}

function toId(item: Record<string, unknown>, type: KuratoType) {
  const imdb = firstString(item, ['imdb_id', 'imdbId', 'imdb']);
  if (imdb) return imdb.startsWith('tt') ? imdb : `tt${imdb}`;
  const tmdb = firstString(item, [
    'tmdb_id',
    'tmdbId',
    'tmdb',
    'contentId',
    'content_id',
    'id',
    '_id',
  ]);
  return tmdb ? `tmdb:${tmdb.replace(/^tmdb:/i, '')}` : `kurato:${type}:${encodeURIComponent(firstString(item, ['title', 'name']) ?? 'unknown')}`;
}

function toMetaPreview(item: Record<string, unknown>, fallbackType: KuratoType): MetaPreview | undefined {
  const type = itemType(item, fallbackType);
  if (!type) return undefined;
  const name = firstString(item, ['title', 'name', 'original_title', 'original_name']);
  if (!name) return undefined;
  const date = firstString(item, ['releaseDate', 'release_date', 'first_air_date', 'firstAirDate', 'year']);
  const genres = Array.isArray(item.genres)
    ? item.genres.map((genre) => (typeof genre === 'string' ? genre : firstString(record(genre) ?? {}, ['name']) ?? '')).filter(Boolean)
    : undefined;
  const preview: MetaPreview = {
    id: toId(item, type),
    type,
    name,
    poster: imageUrl(item.posterPath ?? item.poster_path ?? item.poster ?? item.image ?? item.cover, 'https://img.kurato.com/t/p/w500'),
    background: imageUrl(item.backdropPath ?? item.backdrop_path ?? item.backdrop, 'https://img.kurato.com/t/p/w780'),
    description: firstString(item, ['overview', 'synopsis', 'description', 'explanation']),
    releaseInfo: date?.slice(0, 4),
    genres,
  };
  return isNsfw(preview) ? undefined : preview;
}

function dedupe(items: MetaPreview[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class KuratoAddon {
  private readonly config: KuratoConfig;
  private readonly api: KuratoApiClient;
  private readonly manifest: Manifest;

  constructor(config: unknown, fetchFn?: typeof fetch) {
    this.config = KuratoConfigSchema.parse(config);
    this.api = new KuratoApiClient(this.config, fetchFn);
    this.manifest = KuratoAddon.getManifest(this.config);
  }

  static getManifest(
    config?: Pick<
      KuratoConfig,
      'includeWatchlist' | 'includeCollections' | 'includeGeneratedRecommendations'
    >
  ): Manifest {
    const manifest: Manifest = {
      id: 'org.aiostreams.kurato',
      version: '1.0.0',
      name: 'Kurato',
      description: 'Personalized Kurato recommendations, watchlist, and search',
      logo: 'https://kurato.com/favicon.ico',
      resources: ['catalog', 'meta'],
      types: ['movie', 'series'],
      // Kurato is a catalog/recommendation source, not the authoritative
      // metadata provider.  Leaving metadata IDs unscoped makes AIOStreams
      // try an installed ID-matching provider (Cinemeta, TMDB, TVDB, or
      // another metadata addon) first, while retaining Kurato as a safe
      // fallback when no other provider can answer the request.
      catalogs: [
        { type: 'movie', id: 'kurato-for-you-movie', name: 'Kurato · For You Movies', extra: [{ name: 'search' }, { name: 'skip' }] },
        { type: 'series', id: 'kurato-for-you-series', name: 'Kurato · For You Series', extra: [{ name: 'search' }, { name: 'skip' }] },
        { type: 'movie', id: 'kurato-ai-discover-movie', name: 'Kurato · AI Discover Movies', extra: [{ name: 'search' }, { name: 'skip' }] },
        { type: 'series', id: 'kurato-ai-discover-series', name: 'Kurato · AI Discover Series', extra: [{ name: 'search' }, { name: 'skip' }] },
        { type: 'movie', id: 'kurato-watchlist-movie', name: 'Kurato · Watchlist Movies', extra: [{ name: 'skip' }] },
        { type: 'series', id: 'kurato-watchlist-series', name: 'Kurato · Watchlist Series', extra: [{ name: 'skip' }] },
        { type: 'movie', id: 'kurato-collections-movie', name: 'Kurato · Collections Movies', extra: [{ name: 'search' }, { name: 'skip' }] },
        { type: 'series', id: 'kurato-collections-series', name: 'Kurato · Collections Series', extra: [{ name: 'search' }, { name: 'skip' }] },
        { type: 'movie', id: 'kurato-generated-movie', name: 'Kurato · Generated Recommendations Movies', extra: [{ name: 'search' }, { name: 'skip' }] },
        { type: 'series', id: 'kurato-generated-series', name: 'Kurato · Generated Recommendations Series', extra: [{ name: 'search' }, { name: 'skip' }] },
      ],
      behaviorHints: { adult: false, configurable: true, configurationRequired: true },
    };
    if (config?.includeWatchlist === false) {
      manifest.catalogs = manifest.catalogs?.filter(
        (catalog) => !catalog.id.includes('watchlist')
      );
    }
    if (config?.includeCollections === false) {
      manifest.catalogs = manifest.catalogs?.filter(
        (catalog) => !catalog.id.includes('collection') && !catalog.id.includes('generated')
      );
    } else if (config?.includeGeneratedRecommendations === false) {
      manifest.catalogs = manifest.catalogs?.filter(
        (catalog) => !catalog.id.includes('generated')
      );
    }
    return manifest;
  }

  getManifest() { return this.manifest; }

  private async getCollectionCatalog(
    type: KuratoType,
    generatedOnly: boolean,
    query: string | undefined,
    skip: number
  ): Promise<CatalogResponse['metas']> {
    const rawCollections = await this.api.collections(query);
    const collections = collectCollections(rawCollections)
      .filter((item) => !generatedOnly || isGeneratedCollection(item))
      .slice(0, MAX_COLLECTIONS_PER_REQUEST);
    if (!collections.length) return [];

    const metas: MetaPreview[] = [];
    const loaded = await Promise.allSettled(
      collections.map(async (collection) => {
        const id = collectionId(collection);
        if (!id) return [] as MetaPreview[];
        const embedded = collectItems(collection).filter((item) => !looksLikeCollection(item));
        const raw = embedded.length
          ? embedded
          : collectItems(await this.api.collection(id, type, Math.max(this.config.pageSize, 100))).filter(
              (item) => !looksLikeCollection(item)
            );
        return raw
          .map((item) => toMetaPreview(item, type))
          .filter((item): item is MetaPreview => Boolean(item && item.type === type))
          .map((item) => ({
            ...item,
            description: [
              `Kurato collection: ${collectionName(collection)}`,
              item.description,
            ].filter(Boolean).join(' · '),
          }));
      })
    );
    for (const result of loaded) {
      if (result.status === 'fulfilled') metas.push(...result.value);
    }
    return dedupe(metas).slice(skip, skip + this.config.pageSize).slice(0, MAX_CATALOG_ITEMS);
  }

  async getCatalog(type: string, id: string, extras?: string): Promise<CatalogResponse['metas']> {
    if (type !== 'movie' && type !== 'series') return [];
    const requestedType = type as KuratoType;
    const parsed = new ExtrasParser(extras);
    if (parsed.search?.trim()) {
      if (id.includes('collection') || id.includes('generated')) {
        return this.getCollectionCatalog(
          requestedType,
          id.includes('generated'),
          decodeURIComponent(parsed.search),
          Math.max(0, parsed.skip ?? 0)
        );
      }
      return this.search(type, decodeURIComponent(parsed.search), extras);
    }
    const skip = Math.max(0, parsed.skip ?? 0);
    if (id.includes('collection') || id.includes('generated')) {
      return this.getCollectionCatalog(requestedType, id.includes('generated'), undefined, skip);
    }
    const page = Math.floor(skip / this.config.pageSize) + 1;
    const raw = id.includes('watchlist') && this.config.includeWatchlist
      ? await this.api.watchlist(requestedType)
      : await this.api.homepage(
          requestedType === 'movie' ? 'movies' : 'series',
          page,
          this.config.pageSize
        );
    const items = collectItems(raw)
      .map((item) => toMetaPreview(item, requestedType))
      .filter((item): item is MetaPreview => Boolean(item && item.type === requestedType));
    const offsetWithinPage = id.includes('watchlist') ? skip : skip % this.config.pageSize;
    return dedupe(items)
      .slice(offsetWithinPage, offsetWithinPage + this.config.pageSize)
      .slice(0, MAX_CATALOG_ITEMS);
  }

  async search(type: string, query: string, extras?: string): Promise<CatalogResponse['metas']> {
    if (type !== 'movie' && type !== 'series' || !query.trim()) return [];
    const parsed = new ExtrasParser(extras);
    const skip = Math.max(0, parsed.skip ?? 0);
    const page = Math.floor(skip / this.config.pageSize) + 1;
    const raw = await this.api.discover(type as KuratoType, query.trim(), page, this.config.pageSize);
    const items = collectItems(raw)
      .map((item) => toMetaPreview(item, type as KuratoType))
      .filter((item): item is MetaPreview => Boolean(item && item.type === type));
    return dedupe(items).slice(0, MAX_CATALOG_ITEMS);
  }

  async getMeta(type: string, id: string): Promise<Meta> {
    const contentType = type === 'series' ? 'series' : 'movie';
    const rawId = id.replace(/^tmdb:/i, '');
    const raw = await this.api.metadata(contentType, rawId);
    const preview = collectItems(raw)
      .map((item) => toMetaPreview(item, contentType))
      .find((item) => item?.id === id) ?? { id, type: contentType, name: id };
    return { ...preview, id, type: contentType } as Meta;
  }
}

export { KuratoConfigSchema };
