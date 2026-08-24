import { TorboxApi } from '@torbox/torbox-api';
import {
  appConfig,
  ServiceId,
  createLogger,
  getSimpleTextHash,
  Cache,
  DistributedLock,
  getTimeTakenSincePoint,
  makeUrlLogSafe,
  Time,
} from '../utils/index.js';
import { StremThruService } from './stremthru.js';
import {
  selectFileInTorrentOrNZB,
  hashNzbUrl,
  buildResolveKey,
  removeDownloadOnAbort,
} from './utils.js';
import {
  DebridServiceConfig,
  DebridDownload,
  PlaybackInfo,
  DebridError,
  TorrentDebridService,
  UsenetDebridService,
  DebridFailureCache,
  convertStatusCodeToError,
} from './base.js';
import { ParsedResult } from '@viren070/parse-torrent-title';
import { parseTorrentTitleCached } from '../parser/title.js';
import {
  DEFAULT_TORBOX_PLAYBACK_PREFERENCES,
  parseTorboxCredential,
  TorboxClient,
  type TorboxCredentialPayload,
  type TorboxMediaType,
} from './torbox-client.js';
import pLimit from 'p-limit';
import {
  chunkTorboxNzbHashes,
  fetchTorboxNzbDocument,
  fetchTorboxNzbHashes,
  getTorboxNzbHashes,
} from './torbox-nzb-hashes.js';

const logger = createLogger('debrid:torbox');
const TORBOX_NZB_HASH_CACHE_TTL_SECONDS = 24 * 60 * 60;
// Content-hash enrichment is optional: URL hashes are checked immediately and
// every source is still emitted when this background work is skipped. Keep the
// lane deliberately small because protected indexers may take 15-30 seconds to
// generate each NZB; a large queue can otherwise saturate the local NZB proxy
// long after the originating scrape has completed.
const torboxNzbHashEnrichmentLimit = pLimit(1);
const torboxNzbHashEnrichmentInFlight = new Map<string, Promise<void>>();
const torboxNzbHashEnrichmentRetryAt = new Map<string, number>();
const TORBOX_NZB_HASH_ENRICHMENT_QUEUE_LIMIT = 8;
const TORBOX_NZB_HASH_ENRICHMENT_RETRY_MS = 15 * 60_000;
const torboxNzbContentHashCache = Cache.getInstance<string, string[]>(
  'tb:nzb-content-hashes'
);
const TORBOX_AVAILABILITY_MIN_INTERVAL_MS = 210;
const TORBOX_AVAILABILITY_LANE_IDLE_MS = 10 * 60_000;
type TorboxAvailabilityLane = {
  limit: ReturnType<typeof pLimit>;
  lastStartedAt: number;
  lastUsedAt: number;
};
const torboxAvailabilityLanes = new Map<string, TorboxAvailabilityLane>();

function getTorboxAvailabilityLane(credential: string): TorboxAvailabilityLane {
  const key = getSimpleTextHash(credential);
  const existing = torboxAvailabilityLanes.get(key);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing;
  }
  if (torboxAvailabilityLanes.size >= 256) {
    const cutoff = Date.now() - TORBOX_AVAILABILITY_LANE_IDLE_MS;
    for (const [candidateKey, lane] of torboxAvailabilityLanes) {
      if (
        lane.lastUsedAt < cutoff &&
        lane.limit.activeCount === 0 &&
        lane.limit.pendingCount === 0
      ) {
        torboxAvailabilityLanes.delete(candidateKey);
      }
    }
  }
  const lane: TorboxAvailabilityLane = {
    limit: pLimit(1),
    lastStartedAt: 0,
    lastUsedAt: Date.now(),
  };
  torboxAvailabilityLanes.set(key, lane);
  return lane;
}

/**
 * Serialize and pace checkcached calls across every TorBox service instance
 * using the same credential. Per-addon pLimit queues still burst together;
 * this credential-scoped lane enforces TorBox's documented 300/minute budget
 * without coupling different users.
 */
export async function runTorboxAvailabilityLimited<T>(
  credential: string,
  operation: () => Promise<T>,
  minimumIntervalMs = TORBOX_AVAILABILITY_MIN_INTERVAL_MS
): Promise<T> {
  const lane = getTorboxAvailabilityLane(credential);
  return lane.limit(async () => {
    const waitMs = Math.max(
      0,
      lane.lastStartedAt + Math.max(0, minimumIntervalMs) - Date.now()
    );
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    lane.lastStartedAt = Date.now();
    lane.lastUsedAt = lane.lastStartedAt;
    return operation();
  });
}

export function resetTorboxAvailabilityLanesForTests(): void {
  torboxAvailabilityLanes.clear();
}

export function scheduleTorboxNzbHashEnrichment(
  url: string,
  title?: string,
  fetchHashes: typeof fetchTorboxNzbHashes = fetchTorboxNzbHashes
): boolean {
  const key = getSimpleTextHash(url);
  const now = Date.now();
  if (torboxNzbHashEnrichmentInFlight.has(key)) return false;
  if ((torboxNzbHashEnrichmentRetryAt.get(key) ?? 0) > now) return false;
  if (
    torboxNzbHashEnrichmentInFlight.size >=
    TORBOX_NZB_HASH_ENRICHMENT_QUEUE_LIMIT
  ) {
    return false;
  }

  // Claim the URL before entering p-limit so parallel addon instances cannot
  // enqueue the same protected download endpoint more than once.
  torboxNzbHashEnrichmentRetryAt.set(
    key,
    now + TORBOX_NZB_HASH_ENRICHMENT_RETRY_MS
  );

  const task = torboxNzbHashEnrichmentLimit(async () => {
    try {
      const hashes = await fetchHashes(url);
      await torboxNzbContentHashCache.set(
        key,
        hashes,
        TORBOX_NZB_HASH_CACHE_TTL_SECONDS,
        true
      );
    } catch (error) {
      logger.debug('TorBox background NZB hash enrichment failed', {
        name: title,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }).finally(() => {
    torboxNzbHashEnrichmentInFlight.delete(key);
    if (torboxNzbHashEnrichmentRetryAt.size > 4096) {
      const cutoff = Date.now();
      for (const [candidateKey, retryAt] of torboxNzbHashEnrichmentRetryAt) {
        if (retryAt <= cutoff) {
          torboxNzbHashEnrichmentRetryAt.delete(candidateKey);
        }
      }
    }
  });
  torboxNzbHashEnrichmentInFlight.set(key, task);
  return true;
}

export async function waitForTorboxNzbHashEnrichmentsForTests(): Promise<void> {
  await Promise.allSettled([...torboxNzbHashEnrichmentInFlight.values()]);
}

export function resetTorboxNzbHashEnrichmentsForTests(): void {
  torboxNzbHashEnrichmentRetryAt.clear();
  torboxNzbHashEnrichmentInFlight.clear();
}

/**
 * TorBox reports the failure kind as a string enum in the `error` field of its
 * JSON body. Codes missing from this table stay UNKNOWN and get logged so new
 * ones surface rather than silently becoming a generic 500.
 */
const TORBOX_ERROR_CODES: Record<string, NonNullable<DebridError['code']>> = {
  AUTH_ERROR: 'UNAUTHORIZED',
  BAD_TOKEN: 'UNAUTHORIZED',
  NO_AUTH: 'UNAUTHORIZED',
  OAUTH_VERIFICATION_ERROR: 'UNAUTHORIZED',
  NOT_ALLOWED: 'FORBIDDEN',
  PLAN_RESTRICTED_FEATURE: 'PAYMENT_REQUIRED',
  ACTIVE_LIMIT: 'STORE_LIMIT_EXCEEDED',
  COOLDOWN_LIMIT: 'STORE_LIMIT_EXCEEDED',
  DOWNLOAD_TOO_LARGE: 'STORE_LIMIT_EXCEEDED',
  MONTHLY_LIMIT: 'STORE_LIMIT_EXCEEDED',
  TOO_MUCH_DATA: 'STORE_LIMIT_EXCEEDED',
  RATE_LIMIT_EXCEEDED: 'TOO_MANY_REQUESTS',
  DOWNLOAD_SERVER_ERROR: 'BAD_GATEWAY',
  BOZO_NZB: 'STORE_MAGNET_INVALID',
  BOZO_TORRENT: 'STORE_MAGNET_INVALID',
  LINK_OFFLINE: 'GONE',
  ENDPOINT_NOT_FOUND: 'NOT_FOUND',
  ITEM_NOT_FOUND: 'NOT_FOUND',
  DUPLICATE_ITEM: 'CONFLICT',
  INVALID_INPUT: 'BAD_REQUEST',
  INVALID_OPTION: 'BAD_REQUEST',
  NO_SERVERS_AVAILABLE_ERROR: 'SERVICE_UNAVAILABLE',
  VENDOR_DISABLED: 'SERVICE_UNAVAILABLE',
  DATABASE_ERROR: 'INTERNAL_SERVER_ERROR',
  UNKNOWN_ERROR: 'INTERNAL_SERVER_ERROR',
};

function convertTorBoxError(error: any): DebridError {
  if (typeof error.message === 'string') {
    // The SDK folds the response body into its message as a `Body: {...}` line.
    const body = (() => {
      const match = error.message.match(/Body:\s*({[\s\S]*})/);
      if (match) {
        try {
          return JSON.parse(match[1]);
        } catch (e) {
          logger.warn(
            `Failed to parse error body JSON: ${e instanceof Error ? e.message : String(e)}`
          );
          return undefined;
        }
      }
      return undefined;
    })();
    // Some responses (rate limits, gateway errors) carry only a `detail`, so the
    // HTTP status is the only thing left to classify them by.
    const apiCode: string | undefined =
      typeof body?.error === 'string' ? body.error : undefined;
    const detail = typeof body?.detail === 'string' ? body.detail : undefined;
    const statusCode =
      typeof error.metadata?.status === 'number'
        ? error.metadata.status
        : undefined;
    const statusText =
      typeof error.metadata?.statusText === 'string'
        ? error.metadata.statusText
        : undefined;

    const mappedCode = apiCode ? TORBOX_ERROR_CODES[apiCode] : undefined;
    let code: DebridError['code'] =
      mappedCode ??
      (statusCode !== undefined
        ? convertStatusCodeToError(statusCode)
        : 'UNKNOWN');
    // Lead with whatever names the failure so it survives into the logs and the
    // failure cache; the SDK's own message is a multi-line dump of the response.
    let message =
      (apiCode ?? statusText)
        ? `${apiCode ?? statusText}${detail ? `: ${detail}` : ''}`
        : detail || error.message || 'Unknown error';

    if (error.message.includes('rate limit')) {
      code = 'TOO_MANY_REQUESTS';
      message = 'Too many requests - rate limit exceeded';
    }

    if (apiCode && !mappedCode) {
      logger.warn(`Unmapped error code from Torbox API: ${apiCode}`, {
        statusCode,
        detail,
      });
    } else if (code === 'UNKNOWN') {
      logger.warn(`Could not classify error response from Torbox API`, {
        statusCode,
        response: error.message,
      });
    }

    return new DebridError(message, {
      statusCode: statusCode ?? 500,
      statusText: statusText ?? 'Unknown error',
      code,
      headers: error.metadata?.headers ?? {},
      body,
      cause: {},
      type: 'api_error',
    });
  }
  return new DebridError(error.message, {
    statusCode: error.statusCode ?? 500,
    statusText: error.statusText ?? 'Unknown error',
    code: 'UNKNOWN',
    headers: error.headers ?? {},
    body: error,
    cause: error,
    type: 'api_error',
  });
}

export class TorboxDebridService
  implements TorrentDebridService, UsenetDebridService
{
  private readonly apiVersion = 'v1';
  private readonly torboxApi: TorboxApi;
  private readonly stremthru: StremThruService;
  private readonly client: TorboxClient;
  private readonly credential: TorboxCredentialPayload;
  private readonly pollInterval: number;
  private readonly maxWaitTime: number;
  private static playbackLinkCache = Cache.getInstance<string, string | null>(
    'tb:link'
  );
  private static instantAvailabilityCache = Cache.getInstance<
    string,
    DebridDownload
  >('tb:instant-availability');
  readonly serviceName: ServiceId = 'torbox';
  readonly capabilities = { torrents: true, usenet: true };

  constructor(
    private readonly config: DebridServiceConfig,
    options?: {
      pollInterval?: number;
      maxWaitTime?: number;
      credential?: TorboxCredentialPayload;
      client?: TorboxClient;
    }
  ) {
    this.pollInterval = options?.pollInterval ?? Time.Second * 10;
    this.maxWaitTime = options?.maxWaitTime ?? Time.Minute * 2;
    this.credential =
      options?.credential ?? parseTorboxCredential(config.token);
    this.client = options?.client ?? new TorboxClient();
    this.torboxApi = new TorboxApi({
      token: config.token,
    });

    this.stremthru = new StremThruService({
      serviceName: this.serviceName,
      clientIp: config.clientIp,
      stremthru: {
        baseUrl: appConfig.builtins.stremthru.url,
        store: this.serviceName,
        token: config.token,
      },
      capabilities: { torrents: true, usenet: false },
      torrentPlaybackResolver: async ({ downloadId, fileId, playbackInfo }) =>
        (
          await this.resolveTorboxPlayback(
            'torrent',
            downloadId,
            fileId,
            playbackInfo.torbox
          )
        ).url,
    });
  }
  public async listMagnets(): Promise<DebridDownload[]> {
    return this.stremthru.listMagnets();
  }
  public async getMagnet(magnetId: string): Promise<DebridDownload> {
    return this.stremthru.getMagnet(magnetId);
  }

  public async removeMagnet(magnetId: string): Promise<void> {
    return this.stremthru.removeMagnet(magnetId);
  }

  public async removeNzb(nzbId: string): Promise<void> {
    try {
      await this.torboxApi.usenet.controlUsenetDownload(this.apiVersion, {
        usenet_id: parseInt(nzbId, 10),
        operation: 'delete',
      });
      logger.debug(`Removed usenet download ${nzbId} from Torbox`);
    } catch (error: any) {
      throw new DebridError(
        `Failed to remove usenet download: ${error.message}`,
        {
          statusCode: error.statusCode ?? 500,
          statusText: error.statusText ?? 'Unknown error',
          code: 'UNKNOWN',
          headers: {},
          body: error,
          type: 'api_error',
        }
      );
    }
  }

  public async checkMagnets(
    magnets: string[],
    sid?: string,
    checkOwned: boolean = true
  ) {
    return this.stremthru.checkMagnets(magnets, sid, checkOwned);
  }

  public async addMagnet(magnet: string): Promise<DebridDownload> {
    return this.stremthru.addMagnet(magnet);
  }

  public async addTorrent(torrent: string): Promise<DebridDownload> {
    return this.stremthru.addTorrent(torrent);
  }

  public async generateTorrentLink(
    link: string,
    clientIp?: string
  ): Promise<string> {
    return this.stremthru.generateTorrentLink(link, clientIp);
  }

  public async checkNzbs(
    nzbs: { name?: string; hash?: string; nzb?: string }[]
  ): Promise<DebridDownload[]> {
    const sourceByCandidate = new Map<string, string>();
    const candidateGroups = await Promise.all(
      nzbs
        .filter(
          (nzb): nzb is { name?: string; hash: string; nzb?: string } =>
            typeof nzb.hash === 'string' && nzb.hash.length > 0
        )
        .map(async (source) => {
          const candidates = new Set<string>([source.hash.toLowerCase()]);
          if (source.nzb) {
            // TorBox officially accepts the MD5 of either an NZB link or file.
            // Link hashes are immediate; full NZB generation can take seconds
            // per result for protected indexers such as Newshosting, so reuse
            // cached content hashes and enrich missing entries in the
            // background without delaying or hiding the uncached result.
            for (const hash of await getTorboxNzbHashes({ url: source.nzb })) {
              candidates.add(hash.toLowerCase());
            }
            const hashCacheKey = getSimpleTextHash(source.nzb);
            const cachedHashes =
              await torboxNzbContentHashCache.get(hashCacheKey);
            if (cachedHashes?.length) {
              for (const hash of cachedHashes) {
                candidates.add(hash.toLowerCase());
              }
            } else {
              scheduleTorboxNzbHashEnrichment(source.nzb, source.name);
            }
          }
          return { source, candidates: [...candidates] };
        })
    );
    for (const { source, candidates } of candidateGroups)
      for (const candidate of candidates)
        sourceByCandidate.set(candidate, source.hash);
    if (candidateGroups.length === 0) {
      return [];
    }
    const cachedResults: DebridDownload[] = [];
    const hashesToCheck: string[] = [];
    const availability = await Promise.all(
      candidateGroups.map(async ({ source, candidates }) => ({
        candidates,
        cached: await TorboxDebridService.instantAvailabilityCache.get(
          getSimpleTextHash(source.hash.toLowerCase())
        ),
      }))
    );
    for (const { candidates, cached } of availability) {
      if (cached) {
        cachedResults.push(cached);
      } else {
        hashesToCheck.push(...candidates);
      }
    }

    if (hashesToCheck.length > 0) {
      let newResults: DebridDownload[] = [];
      // The TorBox endpoint accepts 100 hashes per request, not 100 hashes per
      // scrape. Check every unique candidate in bounded batches so later
      // indexers are not silently starved by earlier results.
      const allUniqueHashes = [...new Set(hashesToCheck)];

      try {
        const responses = await Promise.all(
          chunkTorboxNzbHashes(allUniqueHashes).map((hashes) =>
            runTorboxAvailabilityLimited(this.config.token, async () => {
              try {
                return await Promise.race([
                  this.torboxApi.usenet.getUsenetCachedAvailability(
                    this.apiVersion,
                    {
                      hashes,
                      format: 'list',
                      listFiles: 'true',
                    }
                  ),
                  new Promise<null>((_, reject) =>
                    setTimeout(
                      () => reject(new Error('TorBox usenet check timeout')),
                      4500
                    )
                  ),
                ]);
              } catch (err: any) {
                logger.warn(
                  { err: err?.message, hashesCount: hashes.length },
                  'TorBox Usenet chunk availability check failed, timed out, or was rate-limited'
                );
                return null;
              }
            })
          )
        );
        for (const result of responses) {
          if (
            !result ||
            !result.data?.success ||
            !Array.isArray(result.data.data)
          ) {
            continue;
          }
          newResults.push(
            ...result.data.data.map((item) => ({
              id: -1,
              hash: item.hash
                ? (sourceByCandidate.get(item.hash.toLowerCase()) ?? item.hash)
                : undefined,
              status: 'cached' as const,
              size: item.size,
              files: item.files?.map((file) => ({
                id: file.id,
                name: file.shortName ?? file.name ?? '',
                size: file.size ?? 0,
                mimeType: file.mimetype,
              })),
            }))
          );
        }
        newResults = [
          ...new Map(
            newResults.map((item) => [item.hash, item] as const)
          ).values(),
        ];

        newResults
          .filter((item) => item.hash)
          .forEach((item) => {
            TorboxDebridService.instantAvailabilityCache.set(
              getSimpleTextHash(item.hash!),
              item,
              appConfig.builtins.debrid.instantAvailabilityCacheTtl
            );
          });
      } catch (error: any) {
        const converted = convertTorBoxError(error);
        if (
          converted.code === 'TOO_MANY_REQUESTS' ||
          converted.message.toLowerCase().includes('rate limit')
        ) {
          logger.warn(
            { error: converted.message, hashesCount: hashesToCheck.length },
            'TorBox availability check was rate-limited; returning partial availability without failing scrape'
          );
        } else {
          throw converted;
        }
      }

      return [...cachedResults, ...newResults];
    }

    return cachedResults;
  }

  private async addNzbFile(
    nzb: string,
    name: string,
    addOnlyIfCached: boolean
  ): Promise<DebridDownload> {
    try {
      const document = await fetchTorboxNzbDocument(nzb);
      const created = await this.client.createUsenetDownloadFromFile(
        this.config.token,
        document.xml,
        name,
        addOnlyIfCached
      );
      const usenetDownload = await this.listNzbs(String(created.id));
      if (Array.isArray(usenetDownload)) {
        return usenetDownload[0];
      }
      return usenetDownload;
    } catch (error: any) {
      throw convertTorBoxError(error);
    }
  }

  public addNzb(nzb: string, name: string): Promise<DebridDownload> {
    return this.addNzbFile(nzb, name, false);
  }

  private static libraryCache = Cache.getInstance<string, DebridDownload[]>(
    'tb:library'
  );

  private async _fetchNzbList(id?: string): Promise<DebridDownload[]> {
    let nzbInfo;
    try {
      nzbInfo = await this.torboxApi.usenet.getUsenetList(this.apiVersion, {
        id,
        bypassCache: 'true',
      });
    } catch (error: any) {
      throw convertTorBoxError(error);
    }

    if (
      !nzbInfo?.data?.data ||
      nzbInfo?.data?.error ||
      nzbInfo.data.success === false
    ) {
      throw new DebridError(
        `Failed to get usenet list: ${nzbInfo?.data?.error || 'Unknown error'}${nzbInfo?.data?.detail ? '- ' + nzbInfo.data.detail : ''}`,
        {
          statusCode: nzbInfo.metadata.status,
          statusText: nzbInfo.metadata.statusText,
          code: 'UNKNOWN',
          headers: nzbInfo.metadata.headers,
          body: nzbInfo.data,
          cause: nzbInfo.data,
          type: 'api_error',
        }
      );
    }

    if (id && Array.isArray(nzbInfo.data.data)) {
      throw new DebridError('Unexpected response format for usenet download', {
        statusCode: nzbInfo.metadata.status,
        statusText: nzbInfo.metadata.statusText,
        code: 'UNKNOWN',
        headers: nzbInfo.metadata.headers,
        body: nzbInfo.data,
        cause: nzbInfo.data,
        type: 'api_error',
      });
    }

    return (
      Array.isArray(nzbInfo.data.data) ? nzbInfo.data.data : [nzbInfo.data.data]
    ).map((usenetDownload) => {
      let status: DebridDownload['status'] = 'queued';
      logger.debug(`computing usenet status`, {
        downloadFinished: usenetDownload.downloadFinished,
        downloadPresent: usenetDownload.downloadPresent,
        downloadState: usenetDownload.downloadState,
        progress: usenetDownload.progress,
        eta: usenetDownload.eta,
        active: usenetDownload.active,
      });
      if (
        usenetDownload.downloadFinished &&
        (usenetDownload.downloadPresent ||
          usenetDownload.downloadState
            ?.toLowerCase()
            .startsWith('direct unpack: completed'))
      ) {
        status = 'downloaded';
      } else if (
        usenetDownload.progress &&
        usenetDownload.progress > 0 &&
        usenetDownload.active
      ) {
        status = 'downloading';
      } else if (usenetDownload.downloadState?.toLowerCase().includes('fail')) {
        status = 'failed';
      } else if (
        usenetDownload.downloadState?.toLowerCase().includes('invalid')
      ) {
        status = 'invalid';
      }
      return {
        id: usenetDownload.id ?? -1,
        hash: usenetDownload.hash ?? undefined,
        name: usenetDownload.name ?? undefined,
        status,
        addedAt: usenetDownload.createdAt ?? undefined,
        files: (usenetDownload.files ?? []).map((file) => ({
          id: file.id ?? -1,
          mimeType: file.mimetype,
          name: file.shortName ?? file.name ?? '',
          size: file.size ?? 0,
        })),
      };
    });
  }

  public async listNzbs(id?: string): Promise<DebridDownload[]> {
    // If fetching a specific ID, bypass cache
    if (id) {
      return this._fetchNzbList(id);
    }

    const cacheKey = `torbox:usenet:${getSimpleTextHash(this.config.token)}`;
    const limit = Math.min(
      Math.max(appConfig.builtins.debrid.libraryPageSize, 100),
      1000
    );
    const maxItems = appConfig.builtins.debrid.libraryPageLimit * limit;

    // Check for stale cache before acquiring the lock
    const cached = await TorboxDebridService.libraryCache.get(cacheKey);
    if (cached) {
      const remainingTTL =
        await TorboxDebridService.libraryCache.getTTL(cacheKey);
      if (remainingTTL !== null && remainingTTL > 0) {
        const age = appConfig.builtins.debrid.libraryCacheTtl - remainingTTL;
        if (age > appConfig.builtins.debrid.libraryStaleThreshold) {
          logger.debug(
            `Library cache for TorBox usenet is stale (age: ${age}s), triggering background refresh`
          );
          this.refreshNzbsInBackground(cacheKey, limit, maxItems).catch((err) =>
            logger.error(
              `Background library refresh failed for TorBox usenet`,
              err
            )
          );
        }
        return cached;
      }
    }

    const { result } = await DistributedLock.getInstance().withLock(
      `tb:library:usenet:${cacheKey}`,
      async () => {
        const cached = await TorboxDebridService.libraryCache.get(cacheKey);
        if (cached) {
          logger.debug(`Using cached usenet list for TorBox`);
          return cached;
        }

        return this.fetchAndCacheNzbs(cacheKey, limit, maxItems);
      },
      { type: 'memory', timeout: 10000 }
    );
    return result;
  }

  private async fetchAndCacheNzbs(
    cacheKey: string,
    limit: number,
    maxItems: number
  ): Promise<DebridDownload[]> {
    const start = Date.now();
    const allItems: DebridDownload[] = [];
    let offset = 0;

    while (offset < maxItems) {
      let nzbInfo;
      try {
        nzbInfo = await this.torboxApi.usenet.getUsenetList(this.apiVersion, {
          limit: limit.toString(),
          offset: offset.toString(),
        });
      } catch (error: any) {
        throw convertTorBoxError(error);
      }

      if (
        !nzbInfo?.data?.data ||
        nzbInfo?.data?.error ||
        nzbInfo.data.success === false
      ) {
        throw new DebridError(
          `Failed to get usenet list: ${nzbInfo?.data?.error || 'Unknown error'}${nzbInfo?.data?.detail ? '- ' + nzbInfo.data.detail : ''}`,
          {
            statusCode: nzbInfo.metadata.status,
            statusText: nzbInfo.metadata.statusText,
            code: 'UNKNOWN',
            headers: nzbInfo.metadata.headers,
            body: nzbInfo.data,
            cause: nzbInfo.data,
            type: 'api_error',
          }
        );
      }

      const items = Array.isArray(nzbInfo.data.data)
        ? nzbInfo.data.data
        : [nzbInfo.data.data];

      for (const usenetDownload of items) {
        let status: DebridDownload['status'] = 'queued';
        if (usenetDownload.downloadFinished && usenetDownload.downloadPresent) {
          status = 'downloaded';
        } else if (usenetDownload.progress && usenetDownload.progress > 0) {
          status = 'downloading';
        }
        allItems.push({
          id: usenetDownload.id ?? -1,
          hash: usenetDownload.hash ?? undefined,
          name: usenetDownload.name ?? undefined,
          status,
          addedAt: usenetDownload.createdAt ?? undefined,
        });
      }

      if (items.length < limit) break;
      offset += limit;
    }

    logger.debug(`Listed usenet downloads from TorBox`, {
      count: allItems.length,
      timeTaken: getTimeTakenSincePoint(start),
    });

    await TorboxDebridService.libraryCache.set(
      cacheKey,
      allItems,
      appConfig.builtins.debrid.libraryCacheTtl,
      true
    );

    return allItems;
  }

  private async refreshNzbsInBackground(
    cacheKey: string,
    limit: number,
    maxItems: number
  ): Promise<void> {
    const lockKey = `tb:library:usenet:refresh:${cacheKey}`;
    await DistributedLock.getInstance().withLock(
      lockKey,
      async () => {
        await TorboxDebridService.libraryCache.delete(cacheKey);
        return this.fetchAndCacheNzbs(cacheKey, limit, maxItems);
      },
      { type: 'memory', timeout: 1000 }
    );
  }

  public async refreshLibraryCache(
    sources?: ('torrent' | 'nzb')[]
  ): Promise<void> {
    const includeTorrents =
      !sources || sources.length === 0 || sources.includes('torrent');
    const includeNzbs =
      !sources || sources.length === 0 || sources.includes('nzb');

    // Refresh magnets (delegated to StremThru)
    if (includeTorrents) {
      await this.stremthru.refreshLibraryCache();
    }

    // Refresh NZBs
    if (includeNzbs) {
      const cacheKey = `torbox:usenet:${getSimpleTextHash(this.config.token)}`;
      const limit = Math.min(
        Math.max(appConfig.builtins.debrid.libraryPageSize, 100),
        1000
      );
      const maxItems = appConfig.builtins.debrid.libraryPageLimit * limit;
      await TorboxDebridService.libraryCache.delete(cacheKey);
      await this.fetchAndCacheNzbs(cacheKey, limit, maxItems);
    }
  }

  public async getNzb(nzbId: string): Promise<DebridDownload> {
    const items = await this._fetchNzbList(nzbId);
    return items[0];
  }

  private resolveTorboxPlayback(
    type: TorboxMediaType,
    itemId: string | number,
    fileId: string | number,
    route?: PlaybackInfo['torbox']
  ) {
    const preferences = {
      ...DEFAULT_TORBOX_PLAYBACK_PREFERENCES,
      quality: this.credential.quality,
      audioLanguage: this.credential.audioLanguage,
      subtitleLanguage: this.credential.subtitleLanguage,
      appendFilename: this.credential.appendFilename,
      ...route,
    };
    return this.client.resolvePlayback({
      type,
      itemId,
      fileId,
      token: this.config.token,
      ...preferences,
    });
  }

  public async generateUsenetLink(
    downloadId: string,
    fileId?: string,
    _clientIp?: string
  ): Promise<string> {
    return this.client.buildRequestDlPermalink({
      type: 'usenet',
      itemId: downloadId,
      fileId: fileId ?? 0,
      token: this.config.token,
      ...DEFAULT_TORBOX_PLAYBACK_PREFERENCES,
    });
  }
  public async resolve(
    playbackInfo: PlaybackInfo,
    filename: string,
    cacheAndPlay: boolean,
    autoRemoveDownloads?: boolean,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    const accountCacheAndPlay =
      playbackInfo.type === 'torrent'
        ? (playbackInfo.torbox?.torrentCacheAndPlay ??
          this.credential.torrentCacheAndPlay)
        : (playbackInfo.torbox?.usenetCacheAndPlay ??
          this.credential.usenetCacheAndPlay);
    const effectiveCacheAndPlay = accountCacheAndPlay ?? cacheAndPlay;
    if (playbackInfo.type === 'torrent') {
      return this.stremthru.resolve(
        playbackInfo,
        filename,
        effectiveCacheAndPlay,
        autoRemoveDownloads,
        signal
      );
    }
    const { result } = await DistributedLock.getInstance().withLock(
      buildResolveKey(
        'tb:lock',
        this.serviceName,
        playbackInfo,
        filename,
        this.config.token,
        this.config.clientIp,
        { cacheAndPlay: effectiveCacheAndPlay, autoRemoveDownloads }
      ),
      () =>
        this._resolve(
          playbackInfo,
          filename,
          effectiveCacheAndPlay,
          autoRemoveDownloads,
          signal
        ),
      {
        timeout: effectiveCacheAndPlay
          ? this.maxWaitTime + this.pollInterval
          : 30000,
        ttl: effectiveCacheAndPlay
          ? this.maxWaitTime + this.pollInterval + 10000
          : 40000,
      }
    );
    return result;
  }

  private async _resolve(
    playbackInfo: PlaybackInfo & { type: 'usenet' },
    filename: string,
    cacheAndPlay: boolean,
    autoRemoveDownloads?: boolean,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    const { nzb, metadata, hash } = playbackInfo;
    const cacheKey = buildResolveKey(
      'tb:cache',
      this.serviceName,
      playbackInfo,
      filename,
      this.config.token,
      this.config.clientIp
    );
    const cachedLink =
      await TorboxDebridService.playbackLinkCache.get(cacheKey);

    if (cachedLink !== undefined) {
      logger.debug(`Using cached link for ${nzb ? makeUrlLogSafe(nzb) : hash}`);
      if (cachedLink === null) {
        if (!cacheAndPlay) {
          return undefined;
        }
      } else {
        return cachedLink;
      }
    }

    if (nzb) {
      await DebridFailureCache.check(
        this.serviceName,
        'usenet',
        hashNzbUrl(nzb, false)
      );
    }

    let usenetDownload: DebridDownload;

    if (!nzb) {
      // Library item — no NZB URL, look up existing download
      if (playbackInfo.serviceItemId) {
        // Direct ID lookup from catalog
        logger.debug(`Resolving library usenet item by serviceItemId`, {
          serviceItemId: playbackInfo.serviceItemId,
        });
        const fullItems = await this._fetchNzbList(playbackInfo.serviceItemId);
        usenetDownload = fullItems[0];
      } else {
        // Fallback: hash-based lookup
        logger.debug(`Resolving library usenet item by hash`, { hash });
        const libraryItems = await this.listNzbs();
        const existingItem = libraryItems.find((item) => item.hash === hash);
        if (!existingItem) {
          throw new DebridError(
            'Could not find usenet download in library by hash',
            {
              statusCode: 404,
              statusText: 'Not found',
              code: 'NOT_FOUND',
              headers: {},
              body: { hash },
              type: 'api_error',
            }
          );
        }
        const fullItems = await this._fetchNzbList(existingItem.id.toString());
        usenetDownload = fullItems[0];
      }

      logger.debug(`Found library usenet item`, {
        id: usenetDownload.id,
        status: usenetDownload.status,
        name: usenetDownload.name,
      });
    } else {
      logger.debug(`Adding usenet download for ${makeUrlLogSafe(nzb)}`, {
        hash,
      });

      usenetDownload = await this.addNzbFile(nzb, filename, !cacheAndPlay);

      logger.debug(`Usenet download added for ${makeUrlLogSafe(nzb)}`, {
        status: usenetDownload.status,
        id: usenetDownload.id,
      });

      // If this attempt loses a parallel failover race, drop the usenet
      // download we just added (library lookups above are left intact).
      removeDownloadOnAbort(
        signal,
        { id: usenetDownload.id },
        (id) => this.removeNzb(id),
        (m) => logger.warn(m)
      );
    }

    if (usenetDownload.status !== 'downloaded') {
      // temporarily cache the null value for 1m
      TorboxDebridService.playbackLinkCache.set(cacheKey, null, 60);
      if (!cacheAndPlay) {
        return undefined;
      }
      // poll status when cacheAndPlay is true
      const maxPolls = Math.ceil(this.maxWaitTime / this.pollInterval);
      for (let i = 0; i < maxPolls; i++) {
        if (signal?.aborted) {
          throw new DebridError('resolve aborted (failover lost)', {
            statusCode: 499,
            statusText: 'Client Closed Request',
            code: 'UNKNOWN',
            headers: {},
            body: null,
            type: 'api_error',
          });
        }
        await new Promise((resolve) => setTimeout(resolve, this.pollInterval));
        const usenetList = await this._fetchNzbList(
          usenetDownload.id.toString()
        );
        const usenetDownloadInList = usenetList.find(
          (usenet) => usenet.hash === hash || usenet.id === usenetDownload.id
        );
        if (!usenetDownloadInList) {
          logger.warn(
            `Failed to find ${nzb ? makeUrlLogSafe(nzb) : hash} in list`
          );
        } else {
          logger.debug(
            `Polled status for ${nzb ? makeUrlLogSafe(nzb) : hash}`,
            {
              attempt: i + 1,
              status: usenetDownloadInList.status,
            }
          );
          if (usenetDownloadInList.status === 'downloaded') {
            usenetDownload = usenetDownloadInList;
            break;
          }
          if (
            ['failed', 'invalid'].includes(usenetDownloadInList.status ?? '')
          ) {
            const err = new DebridError(
              `Usenet download ${usenetDownloadInList.status}`,
              {
                statusCode: 400,
                statusText: `Usenet download ${usenetDownloadInList.status}`,
                code: 'DOWNLOAD_FAILED',
                headers: {},
                body: usenetDownloadInList,
                type: 'api_error',
              }
            );
            if (nzb)
              DebridFailureCache.mark(
                this.serviceName,
                'usenet',
                hashNzbUrl(nzb, false),
                err
              ).catch(() => {});
            throw err;
          }
        }
      }
      if (usenetDownload.status !== 'downloaded') {
        throw new DebridError(
          `Usenet download timed out waiting for completion (status: ${usenetDownload.status})`,
          {
            statusCode: 408,
            statusText: 'Timeout',
            code: 'TIMEOUT',
            headers: {},
            body: usenetDownload,
            type: 'api_error',
          }
        );
      }
    }

    if (!usenetDownload.files?.length) {
      throw new DebridError('No files found for usenet download', {
        statusCode: 400,
        statusText: 'No files found for usenet download',
        code: 'NO_MATCHING_FILE',
        headers: {},
        body: usenetDownload,
        type: 'api_error',
      });
    }

    let fileId: number | undefined;
    if (playbackInfo.fileIndex !== undefined) {
      // Direct file index specified (e.g. from catalog meta)
      fileId = playbackInfo.fileIndex;
      logger.debug(`Using specified fileIndex`, { fileId });
    } else if (usenetDownload.files.length > 1) {
      const nzbInfo = {
        type: 'usenet' as const,
        nzb: nzb,
        hash: hash,
        title: usenetDownload.name,
        file: usenetDownload.files[playbackInfo.index ?? 0],
        metadata: metadata,
        size: usenetDownload.size || 0,
      };
      const allStrings: string[] = [];
      allStrings.push(usenetDownload.name ?? '');
      allStrings.push(...usenetDownload.files.map((file) => file.name ?? ''));

      const parseResults: ParsedResult[] = allStrings.map((string) =>
        parseTorrentTitleCached(string)
      );
      const parsedFiles = new Map<string, ParsedResult>();
      for (const [index, result] of parseResults.entries()) {
        parsedFiles.set(allStrings[index], result);
      }

      const file = await selectFileInTorrentOrNZB(
        nzbInfo,
        usenetDownload,
        parsedFiles,
        metadata,
        {
          chosenFilename: playbackInfo.filename,
          chosenIndex: playbackInfo.index,
        }
      );

      if (!file) {
        throw new DebridError('No matching file found', {
          statusCode: 400,
          statusText: 'No matching file found',
          code: 'NO_MATCHING_FILE',
          headers: {},
          body: file,
          type: 'api_error',
        });
      }

      logger.debug(`Found matching file`, {
        chosenFile: file.name,
        chosenIndex: file.id,
        availableFiles: `[${usenetDownload.files.map((file) => file.name).join(', ')}]`,
      });

      fileId = file.id;
    }

    fileId ??=
      usenetDownload.files[0]?.id ?? usenetDownload.files[0]?.index ?? 0;
    const playback = await this.resolveTorboxPlayback(
      'usenet',
      usenetDownload.id.toString(),
      fileId,
      playbackInfo.torbox
    );
    const playbackLink = playback.url;
    logger.debug('Resolved unified TorBox Usenet playback', {
      mode: playback.mode,
      target: playback.target,
      fallbackReason: playback.fallbackReason,
    });
    if (playback.mode === 'native') {
      await TorboxDebridService.playbackLinkCache.set(
        cacheKey,
        playbackLink,
        appConfig.builtins.debrid.instantAvailabilityCacheTtl,
        true
      );
    }

    if (
      playback.mode === 'stream' &&
      autoRemoveDownloads &&
      usenetDownload.id &&
      nzb
    ) {
      this.removeNzb(usenetDownload.id.toString()).catch((err) => {
        logger.warn(
          `Failed to cleanup usenet download ${usenetDownload.id} after resolve: ${err.message}`
        );
      });
    }

    return playbackLink;
  }
}
