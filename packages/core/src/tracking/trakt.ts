import { randomUUID } from 'node:crypto';
import { Cache } from '../utils/cache.js';
import { decryptString, encryptString } from '../utils/crypto.js';

const API_ORIGIN = 'https://api.trakt.tv';
const WEB_ORIGIN = 'https://trakt.tv';
const API_VERSION = '2';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const TOKEN_TTL_SECONDS = 180 * 24 * 60 * 60;

export type TraktTrackerApplicationCredentials = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type TraktTrackerToken = {
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: number;
  /** Stored only inside the encrypted server-side token record. */
  applicationCredentials?: TraktTrackerApplicationCredentials;
};

export type TraktDeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

export type TraktDevicePoll =
  | { status: 'pending'; retryAfter: number }
  | { status: 'authorized'; token: TraktTrackerToken };

type JsonObject = Record<string, unknown>;

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

function seconds(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(maximum, Math.floor(parsed))
    : fallback;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES)
    throw new Error('Trakt response exceeded the allowed size');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Trakt returned an invalid response');
  }
}

function requireAppCredentials(
  credentials: TraktTrackerApplicationCredentials
): TraktTrackerApplicationCredentials {
  const clientId = credentials.clientId.trim();
  const clientSecret = credentials.clientSecret.trim();
  const redirectUri = credentials.redirectUri.trim();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Enter this AIOStreams configuration’s Trakt app client ID, secret, and redirect URI');
  }
  if (clientId.length > 512 || clientSecret.length > 2048 || redirectUri.length > 2048) {
    throw new Error('Trakt app credentials exceed the allowed length');
  }
  if (redirectUri !== 'urn:ietf:wg:oauth:2.0:oob') {
    let parsed: URL;
    try {
      parsed = new URL(redirectUri);
    } catch {
      throw new Error('Trakt redirect URI must be HTTPS or the supported OOB URI');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw new Error('Trakt redirect URI must be HTTPS or the supported OOB URI');
    }
  }
  return { clientId, clientSecret, redirectUri };
}

export async function requestTraktDeviceCode(
  applicationCredentials: TraktTrackerApplicationCredentials,
  fetchImpl: typeof fetch = fetch
): Promise<TraktDeviceCode> {
  const credentials = requireAppCredentials(applicationCredentials);
  const response = await fetchImpl(`${API_ORIGIN}/oauth/device/code`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: credentials.clientId }),
    signal: AbortSignal.timeout(12_000),
    redirect: 'error',
  });
  const data = object(await readJsonResponse(response));
  const deviceCode = stringField(data, 'device_code');
  const userCode = stringField(data, 'user_code');
  const verificationUri = stringField(data, 'verification_url', 'verification_uri');
  if (!response.ok || !deviceCode || !userCode || !verificationUri)
    throw new Error('Trakt could not start device authorization');
  let url: URL;
  try {
    url = new URL(verificationUri);
  } catch {
    throw new Error('Trakt returned an invalid verification URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'trakt.tv' ||
    (url.pathname !== '/activate' && !url.pathname.startsWith('/activate/'))
  )
    throw new Error('Trakt returned an untrusted verification URL');
  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresIn: seconds(data.expires_in, 600, 1800),
    interval: seconds(data.interval, 5, 60),
  };
}

export async function pollTraktDeviceToken(
  deviceCode: string,
  applicationCredentials: TraktTrackerApplicationCredentials,
  fetchImpl: typeof fetch = fetch
): Promise<TraktDevicePoll> {
  const credentials = requireAppCredentials(applicationCredentials);
  if (!deviceCode.trim() || deviceCode.length > 512)
    throw new Error('Invalid Trakt device code');
  const response = await fetchImpl(`${API_ORIGIN}/oauth/device/token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      code: deviceCode,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    }),
    signal: AbortSignal.timeout(12_000),
    redirect: 'error',
  });
  const data = object(await readJsonResponse(response));
  if (response.status === 400 && stringField(data, 'error') === 'authorization_pending')
    return { status: 'pending', retryAfter: seconds(data.interval, 5, 60) };
  if (response.status === 429)
    return { status: 'pending', retryAfter: Math.min(60, seconds(data.interval, 10, 60)) };
  const accessToken = stringField(data, 'access_token');
  const refreshToken = stringField(data, 'refresh_token');
  if (!response.ok || !accessToken || !refreshToken)
    throw new Error('Trakt device authorization failed, expired, or was denied');
  return {
    status: 'authorized',
    token: {
      accessToken,
      refreshToken,
      tokenExpiresAt: Date.now() + seconds(data.expires_in, 604_800, 604_800) * 1000,
    },
  };
}

const tokenStore = Cache.getInstance<string, string>(
  'trakt-tracker-oauth',
  10_000,
  'sql'
);
const refreshInFlight = new Map<string, Promise<TraktTrackerToken>>();

async function saveTokenAtReference(
  reference: string,
  token: TraktTrackerToken
): Promise<void> {
  const encrypted = encryptString(JSON.stringify(token));
  if (!encrypted.success || !encrypted.data)
    throw new Error('Unable to protect the Trakt account token');
  await tokenStore.set(reference, encrypted.data, TOKEN_TTL_SECONDS, true);
}

export async function storeTraktToken(
  token: TraktTrackerToken,
  applicationCredentials: TraktTrackerApplicationCredentials,
  reference = randomUUID()
): Promise<string> {
  await saveTokenAtReference(reference, {
    ...token,
    applicationCredentials: requireAppCredentials(applicationCredentials),
  });
  return reference;
}

async function resolveToken(reference: string): Promise<TraktTrackerToken> {
  if (!/^[0-9a-f-]{36}$/i.test(reference))
    throw new Error('Invalid Trakt account reference');
  const value = await tokenStore.get(reference, true);
  if (!value) throw new Error('Trakt account link expired or was removed');
  const decrypted = decryptString(value);
  if (!decrypted.success || !decrypted.data)
    throw new Error('Stored Trakt account link could not be decrypted');
  const data = object(JSON.parse(decrypted.data));
  const accessToken = stringField(data, 'accessToken');
  const refreshToken = stringField(data, 'refreshToken');
  const tokenExpiresAt = Number(data.tokenExpiresAt);
  const application = object(data.applicationCredentials);
  const clientId = stringField(application, 'clientId');
  const clientSecret = stringField(application, 'clientSecret');
  const redirectUri = stringField(application, 'redirectUri');
  if (!accessToken || !refreshToken || !Number.isFinite(tokenExpiresAt))
    throw new Error('Stored Trakt account link is invalid');
  return {
    accessToken,
    refreshToken,
    tokenExpiresAt,
    ...(clientId && clientSecret && redirectUri
      ? { applicationCredentials: { clientId, clientSecret, redirectUri } }
      : {}),
  };
}

async function refreshToken(
  reference: string,
  token: TraktTrackerToken,
  fetchImpl: typeof fetch
): Promise<TraktTrackerToken> {
  const active = refreshInFlight.get(reference);
  if (active) return active;
  const refreshing = (async () => {
    const credentials = token.applicationCredentials;
    if (!credentials) throw new Error('Trakt app credentials are missing for this configuration; relink Trakt');
    const validCredentials = requireAppCredentials(credentials);
    const response = await fetchImpl(`${API_ORIGIN}/oauth/token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        refresh_token: token.refreshToken,
        client_id: validCredentials.clientId,
        client_secret: validCredentials.clientSecret,
        redirect_uri: validCredentials.redirectUri,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(12_000),
      redirect: 'error',
    });
    const data = object(await readJsonResponse(response));
    const accessToken = stringField(data, 'access_token');
    const refresh = stringField(data, 'refresh_token');
    if (!response.ok || !accessToken || !refresh)
      throw new Error('Trakt authorization expired; relink the account');
    const next: TraktTrackerToken = {
      accessToken,
      refreshToken: refresh,
      tokenExpiresAt: Date.now() + seconds(data.expires_in, 604_800, 604_800) * 1000,
      applicationCredentials: validCredentials,
    };
    await saveTokenAtReference(reference, next);
    return next;
  })().finally(() => {
    if (refreshInFlight.get(reference) === refreshing)
      refreshInFlight.delete(reference);
  });
  refreshInFlight.set(reference, refreshing);
  return refreshing;
}

export async function requestTraktApi(
  reference: string,
  path: string,
  init: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown } = {},
  fetchImpl: typeof fetch = fetch
): Promise<{ data: unknown; headers: Headers }> {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('://'))
    throw new Error('Invalid Trakt API path');
  let token = await resolveToken(reference);
  const credentials = token.applicationCredentials;
  if (!credentials) throw new Error('Trakt app credentials are missing for this configuration; relink Trakt');
  const validCredentials = requireAppCredentials(credentials);
  if (token.tokenExpiresAt <= Date.now() + 60_000)
    token = await refreshToken(reference, token, fetchImpl);
  const perform = async (current: TraktTrackerToken) => {
    const response = await fetchImpl(`${API_ORIGIN}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${current.accessToken}`,
        'trakt-api-key': validCredentials.clientId,
        'trakt-api-version': API_VERSION,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    return { response, data: await readJsonResponse(response) };
  };
  let result = await perform(token);
  if (result.response.status === 401) {
    const latest = await resolveToken(reference);
    token = latest.accessToken !== token.accessToken
      ? latest
      : await refreshToken(reference, token, fetchImpl);
    result = await perform(token);
  }
  if (!result.response.ok)
    throw new Error(`Trakt API request failed (${result.response.status})`);
  return { data: result.data, headers: result.response.headers };
}

export async function removeTraktToken(reference: string): Promise<void> {
  if (/^[0-9a-f-]{36}$/i.test(reference)) await tokenStore.delete(reference);
}
