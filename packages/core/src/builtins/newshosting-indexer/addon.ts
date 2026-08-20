import { z } from 'zod';
import { ParsedId } from '../../utils/id-parser.js';
import {
  appConfig,
  Cache,
  constants,
  createLogger,
  fromUrlSafeBase64,
  getSimpleTextHash,
  toUrlSafeBase64,
} from '../../utils/index.js';
import pLimit from 'p-limit';
import { hashNzbUrl, NZB, Torrent } from '../../debrid/index.js';
import {
  BaseDebridAddon,
  BaseDebridConfigSchema,
  SearchMetadata,
} from '../base/debrid.js';
import { BuiltinProxy, createProxy } from '../../proxy/index.js';
import type { BuiltinServiceId } from '../../utils/index.js';
import { NewshostingClient, NewshostingResult } from './client.js';
import {
  NewshostingMediaMetadata,
  NewshostingMediaRequest,
  normalizeNewshostingComparableTitle,
  ParsedNewshostingRelease,
  parseNewshostingRelease,
  scoreNewshostingReleaseMatch,
} from './release.js';

const logger = createLogger('newshosting-indexer');
const NEWSHOSTING_NZB_CACHE_TTL_SECONDS = 6 * 60 * 60;
const NEWSHOSTING_NZB_CACHE_MAX_ENTRIES = 128;
const newshostingNzbCache = Cache.getInstance<string, string>(
  'newshosting:nzb',
  NEWSHOSTING_NZB_CACHE_MAX_ENTRIES,
  'memory'
);
const newshostingNzbInFlight = new Map<string, Promise<string>>();

const SUPPORTED_SERVICES = new Set<BuiltinServiceId>([
  constants.TORBOX_SERVICE,
  constants.NZBDAV_SERVICE,
  constants.ALTMOUNT_SERVICE,
  constants.STREMIO_NNTP_SERVICE,
  constants.STREMTHRU_NEWZ_SERVICE,
  constants.AIOSTREAMS_SERVICE,
  constants.DEEPBRID_SERVICE,
]);

export const NewshostingPrivateConfigSchema = z.object({
  username: z.string().trim().min(1).max(256),
  password: z.string().min(1).max(1_024),
  host: z.string().trim().min(1).max(253).default('srv.aboutusenet.com'),
  ip: z.string().trim().min(1).max(253).default('81.171.93.8'),
  port: z.number().int().min(1).max(65_535).default(5598),
  maxNzbFiles: z.number().int().min(1).max(500).default(160),
  nzbTimeout: z.number().int().min(1_000).max(120_000).default(60_000),
  proxyAuth: z.string().min(1),
});
export type NewshostingPrivateConfig = z.infer<
  typeof NewshostingPrivateConfigSchema
>;

export const NewshostingIndexerAddonConfigSchema =
  BaseDebridConfigSchema.extend({
    username: z.string().trim().min(1).max(256),
    password: z.string().min(1).max(1_024),
    host: z.string().trim().min(1).max(253).default('srv.aboutusenet.com'),
    ip: z.string().trim().min(1).max(253).default('81.171.93.8'),
    port: z.number().int().min(1).max(65_535).default(5598),
    maxResults: z.number().int().min(1).max(200).default(100),
    maxNzbFiles: z.number().int().min(1).max(500).default(160),
    searchTimeout: z.number().int().min(1_000).max(120_000).default(8_000),
    nzbTimeout: z.number().int().min(1_000).max(120_000).default(60_000),
    proxyAuth: z.string().min(1),
    nzbConfig: z.string().min(32).max(16_384),
  });
export type NewshostingIndexerAddonConfig = z.infer<
  typeof NewshostingIndexerAddonConfigSchema
>;

const NewshostingNzbIdSchema = z.object({
  i: z.string().min(1).max(256),
  s: z.string().min(1).max(256),
  it: z.string().min(1).max(512),
  t: z.string().min(1).max(500).optional(),
  f: z.number().int().nonnegative().max(10_000).optional(),
});

export function encodeNewshostingNzbId(result: NewshostingResult): string {
  return toUrlSafeBase64(
    JSON.stringify({
      i: result.index,
      s: result.scope,
      it: result.itemId,
      t: result.name,
      f: result.files,
    })
  );
}

export function decodeNewshostingNzbId(encoded: string): {
  index: string;
  scope: string;
  itemId: string;
  title?: string;
  files?: number;
} {
  if (!/^[A-Za-z0-9_-]{8,4096}$/.test(encoded)) {
    throw new Error('invalid_newshosting_nzb_id');
  }
  let parsed: z.infer<typeof NewshostingNzbIdSchema>;
  try {
    parsed = NewshostingNzbIdSchema.parse(
      JSON.parse(fromUrlSafeBase64(encoded))
    );
  } catch {
    throw new Error('invalid_newshosting_nzb_id');
  }
  return {
    index: parsed.i,
    scope: parsed.s,
    itemId: parsed.it,
    title: parsed.t,
    files: parsed.f,
  };
}

export function buildNewshostingQueries(
  metadata: NewshostingMediaMetadata,
  media: NewshostingMediaRequest
): string[] {
  const seen = new Set<string>();
  const titles = [metadata.title, ...(metadata.aliases || [])].filter(
    (value): value is string => Boolean(value)
  );
  const queryTitles: string[] = [];
  for (const title of titles) {
    const normalized = normalizeNewshostingComparableTitle(title);
    const dotted = normalized.replace(/\s+/g, '.');
    for (const value of [title, normalized, dotted]) {
      const key = normalizeNewshostingComparableTitle(value);
      if (key && !/^tt\d+$/i.test(key) && !seen.has(key)) {
        seen.add(key);
        queryTitles.push(value);
      }
    }
  }

  const selectedTitles = queryTitles.slice(0, 3);
  if (media.type === 'series' && media.season && media.episode) {
    const code = `S${String(media.season).padStart(2, '0')}E${String(media.episode).padStart(2, '0')}`;
    const season = `S${String(media.season).padStart(2, '0')}`;
    return [
      ...new Set(
        selectedTitles.flatMap((title) => [
          `${title} ${code}`,
          `${title} ${season}`,
          title,
        ])
      ),
    ].slice(0, 6);
  }
  return [
    ...new Set(
      selectedTitles.flatMap((title) =>
        metadata.year ? [`${title} ${metadata.year}`, title] : [title]
      )
    ),
  ].slice(0, 4);
}

function isSupportOnlyRelease(title: string): boolean {
  return /(?:^|[.\s_-])(?:par2|sfv|nfo)(?:$|[.\s_-])/i.test(title);
}

function looksLikeVideoRelease(title: string): boolean {
  return (
    /\.(?:mkv|mp4|m4v|avi|mov|ts|m2ts)(?:$|[\s._-])/i.test(title) ||
    /\b(?:S\d{1,2}[\s._-]*E\d{1,3}|\d{1,2}x\d{1,3}|Season\s*\d{1,2}.*?(?:Episode|Ep)\s*\d{1,3})\b/i.test(
      title
    ) ||
    /\b(?:2160p|1080p|720p|480p|4k|uhd|web-?dl|webrip|blu-?ray|remux|hdtv)\b/i.test(
      title
    )
  );
}

function hasBadReleaseSignal(title: string): boolean {
  return (
    /\b(?:sample|trailer|camrip|cam|telesync|hdts|tsrip|tc|telecine|screener|xbet|password|encrypted)\b/i.test(
      title
    ) ||
    /(?:^|[.\s_-])(?:exe|scr|bat|cmd|msi|iso|img)(?:$|[.\s_-])/i.test(title)
  );
}

function sizeLooksPlayable(size: number): boolean {
  if (!size) return true;
  const gib = size / 1_073_741_824;
  return gib >= 0.05;
}

export function matchesNewshostingEpisode(
  parsed: ParsedNewshostingRelease,
  media: NewshostingMediaRequest
): boolean {
  if (media.type !== 'series' || !media.season || !media.episode) return true;
  if (parsed.season !== undefined && parsed.season !== media.season) {
    return false;
  }
  if (parsed.episodeRange) {
    return (
      parsed.episodeRange.start <= media.episode &&
      parsed.episodeRange.end >= media.episode
    );
  }
  if (parsed.episode !== undefined) return parsed.episode === media.episode;
  if (parsed.absoluteEpisode !== undefined) {
    return parsed.absoluteEpisode === media.episode;
  }
  if (parsed.seasonPack) {
    return parsed.season === undefined || parsed.season === media.season;
  }
  return true;
}

function fileCountPenalty(files: number): number {
  if (!files || files <= 1) return 0;
  if (files <= 4) return 80;
  if (files <= 12) return 260;
  if (files <= 24) return 520;
  return 1100;
}

export function rankNewshostingResult(
  result: NewshostingResult,
  matchScore: number
): number {
  let score = matchScore;
  if (/\b(?:rifftrax|commentary|extras?|bonus|sample)\b/i.test(result.name))
    score -= 900;
  if (looksLikeVideoRelease(result.name)) score += 220;
  if (/\.(?:mkv|mp4|m4v)(?:$|[\s._-])/i.test(result.name)) score += 240;
  if (result.files > 0) score -= fileCountPenalty(result.files);
  if (result.size > 0) {
    const gib = result.size / 1_073_741_824;
    if (gib >= 1.5 && gib <= 35) score += 120;
    if (gib > 55) score -= 180;
  }
  return score;
}

function metadataForSearch(metadata: SearchMetadata): NewshostingMediaMetadata {
  const aliases = [metadata.primaryTitle, ...(metadata.titles || [])].filter(
    (value): value is string => Boolean(value)
  );
  return {
    title: metadata.primaryTitle || aliases[0],
    aliases: [...new Set(aliases)],
    year: metadata.year,
    countries: metadata.country ? [metadata.country] : [],
    isAnime: metadata.isAnime,
  };
}

function mediaForSearch(parsedId: ParsedId): NewshostingMediaRequest {
  const isSeries =
    parsedId.mediaType === 'series' ||
    parsedId.mediaType === 'anime' ||
    Boolean(parsedId.season || parsedId.episode);
  return {
    type: isSeries ? 'series' : 'movie',
    season: parsedId.season ? Number(parsedId.season) : undefined,
    episode: parsedId.episode ? Number(parsedId.episode) : undefined,
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

interface NewshostingSearchClient {
  connect(): Promise<void>;
  search(
    query: string,
    page?: number,
    perPage?: number
  ): Promise<{ results: NewshostingResult[] }>;
  close(): void;
}

export async function searchNewshostingQueries(
  queries: string[],
  createClient: () => NewshostingSearchClient,
  timeoutMs: number,
  perPage = 100
): Promise<{ results: NewshostingResult[]; errors: Error[] }> {
  const concurrency = pLimit(Math.min(3, Math.max(1, queries.length)));
  const settled = await Promise.allSettled(
    queries.map((query) =>
      concurrency(async () => {
        const client = createClient();
        try {
          return await withTimeout(
            (async () => {
              await client.connect();
              return client.search(query, 1, perPage);
            })(),
            timeoutMs,
            'newshosting_search_timeout'
          );
        } finally {
          client.close();
        }
      })
    )
  );

  const results: NewshostingResult[] = [];
  const errors: Error[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      results.push(...result.value.results);
    } else {
      errors.push(
        result.reason instanceof Error
          ? result.reason
          : new Error(String(result.reason))
      );
    }
  }
  return { results, errors };
}

export async function createNewshostingNzb(
  encodedId: string,
  rawConfig: NewshostingPrivateConfig
): Promise<string> {
  const config = NewshostingPrivateConfigSchema.parse(rawConfig);
  const id = decodeNewshostingNzbId(encodedId);
  if (id.files && id.files > config.maxNzbFiles) {
    throw new Error('newshosting_nzb_too_many_files');
  }
  const cacheKey = getSimpleTextHash(
    JSON.stringify([
      config.host,
      config.ip,
      config.port,
      id.index,
      id.scope,
      id.itemId,
    ])
  );
  const cached = await newshostingNzbCache.get(cacheKey);
  if (cached) return cached;
  const existing = newshostingNzbInFlight.get(cacheKey);
  if (existing) return existing;

  const task = (async () => {
    const client = new NewshostingClient({
      ...config,
      timeoutMs: config.nzbTimeout,
    });
    try {
      const nzb = await withTimeout(
        (async () => {
          await client.connect();
          return client.createNzb(id.index, id.scope, id.itemId);
        })(),
        config.nzbTimeout,
        'newshosting_nzb_timeout'
      );
      await newshostingNzbCache.set(
        cacheKey,
        nzb,
        NEWSHOSTING_NZB_CACHE_TTL_SECONDS,
        true
      );
      return nzb;
    } finally {
      client.close();
    }
  })();
  newshostingNzbInFlight.set(cacheKey, task);
  try {
    return await task;
  } finally {
    newshostingNzbInFlight.delete(cacheKey);
  }
}

export class NewshostingIndexerAddon extends BaseDebridAddon<NewshostingIndexerAddonConfig> {
  readonly name = 'Newshosting as an Indexer';
  readonly version = '1.0.0';
  readonly id = 'newshosting-indexer';
  readonly logger = logger;

  constructor(userData: NewshostingIndexerAddonConfig, clientIp?: string) {
    super(userData, NewshostingIndexerAddonConfigSchema, clientIp);
    BuiltinProxy.validateAuth(this.userData.proxyAuth);
    if (
      this.userData.services.some(
        (service) => !SUPPORTED_SERVICES.has(service.id)
      )
    ) {
      throw new Error(
        'Newshosting as an Indexer only supports AIOStreams Usenet services'
      );
    }
  }

  protected async _searchNzbs(parsedId: ParsedId): Promise<NZB[]> {
    const metadata = metadataForSearch(await this.getSearchMetadata());
    const media = mediaForSearch(parsedId);
    const queries = buildNewshostingQueries(metadata, media);
    if (!queries.length) return [];

    const seen = new Set<string>();
    const results: NewshostingResult[] = [];
    const search = await searchNewshostingQueries(
      queries,
      () =>
        new NewshostingClient({
          username: this.userData.username,
          password: this.userData.password,
          host: this.userData.host,
          ip: this.userData.ip,
          port: this.userData.port,
          maxNzbFiles: this.userData.maxNzbFiles,
          timeoutMs: this.userData.searchTimeout,
        }),
      this.userData.searchTimeout
    );
    for (const result of search.results) {
      const key = `${result.index}_${result.scope}_${result.itemId}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push(result);
      }
    }
    if (search.errors.length) {
      this.logger.warn(
        'Some Newshosting searches failed; keeping partial results',
        {
          failed: search.errors.length,
          successful: queries.length - search.errors.length,
          errors: search.errors.map((error) => error.message),
        }
      );
      if (!results.length) {
        throw search.errors[0];
      }
    }

    const ranked = results
      .filter(
        (result) =>
          result.name &&
          result.index &&
          result.scope &&
          result.itemId &&
          !isSupportOnlyRelease(result.name)
      )
      .filter(
        (result) => !result.files || result.files <= this.userData.maxNzbFiles
      )
      .filter((result) => looksLikeVideoRelease(result.name))
      .filter((result) => !hasBadReleaseSignal(result.name))
      .filter((result) => sizeLooksPlayable(result.size))
      .map((result) => {
        const parsed = parseNewshostingRelease(result.name);
        const match = scoreNewshostingReleaseMatch(
          result.name,
          media,
          parsed,
          metadata
        );
        return {
          result,
          parsed,
          match,
          rankScore: rankNewshostingResult(result, match.score),
        };
      })
      .filter((item) => matchesNewshostingEpisode(item.parsed, media))
      .filter(
        (item) => item.match.score >= (media.type === 'series' ? 650 : 600)
      )
      .sort(
        (a, b) =>
          b.rankScore - a.rankScore ||
          a.result.files - b.result.files ||
          b.result.size - a.result.size
      )
      .slice(0, this.userData.maxResults);
    if (!ranked.length) return [];

    const proxy = createProxy({
      id: constants.BUILTIN_SERVICE,
      url: appConfig.bootstrap.baseUrl,
      credentials: this.userData.proxyAuth,
    });
    const targets = ranked.map(({ result }) => ({
      url: `${appConfig.bootstrap.baseUrl.replace(/\/+$/, '')}/builtins/newshosting-indexer/${encodeURIComponent(this.userData.nzbConfig)}/nzb/${encodeNewshostingNzbId(result)}`,
      filename: `${result.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 180)}.nzb`,
      type: 'nzb' as const,
    }));
    const proxiedUrls = await proxy.generateUrls(targets, true);
    if (!proxiedUrls || 'error' in proxiedUrls) {
      throw new Error('Failed to create secure Newshosting NZB URLs');
    }

    return ranked.map(({ result, parsed, match }, index) => {
      const published = Date.parse(result.date);
      const stableId = getSimpleTextHash(
        `newshosting:${result.index}:${result.scope}:${result.itemId}`
      );
      return {
        type: 'usenet',
        confirmed: match.score >= (media.type === 'series' ? 650 : 600),
        title: result.name,
        hash: hashNzbUrl(`newshosting:${stableId}`),
        nzb: proxiedUrls[index],
        size: result.size,
        age: Number.isFinite(published)
          ? Math.ceil(Math.abs(Date.now() - published) / 3_600_000)
          : 0,
        group: parsed.releaseGroup,
        indexer: 'Newshosting',
      } satisfies NZB;
    });
  }

  protected async _searchTorrents(_parsedId: ParsedId): Promise<Torrent[]> {
    return [];
  }
}
