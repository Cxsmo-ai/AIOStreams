import { randomUUID } from 'node:crypto';
import { Cache } from '../utils/cache.js';
import { decryptString, encryptString } from '../utils/crypto.js';
import { withWeTrakrTokenLock } from './wetrakr-token-lock.js';
import { reserveWeTrakrRequest } from './wetrakr-quota.js';

const API_ORIGIN = 'https://api.wetrakr.com';
const API_VERSION = '1';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_INLINE_RETRY_AFTER_MS = 1_500;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;
const TOKEN_TTL_SECONDS = 180 * 24 * 60 * 60;
const SAFE_PROVIDER_ERROR_CODES = new Set([
  'PRIVATE',
  'FRIENDS_ONLY',
  'COMMENTS_DISABLED',
]);

export type WeTrakrDeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

export type WeTrakrToken = {
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: number;
  /** Stored only inside the encrypted server-side token record. */
  applicationCredentials?: WeTrakrApplicationCredentials;
};

export type WeTrakrApplicationCredentials = {
  clientId: string;
  clientSecret?: string;
};

function requireApplicationCredentials(
  credentials: WeTrakrApplicationCredentials | undefined
): WeTrakrApplicationCredentials {
  const clientId = credentials?.clientId.trim() ?? '';
  const clientSecret = credentials?.clientSecret?.trim() ?? '';
  if (!clientId || clientId.length > 512 || clientSecret.length > 2048)
    throw new Error(
      'Enter a valid WeTrakr app client ID and optional client secret for this configuration'
    );
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
}

type JsonObject = Record<string, unknown>;

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (
    Number.isSafeInteger(declaredLength) &&
    declaredLength > MAX_RESPONSE_BYTES
  ) {
    await response.body?.cancel();
    throw new Error('WeTrakr response exceeded the allowed size');
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('WeTrakr response exceeded the allowed size');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function stringField(value: JsonObject, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim())
      return candidate.trim();
  }
  return undefined;
}

function boundedSeconds(
  value: unknown,
  fallback: number,
  maximum: number
): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(maximum, Math.floor(seconds))
    : fallback;
}

async function apiRequest(
  path: string,
  body: JsonObject,
  fetchImpl: typeof fetch
): Promise<{ status: number; data: JsonObject }> {
  await reserveApplicationRequest(body.client_id, 'write');
  const response = await fetchImpl(`${API_ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'wetrakr-api-version': API_VERSION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12_000),
    redirect: 'error',
  });
  const text = await readBoundedResponse(response);
  let data: JsonObject;
  try {
    data = object(JSON.parse(text));
  } catch {
    throw new Error('WeTrakr returned an invalid response');
  }
  return { status: response.status, data };
}

async function saveTokenAtReference(
  reference: string,
  token: WeTrakrToken
): Promise<void> {
  const encrypted = encryptString(JSON.stringify(token));
  if (!encrypted.success || !encrypted.data)
    throw new Error('Unable to protect the WeTrakr account token');
  await tokenStore.set(reference, encrypted.data, TOKEN_TTL_SECONDS, true);
}

/** Rotate the short-lived access token and persist the new refresh token. */
export async function refreshWeTrakrToken(
  token: WeTrakrToken,
  fetchImpl: typeof fetch = fetch
): Promise<WeTrakrToken> {
  const applicationCredentials = requireApplicationCredentials(
    token.applicationCredentials
  );
  await reserveApplicationRequest(applicationCredentials.clientId, 'write');
  const response = await fetchImpl(`${API_ORIGIN}/oauth/token/refresh`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'wetrakr-api-version': API_VERSION,
      'wetrakr-api-key': applicationCredentials.clientId,
    },
    body: JSON.stringify({ refresh_token: token.refreshToken }),
    signal: AbortSignal.timeout(12_000),
    redirect: 'error',
  });
  const text = await readBoundedResponse(response);
  let data: JsonObject;
  try {
    data = object(JSON.parse(text));
  } catch {
    throw new Error('WeTrakr returned an invalid refresh response');
  }
  if (!response.ok)
    throw new Error(
      'WeTrakr account authorization expired; relink the account'
    );
  const accessToken = stringField(data, 'access_token');
  const refreshToken = stringField(data, 'new_refresh_token', 'refresh_token');
  if (!accessToken || !refreshToken)
    throw new Error('WeTrakr returned an incomplete refreshed token');
  return {
    accessToken,
    refreshToken,
    tokenExpiresAt:
      Date.now() + boundedSeconds(data.expires_in, 604_800, 604_800) * 1000,
    applicationCredentials,
  };
}

export type WeTrakrApiResult = { data: unknown; headers: Headers };

export class WeTrakrRateLimitError extends Error {
  readonly status = 429;

  constructor(
    readonly retryAfterMs: number,
    readonly endpoint?: string
  ) {
    super('WeTrakr rate limit reached; retry after the indicated delay');
    this.name = 'WeTrakrRateLimitError';
  }
}

async function reserveApplicationRequest(
  clientId: unknown,
  kind: 'get' | 'write'
): Promise<void> {
  const normalizedClientId =
    typeof clientId === 'string' ? clientId.trim() : '';
  if (!normalizedClientId || process.env.NODE_ENV === 'test') return;
  const decision = await reserveWeTrakrRequest(normalizedClientId, kind);
  if (!decision.allowed)
    throw new WeTrakrRateLimitError(
      decision.retryAfterMs ?? 1_000,
      `quota_${decision.reason ?? 'window'}`
    );
}

/** Upstream status without retaining or exposing provider response bodies. */
export class WeTrakrApiError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint?: string,
    readonly providerCode?: string
  ) {
    super(`WeTrakr API request failed (${status})`);
    this.name = 'WeTrakrApiError';
  }
}

function safeProviderErrorCode(value: unknown): string | undefined {
  const candidate = stringField(object(value), 'error');
  return candidate && SAFE_PROVIDER_ERROR_CODES.has(candidate)
    ? candidate
    : undefined;
}

/** A route label safe for diagnostics: never includes list, media, or comment IDs. */
function diagnosticEndpoint(path: string): string {
  const pathname = path.split('?', 1)[0] ?? '';
  const trackingStatus = pathname.match(
    /^\/sync\/tracking\/(watching|playing|waiting|planning|dropped|paused|watched)\/all$/
  );
  if (trackingStatus) return `sync_tracking_${trackingStatus[1]}_all`;
  const history = pathname.match(
    /^\/sync\/tracking\/watched\/history\/(movies|episodes)$/
  );
  if (history) return `sync_tracking_watched_history_${history[1]}`;
  if (pathname === '/sync/ratings/all') return 'sync_ratings_all';
  if (pathname === '/sync/favorites/all') return 'sync_favorites_all';
  if (pathname === '/sync/likes/all') return 'likes_all';
  if (pathname === '/sync/notes/all') return 'sync_notes_all';
  if (pathname === '/sync/comments/all') return 'sync_comments_all';
  if (pathname === '/sync/lists') return 'sync_lists';
  if (/^\/sync\/lists\/[^/]+\/items(?:\/remove)?$/.test(pathname))
    return 'sync_lists_items';
  if (pathname.startsWith('/sync/journal')) return 'sync_journal';
  return 'other';
}

function retryAfterMilliseconds(headers: Headers, now = Date.now()): number {
  const raw = headers.get('retry-after');
  if (!raw) return 1_000;
  const seconds = Number(raw.trim());
  const delay = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(raw) - now;
  return Math.max(
    0,
    Math.min(MAX_RETRY_AFTER_MS, Number.isFinite(delay) ? delay : 1_000)
  );
}

/**
 * Make a same-origin, bounded WeTrakr API call. Rotated credentials are saved
 * server-side; the opaque account reference is the only value stored in config.
 */
export async function requestWeTrakrApi(
  reference: string,
  path: string,
  init: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    idempotencyKey?: string;
  } = {},
  fetchImpl: typeof fetch = fetch,
  resolveToken: (
    reference: string
  ) => Promise<WeTrakrToken> = resolveWeTrakrToken
): Promise<WeTrakrApiResult> {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('://'))
    throw new Error('Invalid WeTrakr API path');
  const idempotencyKey =
    init.idempotencyKey === undefined
      ? undefined
      : validateIdempotencyKey(init.idempotencyKey);

  let token = await resolveToken(reference);
  const applicationCredentials = requireApplicationCredentials(
    token.applicationCredentials
  );
  if (token.tokenExpiresAt <= Date.now() + 60_000) {
    token = await refreshStoredToken(reference, token, fetchImpl);
  }

  const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
  const safeToRetry = method === 'GET' || idempotencyKey !== undefined;
  const perform = async (current: WeTrakrToken) => {
    await reserveApplicationRequest(
      applicationCredentials.clientId,
      method === 'GET' ? 'get' : 'write'
    );
    const response = await fetchImpl(`${API_ORIGIN}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${current.accessToken}`,
        'wetrakr-api-key': applicationCredentials.clientId,
        'wetrakr-api-version': API_VERSION,
        ...(idempotencyKey === undefined
          ? {}
          : { 'Idempotency-Key': idempotencyKey }),
        ...(init.body === undefined
          ? {}
          : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    const text = await readBoundedResponse(response);
    if (response.status === 429) return { response, data: null };
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error('WeTrakr returned an invalid API response');
    }
    return { response, data };
  };

  let result = await perform(token);
  if (result.response.status === 401) {
    const latest = await resolveToken(reference);
    token =
      latest.accessToken !== token.accessToken
        ? latest
        : await refreshStoredToken(reference, token, fetchImpl);
    result = await perform(token);
  }
  if (result.response.status === 429) {
    const retryAfterMs = retryAfterMilliseconds(result.response.headers);
    if (safeToRetry && retryAfterMs <= MAX_INLINE_RETRY_AFTER_MS) {
      if (retryAfterMs > 0)
        await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
      result = await perform(token);
    }
    if (result.response.status === 429)
      throw new WeTrakrRateLimitError(retryAfterMs, diagnosticEndpoint(path));
  }
  if (!result.response.ok)
    throw new WeTrakrApiError(
      result.response.status,
      diagnosticEndpoint(path),
      safeProviderErrorCode(result.data)
    );
  return { data: result.data, headers: result.response.headers };
}

function validateIdempotencyKey(value: string): string {
  if (!/^[A-Za-z0-9._~-]{1,128}$/.test(value))
    throw new Error('Invalid WeTrakr idempotency key');
  return value;
}

export async function requestWeTrakrDeviceCode(
  applicationCredentials: WeTrakrApplicationCredentials,
  fetchImpl: typeof fetch = fetch
): Promise<WeTrakrDeviceCode> {
  const credentials = requireApplicationCredentials(applicationCredentials);
  const { status, data } = await apiRequest(
    '/oauth/device/code',
    { client_id: credentials.clientId },
    fetchImpl
  );
  const deviceCode = stringField(data, 'device_code');
  const userCode = stringField(data, 'user_code');
  const verificationUri = stringField(
    data,
    'verification_uri_complete',
    'verification_uri',
    'verification_url'
  );
  if (
    status < 200 ||
    status >= 300 ||
    !deviceCode ||
    !userCode ||
    !verificationUri
  )
    throw new Error('WeTrakr could not start device authorization');
  const url = new URL(verificationUri);
  if (
    url.protocol !== 'https:' ||
    !['wetrakr.com', 'www.wetrakr.com'].includes(url.hostname)
  )
    throw new Error('WeTrakr returned an untrusted verification URL');
  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresIn: boundedSeconds(data.expires_in, 600, 1800),
    interval: boundedSeconds(data.interval, 5, 60),
  };
}

export type WeTrakrDevicePoll =
  | { status: 'pending'; retryAfter: number }
  | { status: 'authorized'; token: WeTrakrToken };

export async function pollWeTrakrDeviceToken(
  deviceCode: string,
  applicationCredentials: WeTrakrApplicationCredentials,
  fetchImpl: typeof fetch = fetch
): Promise<WeTrakrDevicePoll> {
  const credentials = requireApplicationCredentials(applicationCredentials);
  const body: JsonObject = {
    client_id: credentials.clientId,
    // The endpoint calls this field `code`; its value is the opaque
    // device_code returned by /oauth/device/code.
    code: deviceCode,
  };
  // The app secret is server-only. Never return it to the browser or put it in
  // a config URL; WeTrakr makes it optional for public clients.
  if (credentials.clientSecret) body.client_secret = credentials.clientSecret;
  const { status, data } = await apiRequest(
    '/oauth/device/token',
    body,
    fetchImpl
  );
  const error = stringField(data, 'error')?.toLowerCase();
  if (error === 'authorization_pending')
    return {
      status: 'pending',
      retryAfter: boundedSeconds(data.interval, 5, 60),
    };
  if (error === 'slow_down')
    return {
      status: 'pending',
      retryAfter: Math.min(60, boundedSeconds(data.interval, 10, 60)),
    };
  if (status < 200 || status >= 300 || error)
    throw new Error('WeTrakr device authorization failed or expired');
  const accessToken = stringField(data, 'access_token');
  const refreshToken = stringField(data, 'refresh_token', 'new_refresh_token');
  if (!accessToken || !refreshToken)
    throw new Error('WeTrakr returned an incomplete token response');
  return {
    status: 'authorized',
    token: {
      accessToken,
      refreshToken,
      tokenExpiresAt:
        Date.now() + boundedSeconds(data.expires_in, 3600, 31_536_000) * 1000,
      applicationCredentials: credentials,
    },
  };
}

const tokenStore = Cache.getInstance<string, string>(
  'wetrakr-oauth',
  10_000,
  'sql'
);
const refreshInFlight = new Map<string, Promise<WeTrakrToken>>();

async function refreshStoredToken(
  reference: string,
  token: WeTrakrToken,
  fetchImpl: typeof fetch
): Promise<WeTrakrToken> {
  const existing = refreshInFlight.get(reference);
  if (existing) return existing;
  const refresh = withWeTrakrTokenLock(reference, async () => {
    // Another request may have rotated the token while this caller waited for
    // the account lock. Reuse that token rather than replaying an old refresh.
    const latest = await resolveWeTrakrToken(reference);
    if (
      latest.accessToken !== token.accessToken ||
      latest.refreshToken !== token.refreshToken
    ) {
      if (latest.tokenExpiresAt > Date.now() + 60_000) return latest;
      token = latest;
    }
    const nextToken = await refreshWeTrakrToken(token, fetchImpl);
    await saveTokenAtReference(reference, nextToken);
    return nextToken;
  }).finally(() => {
    if (refreshInFlight.get(reference) === refresh)
      refreshInFlight.delete(reference);
  });
  refreshInFlight.set(reference, refresh);
  return refresh;
}

export async function storeWeTrakrToken(
  token: WeTrakrToken,
  applicationCredentials: WeTrakrApplicationCredentials,
  reference = randomUUID()
): Promise<string> {
  const protectedToken: WeTrakrToken = {
    ...token,
    applicationCredentials: requireApplicationCredentials(
      applicationCredentials
    ),
  };
  await withWeTrakrTokenLock(reference, () =>
    saveTokenAtReference(reference, protectedToken)
  );
  return reference;
}

export async function resolveWeTrakrToken(
  reference: string
): Promise<WeTrakrToken> {
  if (!/^[0-9a-f-]{36}$/i.test(reference))
    throw new Error('Invalid WeTrakr account reference');
  const value = await tokenStore.get(reference, true);
  if (!value) throw new Error('WeTrakr account link expired or was removed');
  const decrypted = decryptString(value);
  if (!decrypted.success || !decrypted.data)
    throw new Error('Stored WeTrakr account link could not be decrypted');
  const parsed = object(JSON.parse(decrypted.data));
  const accessToken = stringField(parsed, 'accessToken');
  const refreshToken = stringField(parsed, 'refreshToken');
  const tokenExpiresAt = Number(parsed.tokenExpiresAt);
  const application = object(parsed.applicationCredentials);
  const clientId = stringField(application, 'clientId');
  const clientSecret = stringField(application, 'clientSecret');
  if (!accessToken || !refreshToken || !Number.isFinite(tokenExpiresAt))
    throw new Error('Stored WeTrakr account link is invalid');
  return {
    accessToken,
    refreshToken,
    tokenExpiresAt,
    ...(clientId
      ? {
          applicationCredentials: {
            clientId,
            ...(clientSecret ? { clientSecret } : {}),
          },
        }
      : {}),
  };
}

export async function removeWeTrakrToken(reference: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(reference)) return;
  // Wait behind any token rotation. Deleting first would let that refresh
  // finish later and recreate an unlinked credential in encrypted storage.
  await withWeTrakrTokenLock(reference, () => tokenStore.delete(reference));
}
