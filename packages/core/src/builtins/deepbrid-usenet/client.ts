import { z } from 'zod';
import { makeRequest } from '../../utils/index.js';

export const DEEPBRID_API_BASE = 'https://www.deepbrid.com/api/v1';
export const DEEPBRID_FINDER_USER_AGENT =
  'Deepbrid/1.0 (ios) DBX/k9Q4mZ2xV7bN1pR8sT3wY6cH0jL5dF';
export const DEEPBRID_AIOSTREAMS_USER_AGENT = 'AIOStreams Deepbrid integration';

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
  link: z.url().optional(),
  url: z.url().optional(),
  size: z.coerce.number().nonnegative().catch(0),
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

export interface DeepbridUpload {
  id: string;
  title: string;
  source: string;
  sourceUrl?: string;
  hash?: string;
  addedAt?: string;
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
        (response.status === 429 ||
          response.status === 502 ||
          response.status === 503) &&
        attempt < 2
      ) {
        await abortableDelay(
          Math.min(5_000, retryAfter ?? 500 * 2 ** attempt),
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
  ): Promise<string> {
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
    const id = json.id ?? json.upload_id ?? json.uploadId;
    if (typeof id !== 'string' && typeof id !== 'number') {
      throw new DeepbridApiError(
        'Deepbrid NZB upload returned no upload id.',
        502,
        'missing-upload-id'
      );
    }
    return String(id);
  }

  async getUploadInfo(
    id: string,
    options: DeepbridRequestOptions = {}
  ): Promise<DeepbridUploadInfo> {
    const json = await this.requestJson(
      `/usenet/uploads/info?id=${encodeURIComponent(id)}`,
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
        return [
          {
            name,
            link: validateDeepbridDownloadUrl(link).toString(),
            size: file.size,
            sizeHuman: file.size_human || file.sizeHuman || '',
          },
        ];
      } catch {
        return [];
      }
    });
    return {
      id,
      title: typeof json.title === 'string' ? json.title : '',
      files,
    };
  }
}

export class DeepbridFinderClient {
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
      },
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
