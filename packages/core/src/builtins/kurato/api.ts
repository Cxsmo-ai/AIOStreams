import { z } from 'zod';
import { createHash } from 'node:crypto';

const KURATO_API_BASE = 'https://app.kurato.com';
const KURATO_FIREBASE_API_KEY = 'AIzaSyBaKLOJ5Gc0BxC7hn5-iMycWPbMmaRL-0k';
const KURATO_USER_AGENT = 'Kurato/1.4.1(Android)';
const KURATO_APP_VERSION = '1.4.1';
const KURATO_API_VERSION = '2';

export const KuratoCredentialsSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(1024),
});

export const KuratoConfigSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(1024),
  baseUrl: z.string().url().default(KURATO_API_BASE),
  pageSize: z.number().int().min(1).max(100).default(50),
  includeWatchlist: z.boolean().default(true),
  includeCollections: z.boolean().default(true),
  includeGeneratedRecommendations: z.boolean().default(true),
});

export type KuratoConfig = z.infer<typeof KuratoConfigSchema>;

type FetchLike = typeof fetch;

interface TokenState {
  idToken: string;
  refreshToken: string;
  expiresAt: number;
}

const sharedAuthClients = new Map<string, KuratoAuthClient>();
const responseCache = new Map<string, { expiresAt: number; value: unknown }>();
const RESPONSE_CACHE_TTL_MS = 30_000;

function authCacheKey(credentials: z.infer<typeof KuratoCredentialsSchema>) {
  return `${credentials.email}:${createHash('sha256')
    .update(credentials.password)
    .digest('hex')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 240) };
  }
}

export class KuratoAuthError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'KuratoAuthError';
    this.status = status;
  }
}

/** Small Firebase auth client. The Firebase key is a public app identifier; user credentials never leave this process. */
export class KuratoAuthClient {
  private token?: TokenState;
  private loginPromise?: Promise<string>;
  private readonly fetchFn: FetchLike;

  constructor(
    private readonly credentials: z.infer<typeof KuratoCredentialsSchema>,
    fetchFn: FetchLike = fetch
  ) {
    this.fetchFn = fetchFn;
  }

  private async signIn(): Promise<string> {
    const response = await this.fetchFn(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(KURATO_FIREBASE_API_KEY)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: this.credentials.email,
          password: this.credentials.password,
          returnSecureToken: true,
        }),
      }
    );
    const payload = await readJson(response);
    if (!response.ok || !isRecord(payload) || typeof payload.idToken !== 'string') {
      const message =
        isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string'
          ? payload.error.message
          : `Kurato sign-in failed (${response.status})`;
      throw new KuratoAuthError(message, response.status);
    }
    const expiresIn = Number(payload.expiresIn ?? 3600);
    this.token = {
      idToken: payload.idToken,
      refreshToken: typeof payload.refreshToken === 'string' ? payload.refreshToken : '',
      expiresAt: Date.now() + Math.max(60, expiresIn - 300) * 1000,
    };
    return payload.idToken;
  }

  private async refresh(): Promise<string> {
    if (!this.token?.refreshToken) return this.signIn();
    const response = await this.fetchFn(
      `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(KURATO_FIREBASE_API_KEY)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.token.refreshToken,
        }).toString(),
      }
    );
    const payload = await readJson(response);
    if (!response.ok || !isRecord(payload) || typeof payload.id_token !== 'string') {
      this.token = undefined;
      return this.signIn();
    }
    const expiresIn = Number(payload.expires_in ?? 3600);
    this.token = {
      idToken: payload.id_token,
      refreshToken:
        typeof payload.refresh_token === 'string'
          ? payload.refresh_token
          : this.token.refreshToken,
      expiresAt: Date.now() + Math.max(60, expiresIn - 300) * 1000,
    };
    return this.token.idToken;
  }

  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.idToken;
    if (!this.loginPromise) {
      this.loginPromise = this.refresh().finally(() => {
        this.loginPromise = undefined;
      });
    }
    return this.loginPromise;
  }
}

export class KuratoApiClient {
  private readonly auth: KuratoAuthClient;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;

  constructor(config: KuratoConfig, fetchFn: FetchLike = fetch) {
    const credentials = KuratoCredentialsSchema.parse(config);
    const key = authCacheKey(credentials);
    this.auth =
      fetchFn === fetch
        ? (sharedAuthClients.get(key) ??
          (() => {
            const client = new KuratoAuthClient(credentials, fetchFn);
            sharedAuthClients.set(key, client);
            return client;
          })())
        : new KuratoAuthClient(credentials, fetchFn);
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.fetchFn = fetchFn;
    this.email = credentials.email;
  }

  private readonly email: string;

  async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const cacheKey = `${this.baseUrl}:${this.email}:${path}:${init.body ?? ''}`;
    if (this.fetchFn === fetch) {
      const cached = responseCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      responseCache.delete(cacheKey);
    }
    const token = await this.auth.getToken();
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(15_000),
      headers: {
        'content-type': 'application/json',
        'user-agent': KURATO_USER_AGENT,
        'x-app-version': KURATO_APP_VERSION,
        'x-api-version': KURATO_API_VERSION,
        authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });
    const payload = await readJson(response);
    if (!response.ok) {
      throw new Error(
        `Kurato API request failed (${response.status}) for ${path}`
      );
    }
    if (this.fetchFn === fetch) {
      responseCache.set(cacheKey, {
        expiresAt: Date.now() + RESPONSE_CACHE_TTL_MS,
        value: payload,
      });
    }
    return payload;
  }

  homepage(section: 'movies' | 'series', page = 1, perPage = 50) {
    // The mobile app calls homepage content through the POST contract. A GET
    // receives 405 from the current API and makes the For You catalogs appear
    // as empty/error cards in Stremio. Kurato calls the TV section `tv`, not
    // `series`, matching its `/data/tv/...` metadata API.
    const apiSection = section === 'series' ? 'tv' : section;
    return this.request(`/data/homepage/${apiSection}`, {
      method: 'POST',
      body: JSON.stringify({ page, perPage }),
    });
  }

  /** Kurato's natural-language Discover flow is the addon's primary search. */
  discover(type: 'movie' | 'series', query: string, page = 1, perPage = 50) {
    const mediaType = type === 'series' ? 'tv' : 'movies';
    return this.request(`/data/discover/${mediaType}`, {
      method: 'POST',
      body: JSON.stringify({
        query,
        page,
        perPage,
      }),
    });
  }

  collections(query?: string) {
    return this.request('/data/collect/collections', {
      method: 'POST',
      body: JSON.stringify({
        userId: 0,
        subscribed: false,
        sort: 'latest',
        reverse: false,
        includeGenerated: true,
        ...(query?.trim() ? { query: query.trim() } : {}),
      }),
    });
  }

  collection(
    collectionId: string,
    type: 'movie' | 'series',
    perPage = 100
  ) {
    return this.request('/data/collect/collection', {
      method: 'POST',
      body: JSON.stringify({
        collectionId,
        filterContentType: type === 'series' ? 'tv_show' : 'movie',
        perPage,
      }),
    });
  }

  watchlist(type: 'movie' | 'series', sort = 'date') {
    return this.request('/data/watchlist/get', {
      method: 'POST',
      body: JSON.stringify({
        // Kurato's watchlist endpoint accepts the aggregate `all` filter;
        // split movie/series entries locally for the two Stremio catalogs.
        contentType: 'all',
        sort,
      }),
    });
  }

  metadata(type: 'movie' | 'series', id: string) {
    const endpoint = type === 'movie' ? 'movie' : 'tv';
    return this.request(`/data/${endpoint}/${encodeURIComponent(id)}`);
  }
}

export { KURATO_API_BASE };
