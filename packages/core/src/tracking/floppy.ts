import { randomUUID } from 'node:crypto';
import { Cache } from '../utils/cache.js';
import { decryptString, encryptString } from '../utils/crypto.js';
import { makeRequest } from '../utils/http.js';
import { isUnsafeRemoteUrl } from '../utils/url-safety.js';

const TOKEN_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const API_PREFIX = '/api/v1/';

export type FloppyAccount = {
  baseUrl: string;
  apiToken: string;
};

export type FloppyApiRequest = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
};

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

/** Canonicalizes a self-hosted base URL and blocks local/private literal hosts. */
export function normalizeFloppyBaseUrl(value: string): string {
  const input = value.trim();
  if (!input || input.length > 2048)
    throw new Error('Enter a valid Floppy server URL');
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('Enter a valid Floppy server URL');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    isUnsafeRemoteUrl(parsed.toString()) ||
    parsed.hostname.toLowerCase().endsWith('.local') ||
    parsed.hostname.toLowerCase().endsWith('.internal')
  ) {
    throw new Error('Floppy must use a public HTTPS server URL without embedded credentials');
  }
  const pathname = parsed.pathname.replace(/\/+$/, '');
  if (pathname.split('/').some((part) => part === '.' || part === '..'))
    throw new Error('Invalid Floppy server URL path');
  return `${parsed.origin}${pathname}`;
}

function validateApiPath(path: string): string {
  if (
    !path.startsWith(API_PREFIX) ||
    path.length > 2048 ||
    /[\\\u0000-\u001f]/.test(path) ||
    path.split(/[/?#]/).includes('..')
  ) {
    throw new Error('Invalid Floppy API path');
  }
  return path;
}

async function readJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('Floppy response exceeded the allowed size');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES)
    throw new Error('Floppy response exceeded the allowed size');
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Floppy returned an invalid JSON response');
  }
}

async function callFloppy(
  account: FloppyAccount,
  path: string,
  init: FloppyApiRequest = {}
): Promise<{ data: unknown; headers: Headers; status: number }> {
  const safePath = validateApiPath(path);
  const url = `${normalizeFloppyBaseUrl(account.baseUrl)}${safePath}`;
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-api-key': account.apiToken,
  };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  const response = await makeRequest(url, {
    timeout: 12_000,
    method,
    headers,
    body,
    rawOptions: { redirect: 'error' },
  });
  const data = await readJson(response);
  if (!response.ok)
    throw new Error(`Floppy API request failed (${response.status})`);
  return { data, headers: new Headers(response.headers), status: response.status };
}

const tokenStore = Cache.getInstance<string, string>(
  'floppy-tracker-api-token',
  10_000,
  'sql'
);

async function saveAccount(reference: string, account: FloppyAccount) {
  const encrypted = encryptString(JSON.stringify(account));
  if (!encrypted.success || !encrypted.data)
    throw new Error('Unable to protect the Floppy API token');
  await tokenStore.set(reference, encrypted.data, TOKEN_TTL_SECONDS, true);
}

/** Validate a Floppy API token before encrypting it in the server-side token store. */
export async function storeFloppyAccount(
  baseUrl: string,
  apiToken: string,
  reference = randomUUID(),
  call: typeof callFloppy = callFloppy
): Promise<string> {
  const normalizedBaseUrl = normalizeFloppyBaseUrl(baseUrl);
  const token = apiToken.trim();
  if (!token || token.length > 4096 || /[\r\n\u0000]/.test(token))
    throw new Error('Enter a valid Floppy API token');
  await call(
    { baseUrl: normalizedBaseUrl, apiToken: token },
    '/api/v1/user/preferences/'
  );
  await saveAccount(reference, { baseUrl: normalizedBaseUrl, apiToken: token });
  return reference;
}

export async function resolveFloppyAccount(
  reference: string
): Promise<FloppyAccount> {
  if (!/^[0-9a-f-]{36}$/i.test(reference))
    throw new Error('Invalid Floppy account reference');
  const encrypted = await tokenStore.get(reference, true);
  if (!encrypted)
    throw new Error('Floppy account link expired or was removed');
  const decrypted = decryptString(encrypted);
  if (!decrypted.success || !decrypted.data)
    throw new Error('Stored Floppy API token could not be decrypted');
  let parsed: JsonObject;
  try {
    parsed = object(JSON.parse(decrypted.data));
  } catch {
    throw new Error('Stored Floppy account link is invalid');
  }
  const baseUrl = typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '';
  const apiToken = typeof parsed.apiToken === 'string' ? parsed.apiToken : '';
  if (!baseUrl || !apiToken)
    throw new Error('Stored Floppy account link is invalid');
  return { baseUrl: normalizeFloppyBaseUrl(baseUrl), apiToken };
}

export async function requestFloppyApi(
  reference: string,
  path: string,
  init: FloppyApiRequest = {}
): Promise<{ data: unknown; headers: Headers }> {
  const account = await resolveFloppyAccount(reference);
  const { data, headers } = await callFloppy(account, path, init);
  return { data, headers };
}

export async function removeFloppyAccount(reference: string): Promise<void> {
  if (/^[0-9a-f-]{36}$/i.test(reference)) await tokenStore.delete(reference);
}

/** Exported for focused transport tests; callers must not log the account. */
export const floppyApiInternals = { callFloppy, validateApiPath };
