import {
  DebridServiceConfig,
  UsenetDebridService,
  DebridDownload,
  DebridError,
  PlaybackInfo,
  TorrentDebridService,
  convertStatusCodeToError,
} from './base.js';
import { constants, createLogger } from '../utils/index.js';
import {
  DeepbridApiError,
  DeepbridAddResult,
  DeepbridOfficialClient,
  DeepbridUpload,
  DeepbridUploadInfo,
  DeepbridTorrent,
  isDeepbridVideoName,
  isLikelyDeepbridVideoName,
} from '../builtins/deepbrid-usenet/client.js';
import { createHash } from 'node:crypto';

const logger = createLogger('debrid:deepbrid');

const uploadCache = new Map<string, { id: string; expiresAt: number }>();
const UPLOAD_CACHE_TTL_MS = 10 * 60_000;
const UPLOAD_LIST_TTL_MS = 30_000;
const uploadListCache = new Map<
  string,
  { value: DeepbridUpload[]; expiresAt: number }
>();
const uploadListInFlight = new Map<string, Promise<DeepbridUpload[]>>();
const uploadInfoCache = new Map<
  string,
  { value: DeepbridUploadInfo; expiresAt: number }
>();
const MIN_DEEPBRID_PLAYABLE_BYTES = 16 * 1024 * 1024;
const UPLOAD_INFO_CACHE_TTL_MS = 10 * 60_000;
const DEFAULT_DEEPBRID_PRECACHE_LIMIT = 24;
const DEEPBRID_PRECACHE_ATTEMPTS = 8;
const DEEPBRID_PRECACHE_INTERVAL_MS = 1_000;
const DEEPBRID_PRECACHE_TOTAL_BUDGET_MS = 10_000;
const DEEPBRID_UPLOAD_LOOKUP_BUDGET_MS = 2_500;
const DEEPBRID_PRECACHE_CONCURRENCY = 3;

export interface DeepbridResolvedFile {
  name: string;
  link: string;
  size?: number;
}

export interface DeepbridOfficialApi {
  getUser(options?: { signal?: AbortSignal }): Promise<unknown>;
  listUploads(options?: { signal?: AbortSignal }): Promise<DeepbridUpload[]>;
  addNzbUrl(
    nzbUrl: string,
    options?: { signal?: AbortSignal }
  ): Promise<DeepbridAddResult>;
  getUploadInfo(
    id: string,
    options?: { signal?: AbortSignal }
  ): Promise<DeepbridUploadInfo>;
  listTorrents?(options?: { signal?: AbortSignal }): Promise<DeepbridTorrent[]>;
  getTorrentInfo?(
    id: string,
    options?: { signal?: AbortSignal }
  ): Promise<DeepbridTorrent | undefined>;
}

type DeepbridUsenetPlaybackInfo = Extract<PlaybackInfo, { type: 'usenet' }>;

function normalizedFilename(value: string): string {
  return value
    .split(/[\\/]/)
    .pop()!
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function normalizedRelease(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.(?:nzb|mkv|mp4|avi|mov|webm|m2ts?|wmv)$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function fileEpisode(name: string): { season: number; episode: number } | null {
  const standard = name.match(/(?:^|\D)s(\d{1,3})[ ._-]*e(\d{1,4})(?:\D|$)/i);
  if (standard)
    return { season: Number(standard[1]), episode: Number(standard[2]) };
  const compact = name.match(/(?:^|\D)(\d{1,3})x(\d{1,4})(?:\D|$)/i);
  return compact
    ? { season: Number(compact[1]), episode: Number(compact[2]) }
    : null;
}

/** Select only a playable file and, for series, the requested pack member. */
export function selectDeepbridUploadFile(
  files: DeepbridResolvedFile[],
  requestedFilename: string,
  metadata?: { season?: number; episode?: number }
): DeepbridResolvedFile | undefined {
  const requested = normalizedFilename(requestedFilename);
  const videos = files.filter((file) => isDeepbridVideoName(file.name));
  const exact =
    files.find((file) => file.name === requestedFilename) ??
    videos.find((file) => normalizedFilename(file.name) === requested);
  if (exact) return exact;

  if (metadata?.season !== undefined && metadata.episode !== undefined) {
    const matchingEpisode = videos.filter((file) => {
      const parsed = fileEpisode(file.name);
      return (
        parsed !== null &&
        parsed.season === metadata.season &&
        parsed.episode === metadata.episode
      );
    });
    if (matchingEpisode.length) {
      return matchingEpisode.sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0];
    }
    if (videos.some((file) => fileEpisode(file.name))) return undefined;
  }

  return videos.sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0];
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise((resolve, reject) => {
    const onComplete = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(onComplete, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function toDebridError(message: string, error: unknown): DebridError {
  const status =
    error instanceof DeepbridApiError ? (error.status ?? 502) : 502;
  return new DebridError(
    `${message}: ${error instanceof Error ? error.message : String(error)}`,
    {
      statusCode: status,
      statusText: status === 429 ? 'Too Many Requests' : 'Bad Gateway',
      code: convertStatusCodeToError(status),
      headers:
        error instanceof DeepbridApiError && error.retryAfterMs !== undefined
          ? { 'retry-after': String(Math.ceil(error.retryAfterMs / 1000)) }
          : {},
      body: null,
      type: 'api_error',
      cause: error,
    }
  );
}

export class DeepbridService implements UsenetDebridService, TorrentDebridService {
  readonly serviceName = constants.DEEPBRID_SERVICE;
  readonly capabilities = { torrents: true, usenet: true } as const;
  private readonly credentialKey: string;
  private readonly preCache: boolean;
  private readonly preCacheLimit: number;

  constructor(
    config: DebridServiceConfig,
    private client: DeepbridOfficialApi = new DeepbridOfficialClient(
      config.token,
      30_000
    )
  ) {
    this.credentialKey = createHash('sha256')
      .update(config.token)
      .digest('hex')
      .slice(0, 24);
    this.preCache = config.preCache === true;
    this.preCacheLimit = Math.min(
      100,
      Math.max(1, config.preCacheLimit ?? DEFAULT_DEEPBRID_PRECACHE_LIMIT)
    );
  }

  async validateAccount(): Promise<void> {
    await this.client.getUser();
  }

  /**
   * Deepbrid torrent support is intentionally library-only. Matching is done
   * against /torrents/info; no magnet is submitted and no torrent scraper is
   * called from this service.
   */
  async listMagnets(): Promise<DebridDownload[]> {
    const torrents = this.client.listTorrents
      ? await this.client.listTorrents()
      : [];
    return torrents.flatMap((torrent) => {
      const files = torrent.files.filter((file) =>
        isLikelyDeepbridVideoName(file.name)
      );
      const ready = /^(completed|complete|finished|downloaded|cached|seeding)$/i.test(
        torrent.status.trim()
      ) || (torrent.progress ?? 0) >= 100;
      if (!ready || files.length === 0) return [];
      return [{
        id: torrent.id,
        hash: torrent.hash,
        name: torrent.title,
        size: torrent.size,
        status: 'cached' as const,
        library: true,
        files: torrent.files.map((file, index) => ({ ...file, index })),
      }];
    });
  }

  /**
   * Resolve one catalog item back to the authenticated Deepbrid account.
   * Library metadata requests use this method before creating a playback
   * stream; never synthesize an item from the catalog id alone.
   */
  async getMagnet(magnetId: string): Promise<DebridDownload> {
    const torrent = this.client.getTorrentInfo
      ? await this.client.getTorrentInfo(magnetId)
      : (await this.client.listTorrents?.())?.find(
          (item) => item.id === magnetId
        );
    if (!torrent) {
      throw new DebridError('Deepbrid torrent is not in the account library', {
        statusCode: 404,
        statusText: 'Not Found',
        code: 'NOT_FOUND',
        headers: {},
        body: null,
        type: 'api_error',
      });
    }

    const files = torrent.files.filter((file) =>
      isLikelyDeepbridVideoName(file.name)
    );
    const ready =
      /^(completed|complete|finished|downloaded|cached|seeding)$/i.test(
        torrent.status.trim()
      ) || (torrent.progress ?? 0) >= 100;
    if (!ready || files.length === 0) {
      throw new DebridError('Deepbrid torrent is not ready for playback', {
        statusCode: 409,
        statusText: 'Conflict',
        code: 'NO_MATCHING_FILE',
        headers: {},
        body: null,
        type: 'api_error',
      });
    }

    return {
      id: torrent.id,
      hash: torrent.hash,
      name: torrent.title,
      size: torrent.size,
      status: 'cached',
      library: true,
      files: torrent.files.map((file, index) => ({ ...file, index })),
    };
  }

  async checkMagnets(
    magnets: string[],
    _sid?: string,
    _checkOwned = true
  ): Promise<DebridDownload[]> {
    const library = await this.listMagnets();
    const byHash = new Map(
      library
        .filter((item) => item.hash)
        .map((item) => [item.hash!.toLowerCase(), item])
    );
    return magnets.flatMap((hash) => {
      const item = byHash.get(hash.toLowerCase());
      return item ? [{ ...item, hash }] : [];
    });
  }

  async addMagnet(_magnet: string): Promise<DebridDownload> {
    throw new DebridError('Deepbrid torrent library is read-only', {
      statusCode: 400, statusText: 'Bad Request', code: 'BAD_REQUEST',
      headers: {}, body: null, type: 'api_error',
    });
  }

  async addTorrent(_torrent: string): Promise<DebridDownload> {
    return this.addMagnet(_torrent);
  }

  async removeMagnet(_magnetId: string): Promise<void> {
    throw new DebridError('Deepbrid torrent library is read-only', {
      statusCode: 400, statusText: 'Bad Request', code: 'BAD_REQUEST',
      headers: {}, body: null, type: 'api_error',
    });
  }

  async generateTorrentLink(link: string): Promise<string> {
    return link;
  }

  private async getUploads(force = false): Promise<DeepbridUpload[]> {
    const cached = uploadListCache.get(this.credentialKey);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.value;
    const pending = uploadListInFlight.get(this.credentialKey);
    if (!force && pending) return pending;

    const request = this.client.listUploads().then((value) => {
      uploadListCache.set(this.credentialKey, {
        value,
        expiresAt: Date.now() + UPLOAD_LIST_TTL_MS,
      });
      if (uploadListCache.size > 1_000) {
        const oldest = uploadListCache.keys().next().value as
          | string
          | undefined;
        if (oldest) uploadListCache.delete(oldest);
      }
      return value;
    });
    uploadListInFlight.set(this.credentialKey, request);
    try {
      return await request;
    } finally {
      uploadListInFlight.delete(this.credentialKey);
    }
  }

  private async getUploadInfo(
    id: string,
    signal?: AbortSignal
  ): Promise<DeepbridUploadInfo> {
    const key = `${this.credentialKey}:${id}`;
    const cached = uploadInfoCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await this.client.getUploadInfo(id, { signal });
    uploadInfoCache.set(key, {
      value,
      expiresAt: Date.now() + UPLOAD_INFO_CACHE_TTL_MS,
    });
    if (uploadInfoCache.size > 4_096) {
      const now = Date.now();
      for (const [candidateKey, entry] of uploadInfoCache) {
        if (entry.expiresAt <= now) uploadInfoCache.delete(candidateKey);
      }
    }
    return value;
  }

  private verifiedUploadResult(
    nzb: { name?: string; hash?: string },
    upload: DeepbridUpload,
    info: DeepbridUploadInfo
  ): DebridDownload | undefined {
    const playable = info.files.filter(
      (file) =>
        isDeepbridVideoName(file.name) &&
        (!file.size || file.size >= MIN_DEEPBRID_PLAYABLE_BYTES)
    );
    if (playable.length === 0) return undefined;
    return {
      id: upload.id,
      name: nzb.name ?? info.title ?? upload.title,
      hash: nzb.hash ?? upload.hash,
      addedAt: upload.addedAt,
      status: 'cached',
      library: true,
      size: playable.reduce((sum, file) => sum + (file.size || 0), 0),
      files: info.files.map((file, index) => ({
        index,
        name: file.name,
        size: file.size || 0,
        link: file.link,
      })),
    };
  }

  async checkNzbs(
    nzbs: { name?: string; hash?: string; nzb?: string }[]
  ): Promise<DebridDownload[]> {
    const preCacheDeadline = Date.now() + DEEPBRID_PRECACHE_TOTAL_BUDGET_MS;
    let uploads: DeepbridUpload[] = [];
    try {
      // Account discovery improves cached reuse but is not allowed to hold an
      // external-indexer scrape open. The in-flight request continues filling
      // the shared cache if this caller moves on after the short lookup budget.
      uploads = await Promise.race([
        this.getUploads(),
        abortableDelay(DEEPBRID_UPLOAD_LOOKUP_BUDGET_MS).then(() => []),
      ]);
    } catch (error) {
      // Cache discovery is optional; a transient failure must not hide sources.
      if (
        error instanceof DeepbridApiError &&
        [401, 403].includes(error.status ?? 0)
      ) {
        throw toDebridError('Deepbrid account validation failed', error);
      }
    }

    // Build once per check. Large established accounts can contain thousands
    // of uploads, so repeatedly normalizing and linearly scanning for every
    // external indexer result is needlessly expensive.
    const bySourceUrl = new Map<string, DeepbridUpload>();
    const byHash = new Map<string, DeepbridUpload>();
    const byTitle = new Map<string, DeepbridUpload>();
    for (const upload of uploads) {
      if (upload.sourceUrl) bySourceUrl.set(upload.sourceUrl, upload);
      if (upload.hash) byHash.set(upload.hash, upload);
      const title = normalizedRelease(upload.title);
      if (title.length > 3 && !byTitle.has(title)) byTitle.set(title, upload);
    }

    const findOwned = (nzb: { name?: string; hash?: string; nzb?: string }) => {
      const normalizedName = normalizedRelease(nzb.name ?? '');
      return (
        (nzb.nzb ? bySourceUrl.get(nzb.nzb) : undefined) ??
        (nzb.hash ? byHash.get(nzb.hash) : undefined) ??
        (normalizedName.length > 3 ? byTitle.get(normalizedName) : undefined)
      );
    };

    const resultForOwned = (
      nzb: { name?: string; hash?: string; nzb?: string },
      owned?: DeepbridUpload
    ): DebridDownload => ({
      id: owned?.id ?? nzb.hash ?? nzb.name ?? 'unknown',
      name: nzb.name ?? owned?.title,
      hash: nzb.hash,
      addedAt: owned?.addedAt,
      status: owned ? 'cached' : 'queued',
      library: Boolean(owned),
    });

    if (!this.preCache) {
      return nzbs.map((nzb) => resultForOwned(nzb, findOwned(nzb)));
    }

    // Pre-cache mode is deliberately opt-in. Only verified, playable uploads
    // are emitted, and the bounded queue prevents a broad indexer scrape from
    // filling the account with hundreds of unplayed NZBs.
    const ownedCandidates = nzbs
      .map((nzb) => ({ nzb, owned: findOwned(nzb) }))
      .filter(
        (item): item is { nzb: (typeof nzbs)[number]; owned: DeepbridUpload } =>
          Boolean(item.owned)
      );
    const candidates = nzbs
      .filter((nzb) => Boolean(nzb.nzb) && !findOwned(nzb))
      .slice(0, this.preCacheLimit);
    const verified: DebridDownload[] = [];
    const work = [
      ...ownedCandidates.map((item) => ({ type: 'owned' as const, ...item })),
      ...candidates.map((nzb) => ({ type: 'new' as const, nzb })),
    ];
    let nextWork = 0;
    const workers = Array.from(
      {
        length: Math.min(DEEPBRID_PRECACHE_CONCURRENCY, work.length),
      },
      async () => {
        while (Date.now() < preCacheDeadline) {
          const item = work[nextWork++];
          if (!item) return;
          const remainingMs = preCacheDeadline - Date.now();
          if (remainingMs <= 0) return;
          const signal = AbortSignal.timeout(remainingMs);
          try {
            const result =
              item.type === 'owned'
                ? this.verifiedUploadResult(
                    item.nzb,
                    item.owned,
                    await this.getUploadInfo(item.owned.id, signal)
                  )
                : await this.preCacheExternalNzb(item.nzb, signal);
            if (result) verified.push(result);
          } catch (error) {
            logger.debug(
              {
                id: item.type === 'owned' ? item.owned.id : undefined,
                error: error instanceof Error ? error.message : String(error),
              },
              'Deepbrid cached upload verification failed'
            );
          }
        }
      }
    );
    await Promise.allSettled(workers);
    // In pre-cache mode a DB lightning-bolt entry is a playback guarantee, not
    // a promise to try uploading after the click. Keep failed/rate-limited
    // candidates available through their native AIO and TorBox siblings, but
    // do not advertise an unverified Deepbrid playback URL.
    return verified;
  }

  private async preCacheExternalNzb(
    nzb: {
      name?: string;
      hash?: string;
      nzb?: string;
    },
    signal?: AbortSignal
  ): Promise<DebridDownload | undefined> {
    if (!nzb.nzb) return undefined;
    try {
      const added = await this.client.addNzbUrl(nzb.nzb, { signal });
      if (!added.id) return undefined;

      for (let attempt = 0; attempt < DEEPBRID_PRECACHE_ATTEMPTS; attempt++) {
        if (signal?.aborted) return undefined;
        const info = await this.getUploadInfo(added.id, signal);
        const playable = info.files.filter(
          (file) =>
            isDeepbridVideoName(file.name) &&
            (!file.size || file.size >= MIN_DEEPBRID_PLAYABLE_BYTES)
        );
        if (playable.length > 0) {
          return {
            id: added.id,
            name: nzb.name ?? info.title ?? added.title,
            hash: nzb.hash,
            status: 'cached',
            library: true,
            size: playable.reduce((sum, file) => sum + (file.size || 0), 0),
            files: info.files.map((file, index) => ({
              index,
              name: file.name,
              size: file.size || 0,
              link: file.link,
            })),
          };
        }
        if (attempt < DEEPBRID_PRECACHE_ATTEMPTS - 1) {
          await abortableDelay(DEEPBRID_PRECACHE_INTERVAL_MS, signal);
        }
      }
    } catch (error) {
      logger.debug(
        { error: error instanceof Error ? error.message : String(error) },
        'Deepbrid external NZB pre-cache failed'
      );
    }
    return undefined;
  }

  async listNzbs(id?: string): Promise<DebridDownload[]> {
    const uploads = await this.getUploads();
    const selected = id
      ? uploads.filter((upload) => upload.id === id)
      : uploads;
    return Promise.all(
      selected.map(async (upload) => {
        if (!id) {
          return {
            id: upload.id,
            name: upload.title,
            hash: upload.hash,
            addedAt: upload.addedAt,
            status: 'downloaded' as const,
            library: true,
          };
        }
        const info = await this.client.getUploadInfo(upload.id);
        return {
          id: upload.id,
          name: info.title || upload.title,
          hash: upload.hash,
          addedAt: upload.addedAt,
          status: info.files.length
            ? ('downloaded' as const)
            : ('processing' as const),
          library: true,
          size: info.files.reduce((sum, file) => sum + (file.size || 0), 0),
          files: info.files.map((file, index) => ({
            index,
            name: file.name,
            size: file.size,
            link: file.link,
          })),
        };
      })
    );
  }

  private selectResolvedFile(
    info: DeepbridUploadInfo | DeepbridAddResult,
    playbackInfo: DeepbridUsenetPlaybackInfo,
    filename: string
  ): string | undefined {
    if (!info.files.length) return undefined;
    const plausibleFiles = info.files.filter(
      (file) => !file.size || file.size >= MIN_DEEPBRID_PLAYABLE_BYTES
    );
    if (!plausibleFiles.length) {
      throw new DebridError(
        'Deepbrid resolved the NZB to a generated error file instead of media',
        {
          statusCode: 502,
          statusText: 'Bad Gateway',
          code: 'BAD_GATEWAY',
          headers: {},
          body: null,
          type: 'api_error',
        }
      );
    }
    const target = selectDeepbridUploadFile(
      plausibleFiles,
      filename,
      playbackInfo.metadata
    );
    if (!target && playbackInfo.metadata?.episode !== undefined) {
      throw new DebridError(
        'Deepbrid resolved the NZB but did not contain the requested episode file',
        {
          statusCode: 404,
          statusText: 'Not Found',
          code: 'NO_MATCHING_FILE',
          headers: {},
          body: null,
          type: 'api_error',
        }
      );
    }
    return target?.link;
  }

  private async recoverUploadId(
    playbackInfo: DeepbridUsenetPlaybackInfo,
    filename: string,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal?.aborted) return undefined;
      try {
        const uploads = await this.getUploads(true);
        const normalizedName = normalizedRelease(filename);
        const upload =
          (playbackInfo.nzb
            ? uploads.find((item) => item.sourceUrl === playbackInfo.nzb)
            : undefined) ??
          (playbackInfo.hash
            ? uploads.find((item) => item.hash === playbackInfo.hash)
            : undefined) ??
          uploads.find(
            (item) =>
              normalizedName.length > 3 &&
              normalizedRelease(item.title) === normalizedName
          );
        if (upload) return upload.id;
      } catch (error) {
        if (
          error instanceof DeepbridApiError &&
          [401, 403, 429].includes(error.status ?? 0)
        ) {
          throw error;
        }
      }
      if (attempt < 2) await abortableDelay(250 * (attempt + 1), signal);
    }
    return undefined;
  }

  async resolve(
    playbackInfo: PlaybackInfo,
    filename: string,
    _cacheAndPlay: boolean,
    _autoRemoveDownloads?: boolean,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    if (playbackInfo.type === 'torrent') {
      const torrents = playbackInfo.serviceItemId
        ? [
            await this.client.getTorrentInfo?.(playbackInfo.serviceItemId, {
              signal,
            }),
          ]
        : this.client.listTorrents
          ? await this.client.listTorrents({ signal })
          : [];
      const torrent = torrents.find(
        (item) =>
          item?.id === playbackInfo.serviceItemId ||
          item?.hash?.toLowerCase() === playbackInfo.hash.toLowerCase()
      );
      if (!torrent) return undefined;
      const requested = playbackInfo.fileIndex ?? playbackInfo.index;
      // A catalog stream carries the provider's array index. If that index is
      // present, honor it strictly: falling through to the first video would
      // make multi-file torrents (season packs, music demos, extras) play the
      // wrong member while appearing to resolve successfully.
      const file =
        requested !== undefined
          ? torrent.files[requested]
          : torrent.files.find((item) => item.name === filename) ??
            torrent.files.find((item) => isLikelyDeepbridVideoName(item.name));
      return file?.link;
    }
    if (playbackInfo.type !== 'usenet') {
      throw new DebridError('Deepbrid service cannot resolve torrents', {
        statusCode: 400,
        statusText: 'Bad Request',
        code: 'BAD_REQUEST',
        headers: {},
        body: null,
        type: 'api_error',
      });
    }
    if (!playbackInfo.nzb && !playbackInfo.serviceItemId) {
      throw new DebridError('Deepbrid requires an NZB URL or upload id', {
        statusCode: 400,
        statusText: 'Bad Request',
        code: 'NO_MATCHING_FILE',
        headers: {},
        body: null,
        type: 'api_error',
      });
    }

    const cacheKey = createHash('sha256')
      .update(playbackInfo.nzb || `upload:${playbackInfo.serviceItemId}`)
      .digest('hex');
    const cached = uploadCache.get(cacheKey);
    let uploadId =
      playbackInfo.serviceItemId ||
      (cached && cached.expiresAt > Date.now() ? cached.id : undefined);
    let added: DeepbridAddResult | undefined;
    try {
      if (!uploadId && playbackInfo.nzb) {
        added = await this.client.addNzbUrl(playbackInfo.nzb, { signal });
        const directLink = this.selectResolvedFile(
          added,
          playbackInfo,
          filename
        );
        if (directLink) return directLink;
        uploadId = added.id;
        if (uploadId) {
          uploadCache.set(cacheKey, {
            id: uploadId,
            expiresAt: Date.now() + UPLOAD_CACHE_TTL_MS,
          });
        }
        uploadListCache.delete(this.credentialKey);
      }
    } catch (error) {
      if (error instanceof DebridError) throw error;
      throw toDebridError('Deepbrid failed to add NZB', error);
    }
    if (!uploadId && playbackInfo.nzb) {
      try {
        uploadId = await this.recoverUploadId(playbackInfo, filename, signal);
        if (uploadId) {
          uploadCache.set(cacheKey, {
            id: uploadId,
            expiresAt: Date.now() + UPLOAD_CACHE_TTL_MS,
          });
        }
      } catch (error) {
        throw toDebridError('Deepbrid could not locate the NZB upload', error);
      }
    }
    if (!uploadId) return undefined;

    let lastError: unknown;
    for (let attempt = 0; attempt < 7; attempt++) {
      if (signal?.aborted) return undefined;
      try {
        const info = await this.client.getUploadInfo(uploadId, { signal });
        const link = this.selectResolvedFile(info, playbackInfo, filename);
        if (link) return link;
      } catch (error) {
        if (error instanceof DebridError) throw error;
        lastError = error;
        if (
          playbackInfo.nzb &&
          error instanceof DeepbridApiError &&
          /missing\s+id/i.test(error.message)
        ) {
          const recoveredId = await this.recoverUploadId(
            playbackInfo,
            filename,
            signal
          );
          if (recoveredId && recoveredId !== uploadId) {
            uploadId = recoveredId;
            uploadCache.set(cacheKey, {
              id: uploadId,
              expiresAt: Date.now() + UPLOAD_CACHE_TTL_MS,
            });
            continue;
          }
        }
        if (
          error instanceof DeepbridApiError &&
          [401, 403, 404, 429].includes(error.status ?? 0)
        ) {
          if (error.status === 404) uploadCache.delete(cacheKey);
          throw toDebridError('Deepbrid could not read the NZB upload', error);
        }
      }
      if (attempt < 6)
        await abortableDelay(Math.min(2_500, 200 * 2 ** attempt), signal);
    }

    if (lastError)
      throw toDebridError(
        'Deepbrid timed out waiting for NZB resolution',
        lastError
      );
    throw new DebridError('Deepbrid timed out waiting for NZB resolution', {
      statusCode: 504,
      statusText: 'Gateway Timeout',
      code: 'TIMEOUT',
      headers: {},
      body: null,
      type: 'api_error',
    });
  }
}
