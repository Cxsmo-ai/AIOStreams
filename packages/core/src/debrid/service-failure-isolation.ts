import { createHash } from 'node:crypto';
import type { ServiceId } from '../utils/constants.js';
import { DebridError, type DebridService } from './base.js';

interface OpenCircuit {
  expiresAt: number;
  message: string;
  statusCode: number;
  statusText: string;
  code?: DebridError['code'];
}

const openCircuits = new Map<string, OpenCircuit>();
const healthyCredentials = new Map<string, number>();
const credentialProbes = new Map<string, Promise<void>>();

const AUTH_FAILURE_TTL_MS = 5 * 60_000;
const UPSTREAM_FAILURE_TTL_MS = 60_000;
const RATE_LIMIT_TTL_MS = 60_000;
const HEALTHY_CREDENTIAL_TTL_MS = 5 * 60_000;

function fingerprintCredential(credential: string): string {
  return createHash('sha256').update(credential).digest('hex').slice(0, 24);
}

function circuitKey(serviceId: ServiceId, credential: string): string {
  return `${serviceId}:${fingerprintCredential(credential)}`;
}

function errorStatus(error: unknown): number | undefined {
  if (error instanceof DebridError) return error.statusCode;
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  if (typeof candidate.statusCode === 'number') return candidate.statusCode;
  if (typeof candidate.status === 'number') return candidate.status;
  return undefined;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === 'string' ? value.toUpperCase() : undefined;
}

function retryAfterMs(error: unknown): number | undefined {
  if (!(error instanceof DebridError)) return undefined;
  const value = error.headers['retry-after'] ?? error.headers['Retry-After'];
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function failureTtl(error: unknown): number | undefined {
  const status = errorStatus(error);
  const code = errorCode(error);
  if (
    status === 401 ||
    status === 403 ||
    [
      'UNAUTHORIZED',
      'FORBIDDEN',
      'AUTH_ERROR',
      'BAD_TOKEN',
      'NO_AUTH',
      'OAUTH_VERIFICATION_ERROR',
    ].includes(code ?? '')
  ) {
    return AUTH_FAILURE_TTL_MS;
  }
  // Rate limits are transient throughput throttles; do not trip the global circuit breaker
  if (
    [502, 503, 504].includes(status ?? 0) ||
    ['BAD_GATEWAY', 'SERVICE_UNAVAILABLE'].includes(code ?? '')
  ) {
    return Math.max(retryAfterMs(error) ?? UPSTREAM_FAILURE_TTL_MS, 1000);
  }
  return undefined;
}

function snapshotFailure(error: unknown, ttl: number): OpenCircuit {
  const statusCode = errorStatus(error) ?? 503;
  return {
    expiresAt: Date.now() + ttl,
    message: error instanceof Error ? error.message : String(error),
    statusCode,
    statusText:
      error instanceof DebridError ? error.statusText : 'Service Unavailable',
    code:
      error instanceof DebridError
        ? error.code
        : statusCode === 401
          ? 'UNAUTHORIZED'
          : statusCode === 403
            ? 'FORBIDDEN'
            : statusCode === 429
              ? 'TOO_MANY_REQUESTS'
              : statusCode === 503
                ? 'SERVICE_UNAVAILABLE'
                : statusCode === 502
                  ? 'BAD_GATEWAY'
                  : 'UNKNOWN',
  };
}

function getOpenCircuit(key: string): OpenCircuit | undefined {
  const state = openCircuits.get(key);
  if (!state) return undefined;
  if (state.expiresAt <= Date.now()) {
    openCircuits.delete(key);
    return undefined;
  }
  return state;
}

/**
 * Prevents one known-bad TorBox credential or a short TorBox outage from
 * blocking every addon that is also resolving through another healthy
 * service. The key includes a one-way credential fingerprint, so replacing
 * the credential immediately gets a fresh circuit.
 */
export async function withServiceFailureIsolation<T>(
  serviceId: ServiceId,
  credential: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = circuitKey(serviceId, credential);
  const existing = getOpenCircuit(key);
  if (existing) {
    throw new DebridError(
      `${serviceId} temporarily skipped after a recent service failure: ${existing.message}`,
      {
        statusCode: existing.statusCode,
        statusText: existing.statusText,
        code: existing.code,
        headers: {},
        body: null,
        type: 'upstream_error',
      }
    );
  }

  try {
    const result = await operation();
    openCircuits.delete(key);
    return result;
  } catch (error) {
    const ttl = failureTtl(error);
    if (ttl !== undefined) {
      healthyCredentials.delete(key);
      openCircuits.set(key, snapshotFailure(error, ttl));
    }
    throw error;
  }
}

async function ensureCredentialHealthy(
  serviceId: ServiceId,
  credential: string,
  probe: () => Promise<unknown>
): Promise<void> {
  const key = circuitKey(serviceId, credential);
  const healthyUntil = healthyCredentials.get(key) ?? 0;
  if (healthyUntil > Date.now()) return;

  const pending = credentialProbes.get(key);
  if (pending) return pending;

  const probePromise = withServiceFailureIsolation(
    serviceId,
    credential,
    async () => {
      await probe();
      healthyCredentials.set(key, Date.now() + HEALTHY_CREDENTIAL_TTL_MS);
    }
  ).finally(() => credentialProbes.delete(key));
  credentialProbes.set(key, probePromise);
  return probePromise;
}

/** Wrap every public call on a service while retaining its original shape. */
export function isolateDebridService<T extends DebridService>(
  service: T,
  serviceId: ServiceId,
  credential: string,
  options?: { credentialProbe?: () => Promise<unknown> }
): T {
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        if (options?.credentialProbe) {
          await ensureCredentialHealthy(
            serviceId,
            credential,
            options.credentialProbe
          );
        }
        return withServiceFailureIsolation(serviceId, credential, () =>
          Reflect.apply(value, target, args)
        );
      };
    },
  });
}

export function resetServiceFailureIsolationForTests(): void {
  openCircuits.clear();
  healthyCredentials.clear();
  credentialProbes.clear();
}
