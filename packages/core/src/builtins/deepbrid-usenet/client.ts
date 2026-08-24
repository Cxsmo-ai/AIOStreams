import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { makeRequest } from '../../utils/index.js';

export const DEEPBRID_API_BASE = 'https://www.deepbrid.com/api/v1';
export const DEEPBRID_FINDER_USER_AGENT =
  'Deepbrid/1.0 (ios) DBX/AxkHbkTtYiXSijpzcRE5vGe73HK7qqrinpEz';
export const DEEPBRID_AIOSTREAMS_USER_AGENT = 'AIOStreams Deepbrid integration';

export interface DeepbridSigningDependencies {
  now?: () => number;
  random?: () => string;
  secret?: string;
}

export class DeepbridRequestSigner {
  private counter = 0;
  private serverOffsetMs = 0;
  private readonly now: () => number;
  private readonly random: () => string;
  private readonly secret: string;

  constructor(dependencies: DeepbridSigningDependencies = {}) {
    this.now = dependencies.now ?? Date.now;
    this.random =
      dependencies.random ?? (() => randomBytes(6).toString('hex').slice(0, 8));
    const secret =
      dependencies.secret || process.env.DEEPBRID_FINDER_SIGNING_SECRET;
    if (!secret) {
      throw new Error(
        'Deepbrid Finder request signing is not configured on this server.'
      );
    }
    this.secret = secret;
  }

  sign(method: string, path: string): Record<string, string> {
    const timestamp = Math.floor((this.now() + this.serverOffsetMs) / 1000);
    const nonce = `${timestamp.toString(36)}${(this.counter++).toString(
      36
    )}${this.random().slice(0, 8)}`;
    const canonical = `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}`;
    return {
      'X-DB-Ts': String(timestamp),
      'X-DB-Nonce': nonce,
      'X-DB-Sig': createHmac('sha256', this.secret)
        .update(canonical)
        .digest('hex'),
    };
  }

  noteServerDate(value: string | null): boolean {
    if (!value) return false;
    const serverDate = Date.parse(value);
    if (!Number.isFinite(serverDate)) return false;
    const offset = serverDate - this.now();
    if (Math.abs(offset) <= 5_000) return false;
    this.serverOffsetMs = offset;
    return true;
  }
}

const ResultSchema = z.looseObject({
  token: z.coerce.string().min(1),
  title: z.string().optional(),
  name: z.string().optional(),
  category: z.coerce.string().optional(),
  category_name: z.coerce.string().optional(),
  categoryName: z.coerce.string().optional(),
  kind: z.coerce.string().optional(),
  size: z.coerce.number().nonnegative().catch(0),
  size_human: z.coerce.string().optional(),
  sizeHuman: z.coerce.string().optional(),
  nzb: z.string().optional(),
  nzb_url: z.string().optional(),
  nzbUrl: z.string().optional(),
  date: z.coerce.string().optional(),
  created_at: z.coerce.string().optional(),
  sources: z.coerce.number().int().nonnegative().catch(0),
});

const FileSchema = z.looseObject({
  name: z.string().optional(),
  filename: z.string().optional(),
  short_name: z.string().optional(),
  subject: z.string().optional(),
  link: z.url().optional(),
  url: z.url().optional(),
  download_url: z.string().optional(),
  downloadUrl: z.string().optional(),
  download: z.string().optional(),
  size: z.coerce.number().nonnegative().catch(0),
  filesize: z.coerce.number().nonnegative().catch(0),
  size_human: z.coerce.string().optional(),
  sizeHuman: z.coerce.string().optional(),
});

export interface DeepbridFinderResult {
  token: string;
  title: string;
  category: string;
  categoryName: string;
  kind: string;
  size: number;
  sizeHuman: string;
  date: string;
  sources: number;
}

export interface DeepbridFinderFile {
  name: string;
  link: string;
  size: number;
  sizeHuman: string;
  nzbUrl?: string;
}

export interface DeepbridFinderContent {
  title: string;
  files: DeepbridFinderFile[];
  hasPassword: boolean;
  password: string;
}

export interface DeepbridUploadInfo {
  id: string;
  title: string;
  files: DeepbridFinderFile[];
}

export interface DeepbridAddResult {
  id?: string;
  title: string;
  files: DeepbridFinderFile[];
}

export interface DeepbridUpload {
  id: string;
  title: string;
  source: string;
  sourceUrl?: string;
  hash?: string;
  addedAt?: string;
}

export interface DeepbridTorrent {
  id: string;
  hash?: string;
  title: string;
  status: string;
  progress?: number;
  size?: number;
  files: DeepbridFinderFile[];
}

export interface DeepbridUser {
  id?: string;
  username?: string;
  email?: string;
  premium?: boolean;
  raw: Record<string, unknown>;
}

export interface DeepbridRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class DeepbridApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = 'DeepbridApiError';
  }
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error('aborted'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function isDeepbridHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'deepbrid.com' || host.endsWith('.deepbrid.com');
}

/** Hosts currently used by Deepbrid Finder for resolved Usenet media. */
export function isDeepbridStorageHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'myfast.link' || host.endsWith('.myfast.link');
}

export function isTrustedDeepbridDownloadHost(hostname: string): boolean {
  return isDeepbridHost(hostname) || isDeepbridStorageHost(hostname);
}

export function validateDeepbridDownloadUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new DeepbridApiError(
      'Deepbrid returned an unsafe download URL.',
      undefined,
      'unsafe-download-url'
    );
  }
  url.username = '';
  url.password = '';
  url.hash = '';
  return url;
}

function looksLikeHtml(contentType: string, text: string): boolean {
  const trimmed = text.trimStart().toLowerCase();
  return (
    contentType.toLowerCase().includes('html') ||
    trimmed.startsWith('<!doctype html') ||
    trimmed.startsWith('<html')
  );
}

function apiMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object') return fallback;
  const record = value as Record<string, unknown>;
  for (const key of ['message', 'error_message', 'error_description']) {
    if (typeof record[key] === 'string' && record[key]) return record[key];
  }
  return fallback;
}

function responseObjects(
  value: Record<string, unknown>
): Record<string, unknown>[] {
  const objects = [value];
  for (const key of ['data', 'result', 'download', 'item', 'upload']) {
    const nested = value[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      objects.push(nested as Record<string, unknown>);
    }
  }
  return objects;
}

function parseDeepbridFiles(value: Record<string, unknown>) {
  const values = responseObjects(value)
    .map((candidate) => candidate.files)
    .find(Array.isArray);
  if (!values) return [];
  return values.flatMap((entry) => {
    const parsed = FileSchema.safeParse(entry);
    if (!parsed.success) return [];
    const file = parsed.data;
    const name =
      file.name || file.filename || file.short_name || file.subject || '';
    const link =
      file.download_url ||
      file.downloadUrl ||
      file.url ||
      file.link ||
      file.download ||
      '';
    if (!name || !link) return [];
    try {
      const absoluteLink = link.startsWith('/')
        ? new URL(link, 'https://www.deepbrid.com').toString()
        : link;
      return [
        {
          name,
          link: validateDeepbridDownloadUrl(absoluteLink).toString(),
          size: file.filesize || file.size,
          sizeHuman: file.size_human || file.sizeHuman || '',
        },
      ];
    } catch {
      return [];
    }
  });
}

function responseValue(
  value: Record<string, unknown>,
  keys: string[]
): unknown {
  for (const candidate of responseObjects(value)) {
    for (const key of keys) {
      if (candidate[key] !== undefined && candidate[key] !== null) {
        return candidate[key];
      }
    }
  }
  return undefined;
}

export function parseDeepbridAddResponse(
  json: Record<string, unknown>
): DeepbridAddResult {
  const id = responseValue(json, ['id', 'upload_id', 'uploadId']);
  const title = responseValue(json, ['title', 'name', 'filename']);
  return {
    id:
      typeof id === 'string' || typeof id === 'number' ? String(id) : undefined,
    title: typeof title === 'string' ? title : '',
    files: parseDeepbridFiles(json),
  };
}

/**
 * Client for Deepbrid's documented account and Usenet upload API.
 *
 * Finder intentionally remains a separate client below because it follows the
 * native app's Finder contract. Account validation, external NZB submission,
 * upload history, and resolved-file lookup use only the public API contract.
 */
export class DeepbridOfficialClient {
  constructor(
    private readonly apiKey: string,
    private readonly timeoutMs = 20_000
  ) {
    if (!apiKey.trim()) {
      throw new DeepbridApiError('Deepbrid API key is required.');
    }
  }

  private async requestJson(
    path: string,
    options: DeepbridRequestOptions & {
      method?: 'GET' | 'POST';
      body?: URLSearchParams;
    } = {}
  ): Promise<Record<string, unknown>> {
    const timeoutMs = Math.max(
      250,
      Math.min(this.timeoutMs, options.timeoutMs ?? this.timeoutMs)
    );

    for (let attempt = 0; attempt < 3; attempt++) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = options.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal;
      const response = await makeRequest(`${DEEPBRID_API_BASE}${path}`, {
        method: options.method || 'GET',
        timeout: timeoutMs,
        signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'User-Agent': DEEPBRID_AIOSTREAMS_USER_AGENT,
          ...(options.body
            ? { 'Content-Type': 'application/x-www-form-urlencoded' }
            : {}),
        },
        body: options.body,
      });
      const text = await response.text();
      const contentType = response.headers.get('content-type') || '';
      if (looksLikeHtml(contentType, text)) {
        throw new DeepbridApiError(
          "Deepbrid's edge rejected the API request.",
          response.status,
          'cloudflare-response'
        );
      }

      let parsed: unknown = {};
      if (text.trim()) {
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new DeepbridApiError(
            'Deepbrid returned a non-JSON response.',
            response.status,
            'invalid-json'
          );
        }
      }

      const retryAfter = retryAfterMs(response);
      if (
        response.status === 429 &&
        attempt === 0 &&
        retryAfter !== undefined &&
        retryAfter <= 5_000
      ) {
        await abortableDelay(retryAfter, options.signal);
        continue;
      }
      if ((response.status === 502 || response.status === 503) && attempt < 2) {
        await abortableDelay(
          Math.min(5_000, 500 * 2 ** attempt),
          options.signal
        );
        continue;
      }
      if (!response.ok) {
        throw new DeepbridApiError(
          apiMessage(parsed, `Deepbrid request failed (${response.status}).`),
          response.status,
          'http-error',
          retryAfter
        );
      }

      if (!parsed || typeof parsed !== 'object') return {};
      const record = parsed as Record<string, unknown>;
      const error = Number(record.error ?? 0);
      if (Number.isFinite(error) && error !== 0) {
        throw new DeepbridApiError(
          apiMessage(record, 'Deepbrid reported that the request failed.'),
          response.status,
          `api_${error}`
        );
      }
      return record;
    }

    throw new DeepbridApiError(
      'Deepbrid request retry budget was exhausted.',
      503,
      'retry-exhausted'
    );
  }

  async getUser(options: DeepbridRequestOptions = {}): Promise<DeepbridUser> {
    const json = await this.requestJson('/user', options);
    const source =
      json.user && typeof json.user === 'object'
        ? (json.user as Record<string, unknown>)
        : json;
    return {
      id:
        typeof source.id === 'string' || typeof source.id === 'number'
          ? String(source.id)
          : undefined,
      username:
        typeof source.username === 'string' ? source.username : undefined,
      email: typeof source.email === 'string' ? source.email : undefined,
      premium:
        typeof source.premium === 'boolean'
          ? source.premium
          : typeof source.is_premium === 'boolean'
            ? source.is_premium
            : undefined,
      raw: source,
    };
  }

  async listUploads(
    options: DeepbridRequestOptions = {}
  ): Promise<DeepbridUpload[]> {
    const json = await this.requestJson('/usenet/uploads', options);
    const items = Array.isArray(json.items) ? json.items : [];
    return items.flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const item = value as Record<string, unknown>;
      const id = item.id;
      if (typeof id !== 'string' && typeof id !== 'number') return [];
      return [
        {
          id: String(id),
          title:
            typeof item.title === 'string'
              ? item.title
              : typeof item.name === 'string'
                ? item.name
                : '',
          source: typeof item.source === 'string' ? item.source : '',
          sourceUrl:
            typeof item.source_url === 'string' ? item.source_url : undefined,
          hash: typeof item.hash === 'string' ? item.hash : undefined,
          addedAt:
            typeof item.added_at === 'string' ? item.added_at : undefined,
        },
      ];
    });
  }

  async addNzbUrl(
    nzbUrl: string,
    options: DeepbridRequestOptions = {}
  ): Promise<DeepbridAddResult> {
    const parsed = new URL(nzbUrl);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw new DeepbridApiError(
        'Deepbrid requires a safe HTTPS NZB URL.',
        undefined,
        'unsafe-nzb-url'
      );
    }
    const json = await this.requestJson('/usenet/add', {
      ...options,
      method: 'POST',
      body: new URLSearchParams({ nzb_url: parsed.toString() }),
    });
    return parseDeepbridAddResponse(json);
  }

  async getUploadInfo(
    id: string,
    options: DeepbridRequestOptions = {}
  ): Promise<DeepbridUploadInfo> {
    const json = await this.requestJson(
      `/usenet/uploads/info?id=${encodeURIComponent(id)}`,
      options
    );
    const files = parseDeepbridFiles(json);
    return {
      id,
      title: typeof json.title === 'string' ? json.title : '',
      files,
    };
  }

  /** Read-only account torrent library. It never adds or scrapes torrents. */
  async listTorrents(
    options: DeepbridRequestOptions = {}
  ): Promise<DeepbridTorrent[]> {
    const json = await this.requestJson('/torrents/info', options);
    const values: [string | undefined, unknown][] = Array.isArray(json.items)
      ? json.items.map((value) => [undefined, value])
      : Array.isArray(json.torrents)
        ? json.torrents.map((value) => [undefined, value])
        : Array.isArray(json.data)
          ? json.data.map((value) => [undefined, value])
          : Object.entries(json).map(([id, value]) => [id, value]);
    return values.flatMap(([fallbackId, value]) =>
      this.parseTorrent(value, fallbackId)
    );
  }

  async getTorrentInfo(
    id: string,
    options: DeepbridRequestOptions = {}
  ): Promise<DeepbridTorrent | undefined> {
    const json = await this.requestJson(
      `/torrents/info?id=${encodeURIComponent(id)}`,
      options
    );
    const value =
      json.torrent && typeof json.torrent === 'object'
        ? json.torrent
        : json.data &&
            !Array.isArray(json.data) &&
            typeof json.data === 'object'
          ? json.data
          : json;
    return this.parseTorrent(value, id)[0];
  }

  private parseTorrent(value: unknown, fallbackId?: string): DeepbridTorrent[] {
    if (!value || typeof value !== 'object') return [];
    const item = value as Record<string, unknown>;
    const id = item.id ?? item.torrent_id ?? item.torrentId ?? fallbackId;
    if (typeof id !== 'string' && typeof id !== 'number') return [];
    const title =
      (typeof item.title === 'string' && item.title) ||
      (typeof item.name === 'string' && item.name) ||
      (typeof item.filename === 'string' && item.filename) ||
      '';
    const hash = [item.hash, item.infohash, item.info_hash].find(
      (v): v is string => typeof v === 'string' && v.length > 0
    );
    const rawStatus = item.status ?? item.state ?? '';
    const status =
      typeof rawStatus === 'string' ? rawStatus : String(rawStatus);
    const progress = Number(item.progress ?? item.percentage ?? 0);
    const size = Number(item.size ?? item.total_size ?? 0);
    const links = Array.isArray(item.links)
      ? item.links.flatMap((link) => {
          if (typeof link !== 'string' || !link) return [];
          let name = title || `torrent-${id}`;
          try {
            const parsed = new URL(link);
            const basename = decodeURIComponent(
              parsed.pathname.split('/').filter(Boolean).pop() || ''
            );
            // Deepbrid's documented torrent links use /mytorrents with the
            // actual file identity in the account response's filename. Do
            // not replace a useful release title with that route name.
            if (basename && isDeepbridVideoName(basename)) name = basename;
          } catch {}
          return [{ name, link, size: 0, sizeHuman: '' }];
        })
      : [];
    const parsedFiles = parseDeepbridFiles(item);
    return [
      {
        id: String(id),
        hash,
        title,
        status,
        progress: Number.isFinite(progress) ? progress : undefined,
        size: Number.isFinite(size) && size > 0 ? size : undefined,
        files: parsedFiles.length ? parsedFiles : links,
      },
    ];
  }
}

export class DeepbridFinderClient {
  private readonly signer = new DeepbridRequestSigner();

  constructor(
    private readonly apiKey: string,
    private readonly timeoutMs = 20_000
  ) {
    if (!apiKey.trim())
      throw new DeepbridApiError('Deepbrid API key is required.');
  }

  private async getJson(
    path: string,
    options: DeepbridRequestOptions = {}
  ): Promise<Record<string, unknown>> {
    try {
      return await this.getJsonOnce(path, options);
    } catch (error) {
      // A stale local clock is indistinguishable from a forbidden signature.
      // The first response's Date header has already corrected the signer, so
      // retry once with a new nonce before surfacing the real error.
      if (error instanceof DeepbridApiError && error.code === 'api_15') {
        return this.getJsonOnce(path, options);
      }
      throw error;
    }
  }

  private async getJsonOnce(
    path: string,
    options: DeepbridRequestOptions = {}
  ): Promise<Record<string, unknown>> {
    const timeoutMs = Math.max(
      250,
      Math.min(this.timeoutMs, options.timeoutMs ?? this.timeoutMs)
    );
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const response = await makeRequest(`${DEEPBRID_API_BASE}${path}`, {
      timeout: timeoutMs,
      signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'User-Agent': DEEPBRID_FINDER_USER_AGENT,
        ...this.signer.sign('GET', path),
      },
    });
    this.signer.noteServerDate(response.headers.get('date'));
    const text = await response.text();
    const contentType = response.headers.get('content-type') || '';
    if (looksLikeHtml(contentType, text)) {
      throw new DeepbridApiError(
        "Deepbrid's edge rejected the API request.",
        response.status,
        'cloudflare-response'
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new DeepbridApiError(
        'Deepbrid returned a non-JSON response.',
        response.status,
        'invalid-json'
      );
    }
    if (!response.ok) {
      throw new DeepbridApiError(
        apiMessage(parsed, `Deepbrid request failed (${response.status}).`),
        response.status,
        'http-error'
      );
    }
    if (parsed && typeof parsed === 'object') {
      const error = (parsed as Record<string, unknown>).error;
      const code = Number(error);
      if (Number.isFinite(code) && code !== 0) {
        throw new DeepbridApiError(
          apiMessage(parsed, 'Deepbrid reported that the request failed.'),
          undefined,
          `api_${code}`
        );
      }
      return parsed as Record<string, unknown>;
    }
    return {};
  }

  async search(
    query: string,
    options: {
      category?: string;
      offset?: number;
      limit?: number;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {}
  ): Promise<DeepbridFinderResult[]> {
    const trimmed = query.trim();
    if (trimmed.length < 3) return [];
    const offset = Math.max(0, Math.floor(options.offset || 0));
    const limit = Math.min(100, Math.max(1, Math.floor(options.limit || 50)));
    const params = new URLSearchParams({
      q: trimmed,
      offset: String(offset),
      limit: String(limit),
    });
    if (options.category) params.set('category', options.category);
    const json = await this.getJson(`/usenet/finder/search?${params}`, options);
    const items = Array.isArray(json.items) ? json.items : [];
    return items.flatMap((value) => {
      const parsed = ResultSchema.safeParse(value);
      if (!parsed.success) return [];
      const item = parsed.data;
      const title = item.title || item.name || '';
      if (!title) return [];
      return [
        {
          token: item.token,
          title,
          category: item.category || '',
          categoryName: item.category_name || item.categoryName || '',
          kind: item.kind || '',
          size: item.size,
          sizeHuman: item.size_human || item.sizeHuman || '',
          date: item.date || item.created_at || '',
          sources: item.sources,
        },
      ];
    });
  }

  async getContent(
    token: string,
    archives: boolean,
    options: DeepbridRequestOptions = {}
  ): Promise<DeepbridFinderContent> {
    if (!token.trim())
      throw new DeepbridApiError('Deepbrid content token is required.');
    const params = new URLSearchParams({
      token: token.trim(),
      archives: archives ? '1' : '0',
    });
    const json = await this.getJson(
      `/usenet/finder/content?${params}`,
      options
    );
    const values = Array.isArray(json.files) ? json.files : [];
    const files = values.flatMap((value) => {
      const parsed = FileSchema.safeParse(value);
      if (!parsed.success) return [];
      const file = parsed.data;
      const name = file.name || file.filename || '';
      const link = file.link || file.url || '';
      if (!name || !link) return [];
      try {
        const nzbUrl = [file.nzb_url, file.nzbUrl, file.nzb].find(
          (value): value is string =>
            typeof value === 'string' && value.length > 0
        );
        return [
          {
            name,
            link: validateDeepbridDownloadUrl(link).toString(),
            size: file.size,
            sizeHuman: file.size_human || file.sizeHuman || '',
            nzbUrl,
          },
        ];
      } catch {
        return [];
      }
    });
    const hasPassword =
      json.has_password === true ||
      json.has_password === 1 ||
      json.hasPassword === true;
    return {
      title: typeof json.title === 'string' ? json.title : '',
      files,
      hasPassword,
      password: typeof json.password === 'string' ? json.password : '',
    };
  }
}

export function isDeepbridArchiveName(name: string): boolean {
  return /\.(?:rar|r\d{2}|7z(?:\.\d{3})?|zip|s\d{2}|part\d+\.rar|tar|gz|bz2)$/i.test(
    name
  );
}

export function isDeepbridVideoName(name: string): boolean {
  return /\.(?:mkv|mp4|m4v|avi|mov|webm|ts|m2ts|wmv|flv|mpg|mpeg)$/i.test(name);
}

/**
 * Deepbrid's torrent endpoint may omit a file extension from `filename`.
 * Quality/container tokens are enough to identify normal video releases,
 * while keeping generic archives and unrelated account files out of Library.
 */
export function isLikelyDeepbridVideoName(name: string): boolean {
  if (isDeepbridVideoName(name)) return true;
  if (/\.(?:iso|zip|rar|7z|nzb|pdf|srt|nfo|txt)$/i.test(name)) return false;
  return /(?:\b(?:2160p|1080p|720p|576p|4k|uhd)\b|blu[-_. ]?ray|web[-_. ]?dl|web[-_. ]?rip|hdtv|remux|x264|x265|h\.?264|hevc|avc|hdr|dolby|atmos)/i.test(
    name
  );
}
