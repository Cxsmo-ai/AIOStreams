import { z } from 'zod';
import pLimit from 'p-limit';
import { ParsedId } from '../../utils/id-parser.js';
import { constants, createLogger } from '../../utils/index.js';
import { IdParser } from '../../utils/id-parser.js';
import { Stream } from '../../db/index.js';
import {
  BaseDebridAddon,
  BaseDebridConfigSchema,
  SearchMetadata,
} from '../base/debrid.js';
import { Torrent, NZB, hashNzbUrl } from '../../debrid/index.js';
import { buildNewshostingQueries } from '../newshosting-indexer/addon.js';
import {
  NewshostingMediaMetadata,
  NewshostingMediaRequest,
  parseNewshostingRelease,
  scoreNewshostingReleaseMatch,
} from '../newshosting-indexer/release.js';
import {
  DeepbridApiError,
  DeepbridFinderClient,
  DeepbridFinderContent,
  DeepbridFinderFile,
  DeepbridFinderResult,
  isDeepbridArchiveName,
  isDeepbridVideoName,
  validateDeepbridDownloadUrl,
} from './client.js';
import { probeDeepbridVideo } from './probe.js';
import { createDeepbridPlaybackUrl } from './playback.js';
export {
  createDeepbridPlaybackToken,
  decodeDeepbridPlaybackToken,
  type DeepbridPlaybackPayload,
} from './playback.js';
import {
  hasSuccessfulDeepbridProbe,
  rememberSuccessfulDeepbridProbe,
} from './probe-cache.js';

const logger = createLogger('deepbrid-usenet');
// Deepbrid throttles bursts across simultaneous AIOStreams requests. Share a
// process-wide ceiling while still allowing one request to resolve candidates
// in parallel and retain every valid result.
const deepbridNetworkLimit = pLimit(10);

export const DeepbridUsenetConfigSchema = BaseDebridConfigSchema.extend({
  /** Copied from the global Deepbrid service during preset generation. */
  apiKey: z.string().trim().min(16).max(512).optional(),
  mode: z.enum(['direct', 'indexer']).default('direct'),
  resolveExternalIndexers: z.boolean().default(false),
  maxResults: z.number().int().min(1).max(50).default(20),
  maxContentResolves: z.number().int().min(1).max(30).default(15),
  resolveConcurrency: z.number().int().min(1).max(10).default(5),
  timeout: z.number().int().min(1_000).max(120_000).default(30_000),
});
export type DeepbridUsenetConfig = z.infer<typeof DeepbridUsenetConfigSchema>;

export function requireDeepbridApiKey(config: DeepbridUsenetConfig): string {
  if (!config.apiKey) {
    throw new Error(
      'Deepbrid service is not configured. Add your API key under Services > Deepbrid, then regenerate this addon.'
    );
  }
  return config.apiKey;
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
  const series =
    parsedId.mediaType !== 'movie' ||
    Boolean(parsedId.season || parsedId.episode);
  return {
    type: series ? 'series' : 'movie',
    season: parsedId.season ? Number(parsedId.season) : undefined,
    episode: parsedId.episode ? Number(parsedId.episode) : undefined,
  };
}

function categoryFor(
  media: NewshostingMediaRequest,
  anime: boolean | undefined
): string {
  if (anime) return 'c36';
  return media.type === 'movie' ? 'c11' : 'c30';
}

function ageHours(value: string): number | undefined {
  const numeric = Number(value);
  const timestamp = Number.isFinite(numeric)
    ? numeric > 10_000_000_000
      ? numeric
      : numeric * 1_000
    : Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.max(0, Math.ceil((Date.now() - timestamp) / 3_600_000))
    : undefined;
}

function rankResult(
  result: DeepbridFinderResult,
  media: NewshostingMediaRequest,
  metadata: NewshostingMediaMetadata
): { score: number; confirmed: boolean } {
  const match = scoreNewshostingReleaseMatch(
    result.title,
    media,
    parseNewshostingRelease(result.title),
    metadata
  );
  let score = match.score + Math.min(200, result.sources * 10);
  if (
    /\b(?:2160p|1080p|720p|4k|uhd|web-?dl|webrip|blu-?ray|remux|hdtv)\b/i.test(
      result.title
    )
  )
    score += 120;
  if (
    /\b(?:sample|trailer|cam|telesync|screener|password|encrypted)\b/i.test(
      result.title
    )
  )
    score -= 1000;
  return {
    score,
    confirmed: match.score >= (media.type === 'series' ? 650 : 600),
  };
}

export function chooseDeepbridVideoFiles(
  files: DeepbridFinderFile[],
  media: NewshostingMediaRequest,
  releaseTitle?: string
): DeepbridFinderFile[] {
  const videos = files.filter(
    (file) =>
      isDeepbridVideoName(file.name) &&
      !/(?:^|[._ -])(?:sample|trailer|proof)(?:[._ -]|$)/i.test(file.name)
  );
  if (media.type !== 'series' || !media.season || !media.episode) return videos;
  const code = new RegExp(
    `(?:s0*${media.season}[._ -]*e0*${media.episode}|${media.season}x0*${media.episode})(?:\\D|$)`,
    'i'
  );
  const exact = videos.filter((file) => code.test(file.name));
  if (exact.length) return exact;

  // Expanded season archives frequently name files as E01/01 without
  // repeating S01. Only interpret those short forms when the parent release
  // is a confirmed pack for the requested season.
  const release = releaseTitle
    ? parseNewshostingRelease(releaseTitle)
    : undefined;
  if (release?.season === media.season && release.seasonPack) {
    const packEpisode = videos.filter((file) => {
      const parsed = parseNewshostingRelease(file.name);
      return (
        parsed.episode === media.episode ||
        parsed.absoluteEpisode === media.episode ||
        Boolean(
          parsed.episodeRange &&
          media.episode &&
          parsed.episodeRange.start <= media.episode &&
          parsed.episodeRange.end >= media.episode
        )
      );
    });
    if (packEpisode.length) return packEpisode;
  }

  if (videos.length !== 1) return [];
  const only = parseNewshostingRelease(videos[0].name);
  const explicitSeasonMismatch =
    only.season !== undefined && only.season !== media.season;
  const explicitEpisodeMatch =
    only.episode === media.episode ||
    only.absoluteEpisode === media.episode ||
    Boolean(
      only.episodeRange &&
      media.episode &&
      only.episodeRange.start <= media.episode &&
      only.episodeRange.end >= media.episode
    );
  const hasExplicitEpisode =
    only.episode !== undefined ||
    only.absoluteEpisode !== undefined ||
    only.episodeRange !== undefined;
  return !explicitSeasonMismatch &&
    (!hasExplicitEpisode || explicitEpisodeMatch)
    ? videos
    : [];
}

export function buildDeepbridQueries(
  metadata: NewshostingMediaMetadata,
  media: NewshostingMediaRequest
): string[] {
  const standard = buildNewshostingQueries(metadata, media);
  if (media.type !== 'series' || !media.season || !media.episode) {
    return standard.slice(0, 2);
  }
  const exact = standard.find((query) => /\bS\d{2}E\d{2,3}\b/i.test(query));
  const season = standard.find(
    (query) => /\bS\d{2}\b/i.test(query) && !/\bS\d{2}E\d{2,3}\b/i.test(query)
  );
  const broad = standard.find(
    (query) => !/\bS\d{2}(?:E\d{2,3})?\b/i.test(query)
  );
  return [...new Set([exact, season, broad].filter(Boolean))] as string[];
}

type RankedDeepbridResult = {
  result: DeepbridFinderResult;
  score: number;
  confirmed: boolean;
};

export function prioritizeDeepbridSeasonPacks(
  ranked: RankedDeepbridResult[],
  media: NewshostingMediaRequest,
  limit: number
): RankedDeepbridResult[] {
  const cappedLimit = Math.max(0, limit);
  if (
    cappedLimit === 0 ||
    media.type !== 'series' ||
    media.season === undefined
  ) {
    return ranked.slice(0, cappedLimit);
  }

  // Exact episode searches can produce enough high-scoring results to fill
  // the resolve budget before a season pack is reached. Reserve a small part
  // of that budget for matching packs and resolve them first, while retaining
  // the original ranking for the rest.
  const packs = ranked.filter((item) => {
    const parsed = parseNewshostingRelease(item.result.title);
    return parsed.season === media.season && parsed.seasonPack === true;
  });
  const packLimit = Math.min(
    packs.length,
    Math.max(1, Math.ceil(cappedLimit / 4))
  );
  const selectedPacks = packs.slice(0, packLimit);
  const packTokens = new Set(selectedPacks.map((item) => item.result.token));
  return [
    ...selectedPacks,
    ...ranked.filter((item) => !packTokens.has(item.result.token)),
  ].slice(0, cappedLimit);
}

type ResolvedDeepbridFile = RankedDeepbridResult & {
  file: DeepbridFinderFile;
  archiveExpanded: boolean;
};

export interface ResolveDeepbridOptions {
  concurrency: number;
  maxResults: number;
  deadline: number;
  signal?: AbortSignal;
  now?: () => number;
  getContent: (
    token: string,
    archives: boolean,
    options: { timeoutMs: number; signal?: AbortSignal }
  ) => Promise<DeepbridFinderContent>;
  probeFile?: (
    file: DeepbridFinderFile,
    options: { timeoutMs: number; signal?: AbortSignal }
  ) => Promise<boolean>;
}

const DEEPBRID_CALL_TIMEOUT_MS = 7_000;
const DEEPBRID_DEADLINE_MARGIN_MS = 3_000;
const DEEPBRID_MIN_REQUEST_BUDGET_MS = 750;

function remainingRequestBudget(deadline: number, now: () => number): number {
  return Math.min(DEEPBRID_CALL_TIMEOUT_MS, deadline - now());
}

export async function resolveDeepbridFiles(
  ranked: RankedDeepbridResult[],
  media: NewshostingMediaRequest,
  options: ResolveDeepbridOptions
): Promise<ResolvedDeepbridFile[]> {
  const now = options.now ?? Date.now;
  const resolvedByIndex = new Map<number, ResolvedDeepbridFile[]>();
  const concurrency = Math.max(1, Math.min(10, options.concurrency));
  let nextIndex = 0;
  let resolvedCount = 0;
  let activeCandidates = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      if (
        resolvedCount + activeCandidates >= options.maxResults ||
        options.signal?.aborted ||
        remainingRequestBudget(options.deadline, now) <
          DEEPBRID_MIN_REQUEST_BUDGET_MS
      ) {
        return;
      }
      const index = nextIndex++;
      if (index >= ranked.length) return;
      const item = ranked[index];
      activeCandidates += 1;
      try {
        const release = parseNewshostingRelease(item.result.title);
        const seasonPack =
          media.type === 'series' &&
          media.season !== undefined &&
          release.season === media.season &&
          release.seasonPack === true;
        let timeoutMs = remainingRequestBudget(options.deadline, now);
        if (timeoutMs < DEEPBRID_MIN_REQUEST_BUDGET_MS) return;

        // Finder can expand a known season pack in the same request. Avoid
        // first fetching its archive listing and then fetching it again.
        let archiveExpanded = seasonPack;
        let content = await options.getContent(item.result.token, seasonPack, {
          timeoutMs,
          signal: options.signal,
        });
        if (content.hasPassword) continue;
        if (
          !seasonPack &&
          content.files.some((file) => isDeepbridArchiveName(file.name))
        ) {
          timeoutMs = remainingRequestBudget(options.deadline, now);
          if (timeoutMs < DEEPBRID_MIN_REQUEST_BUDGET_MS) return;
          content = await options.getContent(item.result.token, true, {
            timeoutMs,
            signal: options.signal,
          });
          archiveExpanded = true;
        }
        const files = chooseDeepbridVideoFiles(
          content.files,
          media,
          item.result.title
        );
        if (!options.probeFile) {
          const values = files.map((file) => ({
            ...item,
            file,
            archiveExpanded,
          }));
          resolvedByIndex.set(index, values);
          resolvedCount += values.length;
          continue;
        }
        const probed = await Promise.all(
          files.map(async (file) => {
            const probeTimeoutMs = remainingRequestBudget(
              options.deadline,
              now
            );
            if (probeTimeoutMs < DEEPBRID_MIN_REQUEST_BUDGET_MS)
              return undefined;
            return (await options.probeFile!(file, {
              timeoutMs: probeTimeoutMs,
              signal: options.signal,
            }))
              ? { ...item, file, archiveExpanded }
              : undefined;
          })
        );
        const values = probed.filter(
          (value): value is ResolvedDeepbridFile => value !== undefined
        );
        resolvedByIndex.set(index, values);
        resolvedCount += values.length;
      } catch (error) {
        if (error instanceof DeepbridApiError && error.code === 'api_12') {
          continue;
        }
        logger.debug(
          { error: error instanceof Error ? error.message : String(error) },
          'Deepbrid content resolution failed'
        );
      } finally {
        activeCandidates -= 1;
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return [...resolvedByIndex.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([, values]) => values)
    .slice(0, options.maxResults);
}

export class DeepbridUsenetAddon extends BaseDebridAddon<DeepbridUsenetConfig> {
  readonly id = 'deepbrid-usenet';
  readonly name = 'Deepbrid Usenet';
  readonly version = '1.0.0';
  readonly logger = logger;

  constructor(config: DeepbridUsenetConfig, clientIp?: string) {
    super(config, DeepbridUsenetConfigSchema, clientIp);
  }

  private get deepbridApiKey(): string {
    return requireDeepbridApiKey(this.userData);
  }

  override async getStreams(
    type: string,
    id: string,
    _signal?: AbortSignal
  ): Promise<Stream[]> {
    // If in indexer mode, fallback to BaseDebridAddon processing which handles NZBs
    if (this.userData.mode === 'indexer') {
      return super.getStreams(type, id);
    }

    const deadline =
      Date.now() +
      Math.max(
        DEEPBRID_MIN_REQUEST_BUDGET_MS,
        this.userData.timeout - DEEPBRID_DEADLINE_MARGIN_MS
      );
    const parsedId = IdParser.parse(id, type);
    if (!parsedId || !this.supportedIdTypes.includes(parsedId.type))
      throw new Error(`Unsupported ID: ${id}`);
    this._searchMetadataPromise = this._getSearchMetadata(parsedId, type);
    const metadata = metadataForSearch(await this.getSearchMetadata());
    const media = mediaForSearch(parsedId);
    const queries = buildDeepbridQueries(metadata, media);
    if (!queries.length) return [];

    const client = new DeepbridFinderClient(
      this.deepbridApiKey,
      this.userData.timeout
    );
    const searchTimeout = remainingRequestBudget(deadline, Date.now);
    if (searchTimeout < DEEPBRID_MIN_REQUEST_BUDGET_MS) return [];
    const searched = await Promise.allSettled(
      queries.map((query) =>
        deepbridNetworkLimit(() =>
          client.search(query, {
            category: categoryFor(media, metadata.isAnime),
            limit: 50,
            timeoutMs: searchTimeout,
            signal: undefined,
          })
        )
      )
    );
    const finderResults = searched.flatMap((entry) =>
      entry.status === 'fulfilled' ? entry.value : []
    );
    if (searched.every((entry) => entry.status === 'rejected')) {
      throw searched[0].reason;
    }
    const seen = new Set<string>();
    const ranked = finderResults
      .filter((item) => !seen.has(item.token) && seen.add(item.token))
      .map((result) => ({ result, ...rankResult(result, media, metadata) }))
      .filter((item) => item.confirmed && item.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.result.sources - a.result.sources ||
          b.result.size - a.result.size
      );
    const candidates = prioritizeDeepbridSeasonPacks(
      ranked,
      media,
      this.userData.maxContentResolves
    );

    this.logger.info(
      {
        type,
        queryCount: queries.length,
        successfulQueries: searched.filter(
          (entry) => entry.status === 'fulfilled'
        ).length,
        finderResults: finderResults.length,
        confirmedResults: ranked.length,
        contentCandidates: candidates.length,
        seasonPackCandidates: candidates.filter(
          (item) => parseNewshostingRelease(item.result.title).seasonPack
        ).length,
      },
      'Deepbrid Finder search completed'
    );

    // Older generated addon configs defaulted to three workers. Keep those
    // configs fast after an upgrade while retaining the hard safety cap.
    const resolveConcurrency = Math.max(
      1,
      Math.min(10, this.userData.resolveConcurrency)
    );
    const resolved = await resolveDeepbridFiles(candidates, media, {
      concurrency: resolveConcurrency,
      maxResults: this.userData.maxResults,
      deadline,
      signal: undefined,
      getContent: (token, archives, requestOptions) =>
        deepbridNetworkLimit(() =>
          client.getContent(token, archives, requestOptions)
        ),
      probeFile: (() => {
        // Finder can return the same CDN link under multiple releases. A
        // single preflight is sufficient for that URL; retaining the
        // individual resolved entries still preserves every distinct stream.
        const probeCache = new Map<string, Promise<boolean>>();
        return (file, requestOptions) => {
          // The byte signature check also uses the filename extension, so
          // keep that part of the key to avoid cross-extension false sharing.
          const extension =
            file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
          const cacheKey = `${file.link}\u0000${extension}`;
          const cached = probeCache.get(cacheKey);
          if (cached) return cached;
          if (hasSuccessfulDeepbridProbe(cacheKey)) {
            return Promise.resolve(true);
          }
          const probe = deepbridNetworkLimit(() =>
            probeDeepbridVideo(file, this.deepbridApiKey, requestOptions)
          ).then((playable) => {
            if (playable) rememberSuccessfulDeepbridProbe(cacheKey);
            return playable;
          });
          probeCache.set(cacheKey, probe);
          return probe;
        };
      })(),
    });
    this.logger.info(
      {
        type,
        confirmedResults: ranked.length,
        resolvedFiles: resolved.length,
        elapsedMs:
          this.userData.timeout -
          DEEPBRID_DEADLINE_MARGIN_MS -
          Math.max(0, deadline - Date.now()),
      },
      'Deepbrid Finder resolution completed'
    );

    return resolved.map(({ result, file, archiveExpanded }) => {
      const target = validateDeepbridDownloadUrl(file.link);
      const playbackUrl = createDeepbridPlaybackUrl({
        apiKey: this.deepbridApiKey,
        url: target.toString(),
        filename: file.name,
        size: file.size || undefined,
      });
      return {
        name: '[DB⚡] Deepbrid Usenet',
        title: result.title,
        description: `${result.title}\n${file.name}\n🔍 Deepbrid Usenet${result.sources ? ` · ${result.sources} sources` : ''}`,
        url: playbackUrl,
        type: 'usenet',
        idMatched: true,
        age: ageHours(result.date),
        behaviorHints: {
          notWebReady: false,
          filename: file.name,
          videoSize: file.size || result.size || undefined,
          bingeGroup: `deepbrid-usenet|${file.name.toLowerCase()}`,
          deepbridSeasonPack:
            parseNewshostingRelease(result.title).seasonPack === true,
          deepbridReleaseTitle: result.title,
          deepbridReleaseSize: result.size || undefined,
          // Stable, secret-free identity used to avoid re-adding this Finder
          // NZB through Deepbrid when another indexer returns the same URL.
          deepbridNzbHash: file.nzbUrl ? hashNzbUrl(file.nzbUrl) : undefined,
          deepbridArchiveExpanded: archiveExpanded,
        },
      } satisfies Stream;
    });
  }

  protected async _searchTorrents(_parsedId: ParsedId): Promise<Torrent[]> {
    return [];
  }

  protected async _searchNzbs(parsedId: ParsedId): Promise<NZB[]> {
    if (this.userData.mode !== 'indexer') return [];

    const deadline =
      Date.now() +
      Math.max(
        DEEPBRID_MIN_REQUEST_BUDGET_MS,
        this.userData.timeout - DEEPBRID_DEADLINE_MARGIN_MS
      );
    const metadata = metadataForSearch(await this.getSearchMetadata());
    const media = mediaForSearch(parsedId);
    const queries = buildDeepbridQueries(metadata, media);
    if (!queries.length) return [];

    const client = new DeepbridFinderClient(
      this.deepbridApiKey,
      this.userData.timeout
    );
    const searchTimeout = remainingRequestBudget(deadline, Date.now);
    if (searchTimeout < DEEPBRID_MIN_REQUEST_BUDGET_MS) return [];
    const searched = await Promise.allSettled(
      queries.map((query) =>
        deepbridNetworkLimit(() =>
          client.search(query, {
            category: categoryFor(media, metadata.isAnime),
            limit: 50,
            timeoutMs: searchTimeout,
          })
        )
      )
    );
    const finderResults = searched.flatMap((entry) =>
      entry.status === 'fulfilled' ? entry.value : []
    );
    if (searched.every((entry) => entry.status === 'rejected')) {
      throw searched[0].reason;
    }
    const seen = new Set<string>();
    const ranked = finderResults
      .filter((item) => !seen.has(item.token) && seen.add(item.token))
      .map((result) => ({ result, ...rankResult(result, media, metadata) }))
      .filter((item) => item.confirmed && item.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.result.sources - a.result.sources ||
          b.result.size - a.result.size
      );
    const candidates = prioritizeDeepbridSeasonPacks(
      ranked,
      media,
      this.userData.maxContentResolves
    );

    const resolveConcurrency = Math.max(
      1,
      Math.min(10, this.userData.resolveConcurrency)
    );
    const resolved = await resolveDeepbridFiles(candidates, media, {
      concurrency: resolveConcurrency,
      maxResults: this.userData.maxResults,
      deadline,
      getContent: (token, archives, requestOptions) =>
        deepbridNetworkLimit(() =>
          client.getContent(token, archives, requestOptions)
        ),
      // Indexer mode does NOT preflight actual video streams. We just want the NZBs.
      probeFile: () => Promise.resolve(true),
    });

    const indexedNzbs: NZB[] = [];
    for (const { result, file } of resolved) {
      if (!file.nzbUrl) continue;
      indexedNzbs.push({
        type: 'usenet',
        hash: hashNzbUrl(file.nzbUrl),
        title: result.title,
        size: file.size,
        nzb: file.nzbUrl,
        // This stable service id is also the loop-prevention marker used by
        // processNZBs when Deepbrid is configured as an external resolver.
        indexer: constants.DEEPBRID_SERVICE,
        confirmed: true,
        age: ageHours(result.date),
      });
    }
    return indexedNzbs;
  }
}
