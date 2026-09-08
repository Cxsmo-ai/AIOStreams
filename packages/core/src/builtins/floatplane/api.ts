import {
  createHash,
  createPrivateKey,
  createSign,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { decryptString, encryptString } from '../../utils/crypto.js';
import { Cache } from '../../utils/cache.js';

type Json = Record<string, any>;
type JsonValue = unknown;
type Jwk = Record<string, unknown>;

export interface FloatplaneAuthState {
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  refreshTokenExpiresAt?: number;
  dpopPrivateJwk: Jwk;
  dpopPublicJwk: Jwk;
  tokenEndpoint: string;
  issuer: string;
  dpopNonce?: string;
}

export interface FloatplaneDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
  auth: FloatplaneAuthState;
  codeVerifier: string;
}

const authBase = 'https://auth.floatplane.com';
const issuer = `${authBase}/realms/floatplane`;
const clientId = 'fp-tv-app';
const apiBase = 'https://www.floatplane.com';

function record(value: unknown): Json {
  return value && typeof value === 'object' ? (value as Json) : {};
}
function first(value: unknown, ...keys: string[]): any {
  const input = record(value);
  for (const key of keys)
    if (input[key] !== undefined && input[key] !== null) return input[key];
  return undefined;
}
function array(value: unknown): Json[] {
  if (Array.isArray(value)) return value.map(record);
  const input = record(value);
  for (const key of [
    'items',
    'data',
    'results',
    'searchResults',
    'hits',
    'documents',
    'entries',
    'blogPosts',
    'contentItems',
    'creators',
    'channels',
    'posts',
    'content',
    'variants',
    'sources',
    'streams',
  ]) {
    if (Array.isArray(input[key])) return input[key].map(record);
    if (input[key] && typeof input[key] === 'object') {
      const nested = array(input[key]);
      if (nested.length) return nested;
    }
  }
  return [];
}
function url(value: unknown, base = apiBase): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  return /^https?:\/\//i.test(value)
    ? value
    : `${base.replace(/\/$/, '')}${value.startsWith('/') ? '' : '/'}${value}`;
}

async function jsonFetch(
  endpoint: string,
  init: RequestInit = {}
): Promise<JsonValue> {
  const response = await fetch(endpoint, {
    ...init,
    headers: { Accept: 'application/json', ...(init.headers || {}) },
  });
  const text = await response.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok)
    throw new Error(`Floatplane request failed (${response.status})`);
  return data;
}
async function discovery(): Promise<Json> {
  return record(await jsonFetch(`${issuer}/.well-known/openid-configuration`));
}
function dpopKeys() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    privateJwk: pair.privateKey.export({ format: 'jwk' }) as Jwk,
    publicJwk: pair.publicKey.export({ format: 'jwk' }) as Jwk,
  };
}
function pkceVerifier(): string {
  return randomBytes(32).toString('base64url');
}
function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
function dpopProof(
  auth: FloatplaneAuthState,
  method: string,
  endpoint: string,
  accessToken?: string
): string {
  const enc = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload: Json = {
    htu: endpoint.split('?')[0],
    htm: method.toUpperCase(),
    iat: Math.floor(Date.now() / 1000),
    jti: randomUUID(),
  };
  if (auth.dpopNonce) payload.nonce = auth.dpopNonce;
  if (accessToken) {
    payload.ath = createHash('sha256').update(accessToken).digest('base64url');
  }
  const input = `${enc({ typ: 'dpop+jwt', alg: 'ES256', jwk: auth.dpopPublicJwk })}.${enc(payload)}`;
  const signer = createSign('SHA256');
  signer.update(input);
  signer.end();
  const signature = signer
    .sign({
      key: createPrivateKey({ key: auth.dpopPrivateJwk as any, format: 'jwk' }),
      dsaEncoding: 'ieee-p1363',
    })
    .toString('base64url');
  return `${input}.${signature}`;
}

export function encodeFloatplaneAuth(auth: FloatplaneAuthState): string {
  const result = encryptString(JSON.stringify(auth));
  if (!result.success) throw new Error(result.error);
  return result.data;
}
export function decodeFloatplaneAuth(value: string): FloatplaneAuthState {
  const result = decryptString(value);
  if (!result.success) throw new Error('Invalid Floatplane link token');
  return JSON.parse(result.data) as FloatplaneAuthState;
}
const authStore = Cache.getInstance<string, string>(
  'floatplane-auth',
  10000,
  'sql'
);
export async function storeFloatplaneAuth(
  auth: FloatplaneAuthState
): Promise<string> {
  const reference = randomUUID();
  await authStore.set(
    reference,
    encodeFloatplaneAuth(auth),
    365 * 24 * 60 * 60
  );
  return reference;
}
export async function resolveFloatplaneAuth(
  reference: string
): Promise<FloatplaneAuthState> {
  const encrypted = await authStore.get(reference, true);
  if (!encrypted) throw new Error('Floatplane link expired or is not valid');
  return decodeFloatplaneAuth(encrypted);
}

export async function requestFloatplaneDeviceAuthorization(): Promise<FloatplaneDeviceAuthorization> {
  const config = await discovery();
  const verifier = pkceVerifier();
  const keys = dpopKeys();
  const endpoint = first(
    config,
    'device_authorization_endpoint',
    'device_authorization'
  );
  if (typeof endpoint !== 'string')
    throw new Error('Floatplane device authorization is unavailable');
  const body = new URLSearchParams({
    client_id: clientId,
    code_challenge_method: 'S256',
    code_challenge: pkceChallenge(verifier),
  });
  const response = await jsonFetch(endpoint, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const tokenEndpoint = first(config, 'token_endpoint');
  if (typeof tokenEndpoint !== 'string')
    throw new Error('Floatplane token endpoint is unavailable');
  return {
    deviceCode: String(first(response, 'device_code', 'deviceCode')),
    userCode: String(first(response, 'user_code', 'userCode')),
    verificationUri: String(
      first(response, 'verification_uri', 'verification_url', 'verificationUri')
    ),
    verificationUriComplete: first(
      response,
      'verification_uri_complete',
      'verificationUriComplete'
    ),
    expiresIn: Number(first(response, 'expires_in', 'expiresIn') || 600),
    interval: Number(first(response, 'interval') || 5),
    codeVerifier: verifier,
    auth: {
      accessToken: '',
      dpopPrivateJwk: keys.privateJwk,
      dpopPublicJwk: keys.publicJwk,
      tokenEndpoint,
      issuer,
    },
  };
}

export type FloatplaneTokenPoll =
  | { status: 'pending'; retryAfter: number }
  | { status: 'authorized'; auth: FloatplaneAuthState };
export async function pollFloatplaneDeviceAuthorization(
  device: FloatplaneDeviceAuthorization
): Promise<FloatplaneTokenPoll> {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: device.deviceCode,
    code_verifier: device.codeVerifier,
    client_id: clientId,
  });
  const response = await fetch(device.auth.tokenEndpoint, {
    method: 'POST',
    body,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      DPoP: dpopProof(device.auth, 'POST', device.auth.tokenEndpoint),
    },
  });
  const text = await response.text();
  let data: Json = {};
  try {
    data = record(text ? JSON.parse(text) : {});
  } catch {
    data = {};
  }
  const nonce = response.headers.get('DPoP-Nonce');
  if (nonce) device.auth.dpopNonce = nonce;
  if (!response.ok) {
    const error = String(first(data, 'error') || '');
    if (error === 'authorization_pending' || error === 'slow_down')
      return {
        status: 'pending',
        retryAfter:
          error === 'slow_down' ? device.interval + 5 : device.interval,
      };
    throw new Error(
      `Floatplane authorization failed (${error || response.status})`
    );
  }
  return {
    status: 'authorized',
    auth: {
      ...device.auth,
      accessToken: String(first(data, 'access_token', 'accessToken')),
      refreshToken: first(data, 'refresh_token', 'refreshToken'),
      tokenExpiresAt:
        Date.now() +
        Number(first(data, 'expires_in', 'expiresIn') || 300) * 1000,
      refreshTokenExpiresAt:
        Date.now() +
        Number(first(data, 'refresh_expires_in') || 2592000) * 1000,
    },
  };
}

export class FloatplaneClient {
  private refreshInFlight?: Promise<void>;

  constructor(private readonly auth: FloatplaneAuthState) {}
  private async refresh(force = false) {
    if (
      !force &&
      (!this.auth.refreshToken ||
        (this.auth.tokenExpiresAt &&
          this.auth.tokenExpiresAt > Date.now() + 30000))
    )
      return;
    const refreshToken = this.auth.refreshToken;
    if (!refreshToken) return;

    // Device-linked sessions may rotate their refresh token. Catalog and
    // metadata requests are intentionally concurrent, so make refresh a
    // single-flight operation or two requests near expiry can race with the
    // same token and invalidate each other's session.
    if (this.refreshInFlight) {
      await this.refreshInFlight;
      return;
    }

    const refreshTask = (async () => {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      });
      const response = await fetch(this.auth.tokenEndpoint, {
        method: 'POST',
        body,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          DPoP: dpopProof(this.auth, 'POST', this.auth.tokenEndpoint),
        },
      });
      const nonce = response.headers.get('DPoP-Nonce');
      if (nonce) this.auth.dpopNonce = nonce;
      const data = record(await response.json());
      if (!response.ok || !first(data, 'access_token'))
        throw new Error('Floatplane session expired; link the account again');
      this.auth.accessToken = String(first(data, 'access_token'));
      this.auth.refreshToken =
        first(data, 'refresh_token') || this.auth.refreshToken;
      this.auth.tokenExpiresAt =
        Date.now() + Number(first(data, 'expires_in') || 300) * 1000;
    })();
    this.refreshInFlight = refreshTask;
    try {
      await refreshTask;
    } finally {
      if (this.refreshInFlight === refreshTask)
        this.refreshInFlight = undefined;
    }
  }
  async request(path: string, init: RequestInit = {}): Promise<JsonValue> {
    await this.refresh();
    const endpoint = path.startsWith('http') ? path : `${apiBase}${path}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const accessTokenBeforeRequest = this.auth.accessToken;
      const response = await fetch(endpoint, {
        ...init,
        headers: {
          Accept: 'application/json',
          ...(init.headers || {}),
          Authorization: `DPoP ${this.auth.accessToken}`,
          DPoP: dpopProof(
            this.auth,
            init.method || 'GET',
            endpoint,
            this.auth.accessToken
          ),
        },
      });
      const text = await response.text();
      let data: any = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }
      const retryableAuthFailure =
        attempt === 0 &&
        Boolean(this.auth.refreshToken) &&
        [401, 403, 404].includes(response.status);
      if (response.ok) return data;
      if (retryableAuthFailure) {
        const nonce = response.headers.get('DPoP-Nonce');
        if (nonce) this.auth.dpopNonce = nonce;
        try {
          // Another concurrent request may already have refreshed the token.
          // Reuse that new token instead of rotating the refresh token again.
          if (this.auth.accessToken === accessTokenBeforeRequest)
            await this.refresh(true);
          continue;
        } catch {
          // Keep the original API failure when the refresh token is also
          // rejected; the caller can request a fresh device link.
        }
      }
      throw new Error(`Floatplane API request failed (${response.status})`);
    }
    throw new Error('Floatplane API request failed');
  }
  subscriptions() {
    return this.request('/api/v3/user/subscriptions');
  }
  creatorInfo(creatorId: string) {
    return this.request(
      `/api/v3/creator/info?${new URLSearchParams({ id: creatorId })}`
    );
  }
  discover() {
    return this.request('/api/v3/creator/discover');
  }
  channels(creatorId: string) {
    return this.request(
      `/api/v3/creator/channels/list?${new URLSearchParams({ ids: creatorId })}`
    );
  }
  creatorContent(
    creatorId: string,
    channelId?: string,
    fetchAfter = 0,
    limit = 20,
    search?: string
  ) {
    const query = new URLSearchParams({
      id: creatorId,
      limit: String(Math.min(20, Math.max(1, limit))),
      fetchAfter: String(Math.max(0, fetchAfter)),
      sort: 'DESC',
      hasVideo: 'true',
    });
    if (channelId) query.set('channel', channelId);
    if (search?.trim()) query.set('search', search.trim());
    return this.request(`/api/v3/content/creator?${query}`);
  }
  async search(query: string) {
    const text = query.trim();
    if (!text) return [];
    // Prefer the dedicated endpoint, but keep the creator search fallback for
    // current accounts where the endpoint returns an empty envelope. The
    // creator endpoint is part of the stable v3 API and supports the search
    // parameter with the same authenticated entitlements.
    for (const parameter of ['text', 'search', 'query', 'q']) {
      try {
        const response = await this.request(
          `/api/v3/content/search?${new URLSearchParams({ [parameter]: text })}`
        );
        if (array(response).length) return response;
      } catch {
        // Try the next current-account parameter spelling.
      }
    }
    const subscriptions = array(await this.subscriptions());
    const creatorIds = [
      ...new Set(
        subscriptions
          .map((item) => first(item, 'creator', 'creatorId'))
          .map((value) =>
            value && typeof value === 'object'
              ? first(value, 'id', 'guid')
              : value
          )
          .map((value) => String(value || ''))
          .filter(Boolean)
      ),
    ];
    const pages = await Promise.all(
      creatorIds.map((creatorId) =>
        this.creatorContent(creatorId, undefined, 0, 20, text)
      )
    );
    const searched = pages.flatMap((page) => array(page));
    if (searched.length) return searched;

    // Some accounts silently ignore the search filter. Fetch only a bounded
    // two-page window per subscribed creator and filter locally as a reliable
    // final fallback; this avoids an unbounded account crawl on every search.
    const windowPages = await Promise.all(
      creatorIds.flatMap((creatorId) =>
        [0, 20].map((fetchAfter) =>
          this.creatorContent(creatorId, undefined, fetchAfter, 20)
        )
      )
    );
    const needle = text.toLocaleLowerCase();
    const seen = new Set<string>();
    return windowPages
      .flatMap((page) => array(page))
      .filter((item) => {
        const value = JSON.stringify(item).toLocaleLowerCase();
        const id = String(first(item, 'id', 'guid', 'contentId') || value);
        if (!value.includes(needle) || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
  }
  post(postId: string) {
    return this.request(
      `/api/v3/content/post?${new URLSearchParams({ id: postId })}`
    );
  }
  video(videoId: string) {
    return this.request(
      `/api/v3/content/video?${new URLSearchParams({ id: videoId })}`
    );
  }
  async delivery(contentId: string, outputKind = 'hls.fmp4') {
    try {
      return await this.request(
        `/api/v3/delivery/info?${new URLSearchParams({
          entityId: contentId,
          scenario: 'onDemand',
          outputKind,
        })}`
      );
    } catch {
      return this.request(
        `/api/v2/cdn/delivery?type=vod&guid=${encodeURIComponent(contentId)}`
      );
    }
  }
  textTracks(contentId: string) {
    return this.video(contentId);
  }
}
export { array, first, url };
