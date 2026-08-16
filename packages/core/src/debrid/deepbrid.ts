import {
  DebridServiceConfig,
  UsenetDebridService,
  DebridDownload,
  DebridError,
  PlaybackInfo,
} from './base.js';
import { constants } from '../utils/index.js';
import {
  DeepbridFinderClient,
  isDeepbridVideoName,
} from '../builtins/deepbrid-usenet/client.js';

const uploadCache = new Map<string, { id: string; expiresAt: number }>();
const UPLOAD_CACHE_TTL_MS = 10 * 60_000;

export interface DeepbridResolvedFile {
  name: string;
  link: string;
  size?: number;
}

function normalizedFilename(value: string): string {
  return value
    .split(/[\\/]/)
    .pop()!
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** Select a playable file from an upload without ever falling back to an archive/NFO. */
export function selectDeepbridUploadFile(
  files: DeepbridResolvedFile[],
  requestedFilename: string
): DeepbridResolvedFile | undefined {
  const requested = normalizedFilename(requestedFilename);
  const videos = files.filter((file) => isDeepbridVideoName(file.name));
  return (
    files.find((file) => file.name === requestedFilename) ??
    videos.find((file) => normalizedFilename(file.name) === requested) ??
    videos.slice().sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0]
  );
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class DeepbridService implements UsenetDebridService {
  readonly serviceName = constants.DEEPBRID_SERVICE;
  readonly capabilities = { torrents: false, usenet: true } as const;

  private client: DeepbridFinderClient;

  constructor(private config: DebridServiceConfig) {
    this.client = new DeepbridFinderClient(config.token, 30_000);
  }

  async checkNzbs(nzbs: { name?: string; hash?: string }[]): Promise<DebridDownload[]> {
    // Deepbrid does not currently expose a way to check if an external NZB is
    // cached without submitting it, and we do not want to submit all search
    // results blindly. We return them as 'queued' so `processNZBs` retains them
    // and calls `resolve()` when the user attempts playback.
    return nzbs.map((nzb) => ({
      id: nzb.hash ?? nzb.name ?? 'unknown',
      name: nzb.name,
      hash: nzb.hash,
      status: 'queued',
    }));
  }

  async listNzbs(id?: string): Promise<DebridDownload[]> {
    // If Deepbrid exposes an uploads endpoint, we could list them here.
    // For now, we return empty so it doesn't break library sync.
    return [];
  }

  async resolve(
    playbackInfo: PlaybackInfo,
    filename: string,
    cacheAndPlay: boolean,
    autoRemoveDownloads?: boolean,
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

    if (!playbackInfo.nzb) {
      throw new DebridError('Deepbrid service requires an NZB URL to resolve external indexers', {
        statusCode: 400,
        statusText: 'Bad Request',
        code: 'NO_MATCHING_FILE',
        headers: {},
        body: null,
        type: 'api_error',
      });
    }

    // 1. Submit the NZB URL to Deepbrid's /api/v1/usenet/add
    const cacheKey = playbackInfo.nzb;
    const cached = uploadCache.get(cacheKey);
    let uploadId: string | undefined =
      cached && cached.expiresAt > Date.now() ? cached.id : undefined;
    try {
      if (!uploadId) {
        uploadId = await this.client.addNzbUrl(playbackInfo.nzb, { signal });
        uploadCache.set(cacheKey, {
          id: uploadId,
          expiresAt: Date.now() + UPLOAD_CACHE_TTL_MS,
        });
      }
    } catch (error) {
      throw new DebridError(`Deepbrid failed to add NZB: ${error instanceof Error ? error.message : String(error)}`, {
        statusCode: 502,
        statusText: 'Bad Gateway',
        code: 'BAD_GATEWAY',
        headers: {},
        body: null,
        type: 'api_error',
        cause: error,
      });
    }

    // 2. Poll until files are available. The short backoff avoids adding an
    // artificial delay while still allowing Deepbrid's async upload worker to
    // publish the resolved files.
    for (let attempt = 0; attempt < 5; attempt++) {
      if (signal?.aborted) return undefined;
      try {
        const info = await this.client.getUploadInfo(uploadId, { signal });
        if (info.files && info.files.length > 0) {
          // Prefer an exact filename, then a normalized filename, then the
          // largest video. Never select an archive or text/NFO file merely
          // because it appeared first in the API response.
          const targetFile = selectDeepbridUploadFile(info.files, filename);
          if (targetFile?.link) return targetFile.link;
        }
      } catch (e) {
        // Ignore temporary poll failures
      }
      if (attempt < 4) {
        await abortableDelay(Math.min(1500, 250 * 2 ** attempt), signal);
      }
    }

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
