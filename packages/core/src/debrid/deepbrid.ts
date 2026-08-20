import {
  DebridServiceConfig,
  UsenetDebridService,
  DebridDownload,
  DebridError,
  PlaybackInfo,
  convertStatusCodeToError,
} from './base.js';
import { constants } from '../utils/index.js';
import {
  DeepbridApiError,
  DeepbridOfficialClient,
  DeepbridUpload,
  DeepbridUploadInfo,
  isDeepbridVideoName,
} from '../builtins/deepbrid-usenet/client.js';
import { createHash } from 'node:crypto';

const uploadCache = new Map<string, { id: string; expiresAt: number }>();
const UPLOAD_CACHE_TTL_MS = 10 * 60_000;
const UPLOAD_LIST_TTL_MS = 30_000;
const uploadListCache = new Map<
  string,
  { value: DeepbridUpload[]; expiresAt: number }
>();
const uploadListInFlight = new Map<string, Promise<DeepbridUpload[]>>();

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
  ): Promise<string>;
  getUploadInfo(
    id: string,
    options?: { signal?: AbortSignal }
  ): Promise<DeepbridUploadInfo>;
}

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
    const timer = setTimeout(resolve, ms);
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

export class DeepbridService implements UsenetDebridService {
  readonly serviceName = constants.DEEPBRID_SERVICE;
  readonly capabilities = { torrents: false, usenet: true } as const;
  private readonly credentialKey: string;

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
  }

  async validateAccount(): Promise<void> {
    await this.client.getUser();
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

  async checkNzbs(
    nzbs: { name?: string; hash?: string; nzb?: string }[]
  ): Promise<DebridDownload[]> {
    let uploads: DeepbridUpload[] = [];
    try {
      uploads = await this.getUploads();
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

    return nzbs.map((nzb) => {
      const normalizedName = normalizedRelease(nzb.name ?? '');
      const owned =
        (nzb.nzb ? bySourceUrl.get(nzb.nzb) : undefined) ??
        (nzb.hash ? byHash.get(nzb.hash) : undefined) ??
        (normalizedName.length > 3 ? byTitle.get(normalizedName) : undefined);
      return {
        id: owned?.id ?? nzb.hash ?? nzb.name ?? 'unknown',
        name: nzb.name ?? owned?.title,
        hash: nzb.hash,
        addedAt: owned?.addedAt,
        status: owned ? 'cached' : 'queued',
        library: Boolean(owned),
      };
    });
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

  async resolve(
    playbackInfo: PlaybackInfo,
    filename: string,
    _cacheAndPlay: boolean,
    _autoRemoveDownloads?: boolean,
    signal?: AbortSignal
  ): Promise<string | undefined> {
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
    try {
      if (!uploadId && playbackInfo.nzb) {
        uploadId = await this.client.addNzbUrl(playbackInfo.nzb, { signal });
        uploadCache.set(cacheKey, {
          id: uploadId,
          expiresAt: Date.now() + UPLOAD_CACHE_TTL_MS,
        });
        uploadListCache.delete(this.credentialKey);
      }
    } catch (error) {
      throw toDebridError('Deepbrid failed to add NZB', error);
    }
    if (!uploadId) return undefined;

    let lastError: unknown;
    for (let attempt = 0; attempt < 7; attempt++) {
      if (signal?.aborted) return undefined;
      try {
        const info = await this.client.getUploadInfo(uploadId, { signal });
        if (info.files.length) {
          const target = selectDeepbridUploadFile(
            info.files,
            filename,
            playbackInfo.metadata
          );
          if (target?.link) return target.link;
          if (playbackInfo.metadata?.episode !== undefined) {
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
        }
      } catch (error) {
        if (error instanceof DebridError) throw error;
        lastError = error;
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
