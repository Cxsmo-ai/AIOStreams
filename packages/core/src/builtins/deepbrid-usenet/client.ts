import { createHash, createHmac, randomBytes } from 'node:crypto';
import pLimit, { type LimitFunction } from 'p-limit';
import { Response as UndiciResponse } from 'undici';
import { z } from 'zod';
import { createLogger, makeRequest } from '../../utils/index.js';
import {
  DeepbridFinderResponseCache,
  isDeepbridRateLimitError,
} from './finder-response-cache.js';

const logger = createLogger('deepbrid-finder-client');

const finderSearchResponseCache = new DeepbridFinderResponseCache<
  Record<string, unknown>
>({
  freshMs: 15_000,
  staleMs: 120_000,
  maxEntries: 512,
});

interface InflightFinderSearch {
  controller: AbortController;
  promise: Promise<Record<string, unknown>>;
  subscribers: number;
  settled: boolean;
}

const inflightFinderSearches = new Map<string, InflightFinderSearch>();
const MAX_INFLIGHT_FINDER_SEARCHES = 256;

function inflightFinderSearchKey(
  apiKey: string,
  path: string,
  clientTimeoutMs: number
): string {
  // Keep credentials and signed query paths out of the in-memory map keys.
  return createHash('sha256')
    .update(apiKey)
    .update('\0')
    .update(path)
    .update('\0')
    .update(String(clientTimeoutMs))
    .digest('hex');
}

function subscribeToInflightFinderSearch(
  key: string,
  entry: InflightFinderSearch,
  signal?: AbortSignal,
  deadlineAtMs?: number
): Promise<Record<string, unknown>> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException('Aborted', 'AbortError')
    );
  }

  entry.subscribers++;
  return new Promise((resolve, reject) => {
    let released = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const release = (cancelled: boolean): boolean => {
      if (released) return false;
      released = true;
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      signal?.removeEventListener('abort', onAbort);
      entry.subscribers = Math.max(0, entry.subscribers - 1);
      if (cancelled && !entry.settled && entry.subscribers === 0) {
        if (inflightFinderSearches.get(key) === entry) {
          inflightFinderSearches.delete(key);
        }
        entry.controller.abort(new DOMException('Aborted', 'AbortError'));
      }
      return true;
    };
    const onAbort = () => {
      if (!release(true)) return;
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    if (deadlineAtMs !== undefined && Number.isFinite(deadlineAtMs)) {
      const remainingMs = deadlineAtMs - Date.now();
      if (remainingMs <= 0) {
        if (release(true)) {
          reject(
            new DeepbridApiError(
              'Deepbrid Finder deadline expired before the shared result arrived.',
              undefined,
              'retry-exhausted',
              undefined,
              'wrapper_budget_before_attempt'
            )
          );
        }
        return;
      }
      deadlineTimer = setTimeout(
        () => {
          if (release(true)) {
            reject(
              new DeepbridApiError(
                'Deepbrid Finder deadline expired before the shared result arrived.',
                undefined,
                'retry-exhausted',
                undefined,
                'wrapper_budget_before_attempt'
              )
            );
          }
        },
        Math.min(remainingMs, 2_147_483_647)
      );
    }
    entry.promise.then(
      (value) => {
        if (release(false)) resolve(structuredClone(value));
      },
      (error: unknown) => {
        if (release(false)) reject(error);
      }
    );
  });
}

export const DEEPBRID_API_BASE = 'https://www.deepbrid.com/api/v1';
export const DEEPBRID_FINDER_USER_AGENT =
  'Deepbrid/1.0 (ios) DBX/AxkHbkTtYiXSijpzcRE5vGe73HK7qqrinpEz';
export const DEEPBRID_AIOSTREAMS_USER_AGENT = 'AIOStreams Deepbrid integration';

// A single process-wide API gate is shared by Finder searches, Finder content
// lookups, and external-indexer Deepbrid service calls. Per-addon limits alone
// can multiply into bursts when several progressive scrapes overlap.

export type DeepbridFinderRequestKind = 'search' | 'content' | 'other';
type DeepbridTransportFailureClass =
  'aborted' | 'timeout' | 'connection' | 'other';

type TimingSummary = {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
};

export interface DeepbridFinderRequestMetricsSnapshot {
  attempts: number;
  attemptsByKind: Record<DeepbridFinderRequestKind, number>;
  responses: {
    success: number;
    rateLimited: number;
    clientError: number;
    serverError: number;
    other: number;
    transportFailure: number;
  };
  transportFailuresByKind: Record<DeepbridFinderRequestKind, number>;
  transportFailureClasses: Record<DeepbridTransportFailureClass, number>;
  transportRetryAttemptsByKind: Record<DeepbridFinderRequestKind, number>;
  transportRetryRecoveriesByKind: Record<DeepbridFinderRequestKind, number>;
  queueWait: TimingSummary;
  responseHeaders: TimingSummary;
  searchCache: {
    freshHits: number;
    coalescedRequests: number;
    staleRateLimitFallbacks: number;
    coldFetches: number;
    coldFetchFailures: number;
    freshLookup: TimingSummary;
    coldFetch: TimingSummary;
  };
  currentFinderRequestsInRollingMinute: number;
  currentFinderCountIsLowerBound: boolean;
  maxFinderRequestsInRollingMinute: number;
  maxFinderCountIsLowerBound: boolean;
  rateLimit: {
    observations: number;
    latestLimit?: number;
    minimumRemaining?: number;
  };
  advertisedRetryAfter: {
    observations: number;
    totalMs: number;
    maxMs: number;
  };
  actualRetryWait: {
    observations: number;
    totalMs: number;
    maxMs: number;
  };
}

interface RollingMinuteSnapshot {
  currentRequests: number;
  currentIsLowerBound: boolean;
  maxRequests: number;
  maxIsLowerBound: boolean;
}

/** Exact up to the fixed cap. Saturation is reported as a lower bound, never
 * silently presented as an exact rolling-window count. */
export class BoundedRollingMinuteCounter {
  private readonly starts: number[] = [];
  private maxRequests = 0;
  private maxIsLowerBound = false;
  private latestDroppedAt: number | undefined;

  constructor(private readonly cap = METRICS_SAMPLE_CAP) {}

  record(startedAtMs: number): void {
    this.prune(startedAtMs);
    if (this.starts.length >= this.cap) {
      this.latestDroppedAt = this.starts.shift();
      this.maxRequests = Math.max(this.maxRequests, this.cap + 1);
      this.maxIsLowerBound = true;
    }
    this.starts.push(startedAtMs);
    this.maxRequests = Math.max(this.maxRequests, this.starts.length);
  }

  snapshot(nowMs: number): RollingMinuteSnapshot {
    this.prune(nowMs);
    const currentIsLowerBound =
      this.latestDroppedAt !== undefined &&
      nowMs - this.latestDroppedAt < 60_000;
    return {
      currentRequests: this.starts.length + Number(currentIsLowerBound),
      currentIsLowerBound,
      maxRequests: this.maxRequests,
      maxIsLowerBound: this.maxIsLowerBound,
    };
  }

  private prune(nowMs: number): void {
    while (this.starts.length && this.starts[0] <= nowMs - 60_000) {
      this.starts.shift();
    }
  }
}

export interface DeepbridFinderRequestReport extends DeepbridFinderRequestMetricsSnapshot {
  /** Process-local requests through the shared gate for this account key. */
  sharedAccountGate: {
    currentRequestsInRollingMinute: number;
    currentCountIsLowerBound: boolean;
    maxRequestsInRollingMinute: number;
    maxCountIsLowerBound: boolean;
    requestStartLimitPerMinute: number;
    observedProviderLimit?: number;
    cooldownRemainingMs: number;
    queueWait: TimingSummary;
  };
}

const METRICS_SAMPLE_CAP = 4_096;
const API_GATE_MAX_ENTRIES = 512;
const API_GATE_IDLE_TTL_MS = 30 * 60_000;
// Deepbrid currently documents 100 req/min for free and 250 req/min for
// premium accounts. Keep a 25% reserve even before the first response reveals
// the account's X-RateLimit-Limit header, so the safe unknown-tier default is
// 75 req/min rather than the old unauthenticated-IP allowance of 60.
const UNKNOWN_DEEPBRID_REQUESTS_PER_MINUTE = 75;
// Keep a 25% reserve for other clients sharing the account-level quota.
const MAX_DEEPBRID_REQUESTS_PER_MINUTE = 187;

function summarizeTimings(values: readonly number[]): TimingSummary {
  if (!values.length) return { samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number): number =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  return {
    samples: sorted.length,
    p50Ms: Math.round(percentile(0.5)),
    p95Ms: Math.round(percentile(0.95)),
    maxMs: Math.round(sorted[sorted.length - 1]),
  };
}

function finiteHeaderNumber(
  headers: Headers,
  name: string
): number | undefined {
  const raw = headers.get(name);
  if (raw === null || !raw.trim()) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Numeric-only, bounded telemetry for diagnosing Finder completeness and API
 * rate-limit headroom. No request path, query, body, key, or response text is
 * retained or included in snapshots. */
export class DeepbridFinderRequestMetrics {
  private attempts = 0;
  private readonly attemptsByKind: Record<DeepbridFinderRequestKind, number> = {
    search: 0,
    content: 0,
    other: 0,
  };
  private readonly responses = {
    success: 0,
    rateLimited: 0,
    clientError: 0,
    serverError: 0,
    other: 0,
    transportFailure: 0,
  };
  private readonly transportFailuresByKind: Record<
    DeepbridFinderRequestKind,
    number
  > = {
    search: 0,
    content: 0,
    other: 0,
  };
  private readonly transportFailureClasses: Record<
    DeepbridTransportFailureClass,
    number
  > = {
    aborted: 0,
    timeout: 0,
    connection: 0,
    other: 0,
  };
  private readonly transportRetryAttemptsByKind: Record<
    DeepbridFinderRequestKind,
    number
  > = {
    search: 0,
    content: 0,
    other: 0,
  };
  private readonly transportRetryRecoveriesByKind: Record<
    DeepbridFinderRequestKind,
    number
  > = {
    search: 0,
    content: 0,
    other: 0,
  };
  private readonly queueWaitMs: number[] = [];
  private readonly responseHeaderMs: number[] = [];
  private freshSearchCacheHits = 0;
  private coalescedSearchRequests = 0;
  private staleSearchCacheFallbacks = 0;
  private coldSearchFetches = 0;
  private coldSearchFetchFailures = 0;
  private readonly freshSearchCacheLookupMs: number[] = [];
  private readonly coldSearchFetchMs: number[] = [];
  private readonly requestRate = new BoundedRollingMinuteCounter();
  private rateLimitObservations = 0;
  private latestLimit: number | undefined;
  private minimumRemaining: number | undefined;
  private retryAfterObservations = 0;
  private retryAfterTotalMs = 0;
  private retryAfterMaxMs = 0;
  private actualRetryWaitObservations = 0;
  private actualRetryWaitTotalMs = 0;
  private actualRetryWaitMaxMs = 0;

  recordStart(
    kind: DeepbridFinderRequestKind,
    queuedAtMs: number,
    startedAtMs: number
  ): void {
    this.attempts++;
    this.attemptsByKind[kind]++;
    this.pushSample(this.queueWaitMs, Math.max(0, startedAtMs - queuedAtMs));
    this.requestRate.record(startedAtMs);
  }

  recordResponse(status: number, headers: Headers, elapsedMs: number): void {
    this.pushSample(this.responseHeaderMs, Math.max(0, elapsedMs));
    if (status === 429) this.responses.rateLimited++;
    else if (status >= 200 && status < 400) this.responses.success++;
    else if (status >= 400 && status < 500) this.responses.clientError++;
    else if (status >= 500) this.responses.serverError++;
    else this.responses.other++;

    const limit = finiteHeaderNumber(headers, 'x-ratelimit-limit');
    const remaining = finiteHeaderNumber(headers, 'x-ratelimit-remaining');
    if (limit !== undefined || remaining !== undefined) {
      this.rateLimitObservations++;
      if (limit !== undefined) this.latestLimit = limit;
      if (remaining !== undefined) {
        this.minimumRemaining =
          this.minimumRemaining === undefined
            ? remaining
            : Math.min(this.minimumRemaining, remaining);
      }
    }

    const retryAfter = retryAfterMsFromHeaders(headers);
    if (retryAfter !== undefined) {
      this.retryAfterObservations++;
      this.retryAfterTotalMs += retryAfter;
      this.retryAfterMaxMs = Math.max(this.retryAfterMaxMs, retryAfter);
    }
  }

  recordTransportFailure(
    kind: DeepbridFinderRequestKind,
    error: unknown
  ): void {
    this.responses.transportFailure++;
    this.transportFailuresByKind[kind]++;
    this.transportFailureClasses[classifyTransportFailure(error)]++;
  }

  recordTransportRetry(
    kind: DeepbridFinderRequestKind,
    recovered: boolean
  ): void {
    if (recovered) this.transportRetryRecoveriesByKind[kind]++;
    else this.transportRetryAttemptsByKind[kind]++;
  }

  recordRetryWait(elapsedMs: number): void {
    const waitMs = Math.max(0, elapsedMs);
    this.actualRetryWaitObservations++;
    this.actualRetryWaitTotalMs += waitMs;
    this.actualRetryWaitMaxMs = Math.max(this.actualRetryWaitMaxMs, waitMs);
  }

  recordFreshSearchCacheHit(elapsedMs: number): void {
    this.freshSearchCacheHits++;
    this.pushSample(this.freshSearchCacheLookupMs, Math.max(0, elapsedMs));
  }

  recordCoalescedSearchRequest(): void {
    this.coalescedSearchRequests++;
  }

  recordColdSearchFetch(elapsedMs: number): void {
    this.coldSearchFetches++;
    this.pushSample(this.coldSearchFetchMs, Math.max(0, elapsedMs));
  }

  recordColdSearchFetchFailure(): void {
    this.coldSearchFetchFailures++;
  }

  recordStaleSearchCacheFallback(): void {
    this.staleSearchCacheFallbacks++;
  }

  snapshot(): DeepbridFinderRequestMetricsSnapshot {
    const window = this.requestRate.snapshot(Date.now());
    return {
      attempts: this.attempts,
      attemptsByKind: { ...this.attemptsByKind },
      responses: { ...this.responses },
      transportFailuresByKind: { ...this.transportFailuresByKind },
      transportFailureClasses: { ...this.transportFailureClasses },
      transportRetryAttemptsByKind: { ...this.transportRetryAttemptsByKind },
      transportRetryRecoveriesByKind: {
        ...this.transportRetryRecoveriesByKind,
      },
      queueWait: summarizeTimings(this.queueWaitMs),
      responseHeaders: summarizeTimings(this.responseHeaderMs),
      searchCache: {
        freshHits: this.freshSearchCacheHits,
        coalescedRequests: this.coalescedSearchRequests,
        staleRateLimitFallbacks: this.staleSearchCacheFallbacks,
        coldFetches: this.coldSearchFetches,
        coldFetchFailures: this.coldSearchFetchFailures,
        freshLookup: summarizeTimings(this.freshSearchCacheLookupMs),
        coldFetch: summarizeTimings(this.coldSearchFetchMs),
      },
      currentFinderRequestsInRollingMinute: window.currentRequests,
      currentFinderCountIsLowerBound: window.currentIsLowerBound,
      maxFinderRequestsInRollingMinute: window.maxRequests,
      maxFinderCountIsLowerBound: window.maxIsLowerBound,
      rateLimit: {
        observations: this.rateLimitObservations,
        latestLimit: this.latestLimit,
        minimumRemaining: this.minimumRemaining,
      },
      advertisedRetryAfter: {
        observations: this.retryAfterObservations,
        totalMs: Math.round(this.retryAfterTotalMs),
        maxMs: Math.round(this.retryAfterMaxMs),
      },
      actualRetryWait: {
        observations: this.actualRetryWaitObservations,
        totalMs: Math.round(this.actualRetryWaitTotalMs),
        maxMs: Math.round(this.actualRetryWaitMaxMs),
      },
    };
  }

  private pushSample(samples: number[], value: number): void {
    if (samples.length === METRICS_SAMPLE_CAP) samples.shift();
    samples.push(value);
  }
}

const DEEPBRID_METRICS_REGISTRY_LIMIT = 256;
const DEEPBRID_METRICS_IDLE_TTL_MS = 30 * 60_000;
const deepbridFinderMetricsByAccount = new Map<
  string,
  { metrics: DeepbridFinderRequestMetrics; touchedAt: number }
>();

function getAccountFinderMetrics(apiKey: string): DeepbridFinderRequestMetrics {
  const now = Date.now();
  for (const [key, entry] of deepbridFinderMetricsByAccount) {
    if (now - entry.touchedAt >= DEEPBRID_METRICS_IDLE_TTL_MS) {
      deepbridFinderMetricsByAccount.delete(key);
    }
  }

  const key = createHash('sha256').update(apiKey).digest('hex');
  const existing = deepbridFinderMetricsByAccount.get(key);
  if (existing) {
    existing.touchedAt = now;
    deepbridFinderMetricsByAccount.delete(key);
    deepbridFinderMetricsByAccount.set(key, existing);
    return existing.metrics;
  }

  while (
    deepbridFinderMetricsByAccount.size >= DEEPBRID_METRICS_REGISTRY_LIMIT
  ) {
    const oldestKey = deepbridFinderMetricsByAccount.keys().next().value;
    if (oldestKey === undefined) break;
    deepbridFinderMetricsByAccount.delete(oldestKey);
  }
  const metrics = new DeepbridFinderRequestMetrics();
  deepbridFinderMetricsByAccount.set(key, { metrics, touchedAt: now });
  return metrics;
}

/** Account-scoped, bounded, in-process Finder telemetry for the profile UI. */
export function getDeepbridFinderRequestReport(
  apiKey: string
): DeepbridFinderRequestReport {
  return {
    ...getAccountFinderMetrics(apiKey).snapshot(),
    sharedAccountGate: getDeepbridApiRequestGateMetrics(apiKey),
  };
}

class AccountAwareDeepbridFinderRequestMetrics extends DeepbridFinderRequestMetrics {
  constructor(private readonly accountMetrics: DeepbridFinderRequestMetrics) {
    super();
  }

  override recordStart(
    kind: DeepbridFinderRequestKind,
    queuedAtMs: number,
    startedAtMs: number
  ): void {
    super.recordStart(kind, queuedAtMs, startedAtMs);
    this.accountMetrics.recordStart(kind, queuedAtMs, startedAtMs);
  }

  override recordResponse(
    status: number,
    headers: Headers,
    elapsedMs: number
  ): void {
    super.recordResponse(status, headers, elapsedMs);
    this.accountMetrics.recordResponse(status, headers, elapsedMs);
  }

  override recordTransportFailure(
    kind: DeepbridFinderRequestKind,
    error: unknown
  ): void {
    super.recordTransportFailure(kind, error);
    this.accountMetrics.recordTransportFailure(kind, error);
  }

  override recordTransportRetry(
    kind: DeepbridFinderRequestKind,
    recovered: boolean
  ): void {
    super.recordTransportRetry(kind, recovered);
    this.accountMetrics.recordTransportRetry(kind, recovered);
  }

  override recordRetryWait(elapsedMs: number): void {
    super.recordRetryWait(elapsedMs);
    this.accountMetrics.recordRetryWait(elapsedMs);
  }

  override recordFreshSearchCacheHit(elapsedMs: number): void {
    super.recordFreshSearchCacheHit(elapsedMs);
    this.accountMetrics.recordFreshSearchCacheHit(elapsedMs);
  }

  override recordCoalescedSearchRequest(): void {
    super.recordCoalescedSearchRequest();
    this.accountMetrics.recordCoalescedSearchRequest();
  }

  override recordColdSearchFetch(elapsedMs: number): void {
    super.recordColdSearchFetch(elapsedMs);
    this.accountMetrics.recordColdSearchFetch(elapsedMs);
  }

  override recordColdSearchFetchFailure(): void {
    super.recordColdSearchFetchFailure();
    this.accountMetrics.recordColdSearchFetchFailure();
  }

  override recordStaleSearchCacheFallback(): void {
    super.recordStaleSearchCacheFallback();
    this.accountMetrics.recordStaleSearchCacheFallback();
  }
}

function classifyTransportFailure(
  error: unknown
): DeepbridTransportFailureClass {
  const seen = new Set<object>();
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 4 && current && typeof current === 'object';
    depth++
  ) {
    if (seen.has(current)) break;
    seen.add(current);
    const candidate = current as {
      name?: unknown;
      code?: unknown;
      cause?: unknown;
    };
    const name = typeof candidate.name === 'string' ? candidate.name : '';
    const code = typeof candidate.code === 'string' ? candidate.code : '';
    if (name === 'AbortError' || code === 'ABORT_ERR') return 'aborted';
    if (
      name === 'TimeoutError' ||
      [
        'ETIMEDOUT',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_BODY_TIMEOUT',
      ].includes(code)
    ) {
      return 'timeout';
    }
    if (
      [
        'ECONNRESET',
        'ECONNREFUSED',
        'EHOSTUNREACH',
        'ENETUNREACH',
        'EAI_AGAIN',
        'EPIPE',
        'UND_ERR_SOCKET',
        'UND_ERR_CONNECT',
      ].includes(code)
    ) {
      return 'connection';
    }
    current = candidate.cause;
  }
  return 'other';
}

function retryAfterMsFromHeaders(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function finderRequestKind(path: string): DeepbridFinderRequestKind {
  if (path.startsWith('/usenet/finder/search?')) return 'search';
  if (path.startsWith('/usenet/finder/content?')) return 'content';
  return 'other';
}

interface DeepbridApiRequestGate {
  limit: LimitFunction;
  requests: BoundedRollingMinuteCounter;
  queueWaitMs: number[];
  lastUsedAtMs: number;
  lastStartedAtMs?: number;
  cooldownUntilMs: number;
  providerRateLimit?: number;
}

/** Bounded process-local registry. Keys supplied here must already be hashes,
 * never raw account credentials. In-flight and queued gates are never evicted. */
export class DeepbridApiRequestGateRegistry {
  private readonly gates = new Map<string, DeepbridApiRequestGate>();

  constructor(
    private readonly options: {
      maxEntries?: number;
      idleTtlMs?: number;
      now?: () => number;
      createLimiter?: () => LimitFunction;
      requestsPerMinute?: number;
      wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    } = {}
  ) {}

  run<T>(
    credentialHash: string,
    request: (signal?: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    deadlineAtMs?: number
  ): Promise<T> {
    const queuedAtMs = this.now();
    const gate = this.getOrCreate(credentialHash, queuedAtMs);
    if (!gate) {
      return Promise.reject(
        new DeepbridApiError(
          'Deepbrid request capacity is temporarily busy.',
          503,
          'request-gate-capacity'
        )
      );
    }

    const deadlineController =
      deadlineAtMs === undefined ? undefined : new AbortController();
    const gateSignal = deadlineController
      ? signal
        ? AbortSignal.any([signal, deadlineController.signal])
        : deadlineController.signal
      : signal;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    if (deadlineController) {
      const remainingMs = Math.max(0, deadlineAtMs! - this.now());
      if (remainingMs === 0) {
        deadlineController.abort(
          new DeepbridApiError(
            'Deepbrid Finder deadline expired while waiting for API capacity.',
            undefined,
            'retry-exhausted',
            undefined,
            'request_gate_deadline'
          )
        );
      } else {
        deadlineTimer = setTimeout(
          () =>
            deadlineController.abort(
              new DeepbridApiError(
                'Deepbrid Finder deadline expired while waiting for API capacity.',
                undefined,
                'retry-exhausted',
                undefined,
                'request_gate_deadline'
              )
            ),
          remainingMs
        );
      }
    }

    const limited = gate.limit(async () => {
      if (gateSignal?.aborted) {
        throw gateSignal.reason ?? new DOMException('Aborted', 'AbortError');
      }
      await this.waitForStartSlot(gate, gateSignal);
      if (gateSignal?.aborted) {
        throw gateSignal.reason ?? new DOMException('Aborted', 'AbortError');
      }
      const startedAtMs = this.now();
      gate.lastUsedAtMs = startedAtMs;
      gate.requests.record(startedAtMs);
      if (gate.queueWaitMs.length === METRICS_SAMPLE_CAP) {
        gate.queueWaitMs.shift();
      }
      gate.queueWaitMs.push(Math.max(0, startedAtMs - queuedAtMs));
      const result = await request(gateSignal);
      // makeRequest uses the installed Undici package. Its Response can differ
      // from Node's global Response constructor, so check the exact transport
      // type or otherwise valid rate-limit headers are silently ignored.
      if (result instanceof UndiciResponse) {
        this.recordResponseHeaders(gate, result.status, result.headers);
      }
      return result;
    });

    // p-limit cannot remove an already queued task. Race the caller against
    // cancellation so its resolver deadline is honored immediately; if the
    // queued task later reaches the front, its preflight sees the aborted
    // signal and exits without starting network traffic.
    return raceDeepbridRequestWithAbort(limited, gateSignal).finally(() => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
    });
  }

  snapshot(
    credentialHash: string
  ): DeepbridFinderRequestReport['sharedAccountGate'] {
    const gate = this.gates.get(credentialHash);
    if (!gate) return emptySharedGateMetrics();

    const window = gate.requests.snapshot(this.now());
    return {
      currentRequestsInRollingMinute: window.currentRequests,
      currentCountIsLowerBound: window.currentIsLowerBound,
      maxRequestsInRollingMinute: window.maxRequests,
      maxCountIsLowerBound: window.maxIsLowerBound,
      requestStartLimitPerMinute: this.requestStartLimit(gate),
      observedProviderLimit: gate.providerRateLimit,
      cooldownRemainingMs: Math.max(0, gate.cooldownUntilMs - this.now()),
      queueWait: summarizeTimings(gate.queueWaitMs),
    };
  }

  /** Exposed for deterministic lifecycle tests; reports no credential keys. */
  pruneIdle(nowMs = this.now()): number {
    let removed = 0;
    const ttl = this.options.idleTtlMs ?? API_GATE_IDLE_TTL_MS;
    for (const [key, gate] of this.gates) {
      if (this.isIdle(gate) && nowMs - gate.lastUsedAtMs >= ttl) {
        this.gates.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Current registry size only; credential identifiers are never exposed. */
  get size(): number {
    return this.gates.size;
  }

  private getOrCreate(
    credentialHash: string,
    nowMs: number
  ): DeepbridApiRequestGate | undefined {
    const existing = this.gates.get(credentialHash);
    if (existing) {
      existing.lastUsedAtMs = nowMs;
      return existing;
    }

    this.pruneIdle(nowMs);
    const maxEntries = this.options.maxEntries ?? API_GATE_MAX_ENTRIES;
    if (this.gates.size >= maxEntries) {
      const oldestIdle = [...this.gates.entries()]
        .filter(([, gate]) => this.isIdle(gate))
        .sort((a, b) => a[1].lastUsedAtMs - b[1].lastUsedAtMs)[0];
      if (oldestIdle) this.gates.delete(oldestIdle[0]);
    }
    if (this.gates.size >= maxEntries) return undefined;

    const gate: DeepbridApiRequestGate = {
      // A small in-flight window hides provider latency while the start-slot
      // scheduler below enforces the account-wide request rate.
      limit: this.options.createLimiter?.() ?? pLimit(3),
      requests: new BoundedRollingMinuteCounter(),
      queueWaitMs: [],
      lastUsedAtMs: nowMs,
      cooldownUntilMs: 0,
    };
    this.gates.set(credentialHash, gate);
    return gate;
  }

  private isIdle(gate: DeepbridApiRequestGate): boolean {
    return gate.limit.activeCount === 0 && gate.limit.pendingCount === 0;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private requestStartLimit(gate: DeepbridApiRequestGate): number {
    const configuredLimit =
      this.options.requestsPerMinute ?? MAX_DEEPBRID_REQUESTS_PER_MINUTE;
    const safeProviderShare = gate.providerRateLimit
      ? Math.floor(gate.providerRateLimit * 0.75)
      : UNKNOWN_DEEPBRID_REQUESTS_PER_MINUTE;
    return Math.max(
      1,
      Math.min(
        MAX_DEEPBRID_REQUESTS_PER_MINUTE,
        configuredLimit,
        safeProviderShare
      )
    );
  }

  private async waitForStartSlot(
    gate: DeepbridApiRequestGate,
    signal?: AbortSignal
  ): Promise<void> {
    while (true) {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      }
      const intervalMs = Math.ceil(60_000 / this.requestStartLimit(gate));
      const nowMs = this.now();
      const earliestStartMs = Math.max(
        gate.cooldownUntilMs,
        (gate.lastStartedAtMs ?? Number.NEGATIVE_INFINITY) + intervalMs
      );
      const delayMs = earliestStartMs - nowMs;
      if (delayMs > 0) {
        await (this.options.wait ?? abortableDelay)(delayMs, signal);
        // Re-check after waking: another in-flight call may have received a
        // 429 and extended the shared account cooldown while we were asleep.
        continue;
      }
      // No await between this check and reservation: concurrent waiters cannot
      // claim the same slot, even if several timers wake in one event-loop tick.
      const startedAtMs = this.now();
      if (
        startedAtMs < gate.cooldownUntilMs ||
        (gate.lastStartedAtMs !== undefined &&
          startedAtMs - gate.lastStartedAtMs < intervalMs)
      ) {
        continue;
      }
      gate.lastStartedAtMs = startedAtMs;
      return;
    }
  }

  private recordResponseHeaders(
    gate: DeepbridApiRequestGate,
    status: number,
    headers: Headers
  ): void {
    const providerLimit = finiteHeaderNumber(headers, 'x-ratelimit-limit');
    if (providerLimit !== undefined && providerLimit > 0) {
      gate.providerRateLimit = providerLimit;
    }

    if (
      status === 429 ||
      finiteHeaderNumber(headers, 'x-ratelimit-remaining') === 0
    ) {
      const cooldownMs = retryAfterMsFromHeaders(headers) ?? 60_000;
      gate.cooldownUntilMs = Math.max(
        gate.cooldownUntilMs,
        this.now() + cooldownMs
      );
    }
  }
}

function raceDeepbridRequestWithAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
    if (signal.aborted) onAbort();
  });
}

function emptySharedGateMetrics(): DeepbridFinderRequestReport['sharedAccountGate'] {
  return {
    currentRequestsInRollingMinute: 0,
    currentCountIsLowerBound: false,
    maxRequestsInRollingMinute: 0,
    maxCountIsLowerBound: false,
    requestStartLimitPerMinute: UNKNOWN_DEEPBRID_REQUESTS_PER_MINUTE,
    cooldownRemainingMs: 0,
    queueWait: summarizeTimings([]),
  };
}

const deepbridApiRequestGates = new DeepbridApiRequestGateRegistry();

/** Snapshot traffic passed through this process's shared gate. It cannot see
 * other applications or processes using the same Deepbrid account. */
export function getDeepbridApiRequestGateMetrics(
  apiKey: string
): DeepbridFinderRequestReport['sharedAccountGate'] {
  const credentialHash = createHash('sha256').update(apiKey).digest('hex');
  return deepbridApiRequestGates.snapshot(credentialHash);
}

export function runDeepbridApiRequest<T>(
  apiKey: string,
  request: (signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  deadlineAtMs?: number
): Promise<T> {
  const credentialKey = createHash('sha256').update(apiKey).digest('hex');
  return deepbridApiRequestGates.run(
    credentialKey,
    request,
    signal,
    deadlineAtMs
  );
}

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
  unreachable: z.string().optional(),
  video: z.boolean().optional(),
  nzb: z.string().optional(),
  nzb_url: z.string().optional(),
  nzbUrl: z.string().optional(),
});

export interface DeepbridFinderResult {
  token: string;
  title: string;
  category: string;
  categoryName: string;
  kind: string;
  size: number;
  sizeHuman: string;
  nzbUrl?: string;
  date: string;
  sources: number;
}

export interface DeepbridFinderFile {
  name: string;
  link: string;
  size: number;
  sizeHuman: string;
  nzbUrl?: string;
  /** Provider-declared reason this file cannot currently be served. */
  unreachable?: string;
  /** Provider hint only; local stream eligibility still checks filename and URL. */
  providerVideo?: boolean;
}

export interface DeepbridArchiveVolumeAssessment {
  hasArchives: boolean;
  incomplete: boolean;
  unreachableArchiveCount: number;
  missingVolumeNumbers: number[];
}

/**
 * Detects only missing indices visible inside a listed split-archive sequence.
 * It does not infer a missing final volume when the provider exposes no total.
 */
export function assessDeepbridArchiveVolumes(
  files: readonly Pick<DeepbridFinderFile, 'name' | 'unreachable'>[]
): DeepbridArchiveVolumeAssessment {
  const sequences = new Map<
    string,
    { expectedFirst: number; values: Set<number> }
  >();
  let hasArchives = false;
  let unreachableArchiveCount = 0;
  const add = (key: string, value: number, expectedFirst: number) => {
    let sequence = sequences.get(key);
    if (!sequence) {
      sequence = { expectedFirst, values: new Set() };
      sequences.set(key, sequence);
    }
    sequence.values.add(value);
  };

  for (const file of files) {
    const name = file.name.trim();
    if (!isDeepbridArchiveName(name)) continue;
    hasArchives = true;
    if (file.unreachable) unreachableArchiveCount++;

    let match = /^(.*)\.part(\d+)\.rar$/i.exec(name);
    if (match) {
      add(`rar-part:${match[1].toLowerCase()}`, Number(match[2]), 1);
      continue;
    }
    match = /^(.*)\.(?:7z|zip)\.(\d{3,})$/i.exec(name);
    if (match) {
      add(`split-archive:${match[1].toLowerCase()}`, Number(match[2]), 1);
      continue;
    }
    match = /^(.*)\.r(\d{2,})$/i.exec(name);
    if (match) {
      add(`rar-volume:${match[1].toLowerCase()}`, Number(match[2]), 0);
      continue;
    }
    match = /^(.*)\.z(\d{2,})$/i.exec(name);
    if (match) add(`zip-volume:${match[1].toLowerCase()}`, Number(match[2]), 1);
  }

  const missingVolumeNumbers: number[] = [];
  let missingVolumeCount = 0;
  for (const sequence of sequences.values()) {
    const ordered = [...sequence.values].sort((a, b) => a - b);
    if (!ordered.length) continue;
    const last = ordered[ordered.length - 1];
    // Guard against implausibly huge names causing a CPU/memory spike.
    if (last - sequence.expectedFirst > 100_000) continue;
    const present = sequence.values;
    for (let index = sequence.expectedFirst; index <= last; index++) {
      if (present.has(index)) continue;
      missingVolumeCount++;
      if (missingVolumeNumbers.length < 100) missingVolumeNumbers.push(index);
    }
  }

  return {
    hasArchives,
    incomplete: unreachableArchiveCount > 0 || missingVolumeCount > 0,
    unreachableArchiveCount,
    missingVolumeNumbers,
  };
}

export type DeepbridUploadFileAssessment = {
  playableCandidate: boolean;
  status: 'candidate' | 'unreachable' | 'non-video';
  reason?:
    'provider-unreachable' | 'missing-link' | 'not-video' | 'untrusted-link';
};

/** Classify provider upload entries without equating a link with verified playback. */
export function classifyDeepbridUploadFile(
  file: Pick<DeepbridFinderFile, 'name' | 'link' | 'unreachable'>
): DeepbridUploadFileAssessment {
  if (file.unreachable) {
    return {
      playableCandidate: false,
      status: 'unreachable',
      reason: 'provider-unreachable',
    };
  }
  if (!file.link) {
    return {
      playableCandidate: false,
      status: 'unreachable',
      reason: 'missing-link',
    };
  }
  if (!isDeepbridVideoName(file.name)) {
    return {
      playableCandidate: false,
      status: 'non-video',
      reason: 'not-video',
    };
  }
  return { playableCandidate: true, status: 'candidate' };
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

export interface DeepbridFolderFile extends DeepbridFinderFile {
  playableCandidate: boolean;
  status: DeepbridUploadFileAssessment['status'];
  reason?: DeepbridUploadFileAssessment['reason'];
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

/** Secret-free view of one Deepbrid download-history record. */
export interface DeepbridDownloadHistoryEntry {
  id: string;
  filename: string;
  size?: string;
  date?: string;
}

export interface DeepbridHistoryDeletionResult {
  deleted: number;
  ids: string[];
  notFound: string[];
}

export interface DeepbridDownloadHistoryPage {
  entries: DeepbridDownloadHistoryEntry[];
  /** Number of records returned by the provider before local ID validation. */
  providerCount: number;
  /** Whether a full provider page was returned and another offset may exist. */
  hasNext: boolean;
}

function normalizeDeepbridHistoryId(value: string | number): string {
  const id = String(value).trim();
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
    throw new DeepbridApiError(
      'Deepbrid history IDs must be positive integers.',
      undefined,
      'invalid-history-ids'
    );
  }
  return String(Number(id));
}

function validDeepbridHistoryId(value: unknown): value is string | number {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  try {
    normalizeDeepbridHistoryId(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeDeepbridHistoryIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!validDeepbridHistoryId(item)) return [];
    try {
      return [normalizeDeepbridHistoryId(item)];
    } catch {
      return [];
    }
  });
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
  /** Absolute parent resolver deadline; retries may never cross this time. */
  deadlineAtMs?: number;
  signal?: AbortSignal;
}

/** Fixed-cardinality reason for exhausting a Deepbrid request deadline. */
export type DeepbridRetryExhaustionReason =
  | 'request_gate_deadline'
  | 'wrapper_budget_before_attempt'
  | 'wrapper_completed_after_deadline'
  | 'request_json_budget_before_attempt'
  | 'request_json_budget_at_gate'
  | 'request_json_loop_exhausted'
  | 'signature_correction_budget'
  | 'finder_budget_at_gate'
  | 'unknown';

export function getDeepbridAttemptTimeoutMs(
  timeoutMs: number,
  deadlineAtMs?: number,
  nowMs = Date.now()
): number | undefined {
  const requestedTimeoutMs = Math.max(250, timeoutMs);
  if (deadlineAtMs === undefined) return requestedTimeoutMs;
  const remainingMs = Math.floor(deadlineAtMs - nowMs);
  if (remainingMs < 250) return undefined;
  return Math.min(requestedTimeoutMs, remainingMs);
}

export class DeepbridApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly retryAfterMs?: number,
    readonly retryExhaustionReason?: DeepbridRetryExhaustionReason
  ) {
    super(message);
    this.name = 'DeepbridApiError';
  }
}

function deepbridRateLimitDelayMs(error: unknown): number | undefined {
  if (error instanceof Error && error.name === 'RateLimitedError') {
    const seconds = (error as Error & { retryAfterSeconds?: unknown })
      .retryAfterSeconds;
    if (
      typeof seconds === 'number' &&
      Number.isFinite(seconds) &&
      seconds >= 0 &&
      seconds <= 300
    ) {
      return Math.ceil(seconds * 1_000);
    }
  }

  if (error instanceof DeepbridApiError && error.status === 429) {
    return error.retryAfterMs ?? 5_000;
  }

  return undefined;
}

/**
 * Retry idempotent Finder GETs when AIOStreams' shared HTTP cooldown is
 * active. Cooldown waits and attempts share the caller's original time budget;
 * unrelated failures and cancellation are not retried.
 */
export async function withDeepbridRateLimitRetry<T>(
  operation: (timeoutMs: number, deadlineAtMs: number) => Promise<T>,
  options: {
    timeoutMs: number;
    attemptTimeoutMs?: number;
    deadlineAtMs?: number;
    signal?: AbortSignal;
    maxRetries?: number;
    maxTransportRetries?: number;
    now?: () => number;
    wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    onCooldownWait?: (elapsedMs: number) => void;
    onTransportRetry?: (recovered: boolean) => void;
  }
): Promise<T> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? abortableDelay;
  const localDeadline = now() + Math.max(0, options.timeoutMs);
  const deadline =
    options.deadlineAtMs === undefined
      ? localDeadline
      : Math.min(localDeadline, Math.max(now(), options.deadlineAtMs));
  const throwIfAborted = (): void => {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
  };
  const maxRetries = Math.max(0, Math.min(2, options.maxRetries ?? 2));
  let retries = 0;
  const maxTransportRetries = Math.max(
    0,
    Math.min(5, options.maxTransportRetries ?? 2)
  );
  let transportRetries = 0;

  while (true) {
    throwIfAborted();

    const remainingMs = Math.floor(deadline - now());
    if (remainingMs < 250) {
      throw new DeepbridApiError(
        'Deepbrid Finder request budget was exhausted.',
        undefined,
        'retry-exhausted',
        undefined,
        'wrapper_budget_before_attempt'
      );
    }

    try {
      const result = await operation(
        Math.min(options.attemptTimeoutMs ?? remainingMs, remainingMs),
        deadline
      );
      throwIfAborted();
      if (now() >= deadline) {
        throw new DeepbridApiError(
          'Deepbrid API request completed after its deadline.',
          undefined,
          'retry-exhausted',
          undefined,
          'wrapper_completed_after_deadline'
        );
      }
      if (transportRetries > 0) {
        try {
          options.onTransportRetry?.(true);
        } catch {
          // Telemetry must not change retry behavior.
        }
      }
      return result;
    } catch (error) {
      throwIfAborted();
      const cooldownDelayMs = deepbridRateLimitDelayMs(error);
      const transportDelayMs =
        cooldownDelayMs === undefined &&
        classifyTransportFailure(error) === 'timeout' &&
        transportRetries < maxTransportRetries
          ? 250 * 2 ** transportRetries
          : undefined;
      const delayMs = cooldownDelayMs ?? transportDelayMs;
      if (
        delayMs === undefined ||
        (cooldownDelayMs !== undefined && retries >= maxRetries) ||
        delayMs + 250 > deadline - now()
      ) {
        throw error;
      }

      if (transportDelayMs !== undefined) {
        transportRetries++;
        try {
          options.onTransportRetry?.(false);
        } catch {
          // Telemetry must not change retry behavior.
        }
      }

      const waitStartedAt = now();
      try {
        await wait(Math.max(250, delayMs), options.signal);
      } finally {
        if (cooldownDelayMs !== undefined) {
          try {
            options.onCooldownWait?.(Math.max(0, now() - waitStartedAt));
          } catch {
            // Telemetry must not change retry behavior.
          }
        }
      }
      throwIfAborted();
      if (cooldownDelayMs !== undefined) retries++;
    }
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
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
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

/** Only send links for folder hosts supported by Deepbrid's public API. */
export function validateDeepbridFolderUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new DeepbridApiError(
      'Enter a valid supported folder link.',
      undefined,
      'invalid-folder-url'
    );
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const allowed = ['terabox.com', 'mega.nz', 'gofile.io'].some(
    (domain) => host === domain || host.endsWith(`.${domain}`)
  );
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !allowed ||
    url.port
  ) {
    throw new DeepbridApiError(
      'Folder links must use HTTPS on a Deepbrid-supported host.',
      undefined,
      'invalid-folder-url'
    );
  }
  return url;
}

/** Normalize Finder NZB references before forwarding them to another
 * resolver. Only HTTPS links on Deepbrid's own download hosts are accepted. */
export function normalizeDeepbridFinderNzbUrl(
  value: unknown
): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = validateDeepbridDownloadUrl(
      new URL(value.trim(), DEEPBRID_API_BASE).toString()
    );
    return isTrustedDeepbridDownloadHost(url.hostname)
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/** Parse Finder search results while preserving a safe result-level NZB URL. */
export function parseDeepbridFinderResult(
  value: unknown
): DeepbridFinderResult | undefined {
  const parsed = ResultSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const item = parsed.data;
  const title = item.title || item.name || '';
  if (!title) return undefined;
  const nzbUrl = normalizeDeepbridFinderNzbUrl(
    item.nzb_url || item.nzbUrl || item.nzb
  );
  return {
    token: item.token,
    title,
    category: item.category || '',
    categoryName: item.category_name || item.categoryName || '',
    kind: item.kind || '',
    size: item.size,
    sizeHuman: item.size_human || item.sizeHuman || '',
    ...(nzbUrl ? { nzbUrl } : {}),
    date: item.date || item.created_at || '',
    sources: item.sources,
  };
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
    if (!name) return [];
    if (!link) {
      return file.unreachable
        ? [
            {
              name,
              link: '',
              size: file.filesize || file.size,
              sizeHuman: file.size_human || file.sizeHuman || '',
              unreachable: file.unreachable.slice(0, 128),
              ...(typeof file.video === 'boolean'
                ? { providerVideo: file.video }
                : {}),
            },
          ]
        : [];
    }
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
          ...(file.unreachable
            ? { unreachable: file.unreachable.slice(0, 128) }
            : {}),
          ...(typeof file.video === 'boolean'
            ? { providerVideo: file.video }
            : {}),
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

  getFinderRequestReport(): DeepbridFinderRequestReport {
    return getDeepbridFinderRequestReport(this.apiKey);
  }

  private async requestJson(
    path: string,
    options: DeepbridRequestOptions & {
      method?: 'GET' | 'POST' | 'DELETE';
      body?: URLSearchParams;
    } = {}
  ): Promise<Record<string, unknown>> {
    const timeoutMs = Math.max(
      250,
      Math.min(this.timeoutMs, options.timeoutMs ?? this.timeoutMs)
    );
    const localDeadlineAtMs = Date.now() + timeoutMs * 3 + 5_500;
    const deadlineAtMs =
      options.deadlineAtMs === undefined
        ? localDeadlineAtMs
        : Math.min(localDeadlineAtMs, options.deadlineAtMs);

    for (let attempt = 0; attempt < 3; attempt++) {
      const attemptTimeoutMs = getDeepbridAttemptTimeoutMs(
        timeoutMs,
        deadlineAtMs
      );
      if (attemptTimeoutMs === undefined) {
        throw new DeepbridApiError(
          'Deepbrid request retry budget was exhausted.',
          undefined,
          'retry-exhausted',
          undefined,
          'request_json_budget_before_attempt'
        );
      }
      const response = await runDeepbridApiRequest(
        this.apiKey,
        (gateSignal) => {
          // The endpoint timeout measures network time, not time waiting for
          // this account's shared quota slot. The absolute deadline bounds the
          // whole operation, including quota pacing and retry waits.
          const admittedTimeoutMs = getDeepbridAttemptTimeoutMs(
            timeoutMs,
            deadlineAtMs
          );
          if (admittedTimeoutMs === undefined) {
            throw new DeepbridApiError(
              'Deepbrid request retry budget was exhausted.',
              undefined,
              'retry-exhausted',
              undefined,
              'request_json_budget_at_gate'
            );
          }
          const timeoutSignal = AbortSignal.timeout(admittedTimeoutMs);
          const signals = [gateSignal, options.signal, timeoutSignal].filter(
            (signal): signal is AbortSignal => signal !== undefined
          );
          const signal =
            signals.length === 1 ? signals[0] : AbortSignal.any(signals);
          return makeRequest(`${DEEPBRID_API_BASE}${path}`, {
            method: options.method || 'GET',
            timeout: admittedTimeoutMs,
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
        },
        options.signal,
        deadlineAtMs
      );
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
        (options.method ?? 'GET') === 'GET' &&
        response.status === 429 &&
        attempt === 0 &&
        retryAfter !== undefined &&
        retryAfter <= 5_000 &&
        retryAfter + 250 <= deadlineAtMs - Date.now()
      ) {
        await abortableDelay(retryAfter, options.signal);
        continue;
      }
      const retryDelayMs = Math.min(5_000, 500 * 2 ** attempt);
      if (
        (options.method ?? 'GET') === 'GET' &&
        (response.status === 502 || response.status === 503) &&
        attempt < 2 &&
        retryDelayMs + 250 <= deadlineAtMs - Date.now()
      ) {
        await abortableDelay(retryDelayMs, options.signal);
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
      'retry-exhausted',
      undefined,
      'request_json_loop_exhausted'
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
    const nested =
      json.data && typeof json.data === 'object' && !Array.isArray(json.data)
        ? (json.data as Record<string, unknown>)
        : undefined;
    const items = Array.isArray(json.items)
      ? json.items
      : Array.isArray(json.uploads)
        ? json.uploads
        : Array.isArray(json.data)
          ? json.data
          : Array.isArray(nested?.items)
            ? nested.items
            : [];
    return items.flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const item = value as Record<string, unknown>;
      const id = item.id;
      if (!validDeepbridHistoryId(id)) return [];
      return [
        {
          id: normalizeDeepbridHistoryId(id),
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

  async listDownloads(
    options: DeepbridRequestOptions & { limit?: number; offset?: number } = {}
  ): Promise<DeepbridDownloadHistoryEntry[]> {
    return (await this.listDownloadsPage(options)).entries;
  }

  async listDownloadsPage(
    options: DeepbridRequestOptions & { limit?: number; offset?: number } = {}
  ): Promise<DeepbridDownloadHistoryPage> {
    const limit = options.limit ?? 200;
    const offset = options.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new DeepbridApiError(
        'Deepbrid download history limit must be between 1 and 500.',
        undefined,
        'invalid-history-pagination'
      );
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new DeepbridApiError(
        'Deepbrid download history offset must be a non-negative integer.',
        undefined,
        'invalid-history-pagination'
      );
    }
    const query = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    const json = await this.requestJson(`/downloads?${query}`, options);
    const nested =
      json.data && typeof json.data === 'object' && !Array.isArray(json.data)
        ? (json.data as Record<string, unknown>)
        : undefined;
    const values = Array.isArray(json.data)
      ? json.data
      : Array.isArray(json.items)
        ? json.items
        : Array.isArray(json.downloads)
          ? json.downloads
          : Array.isArray(nested?.items)
            ? nested.items
            : [];
    const entries = values.flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const item = value as Record<string, unknown>;
      const id = item.id;
      if (!validDeepbridHistoryId(id)) return [];
      return [
        {
          id: String(id),
          filename:
            typeof item.filename === 'string'
              ? item.filename.slice(0, 500)
              : '',
          size:
            typeof item.size === 'string' ? item.size.slice(0, 80) : undefined,
          date:
            typeof item.date === 'string' ? item.date.slice(0, 80) : undefined,
        },
      ];
    });
    return {
      entries,
      providerCount: values.length,
      hasNext: values.length === limit,
    };
  }

  /** Deletes selected account entries only; whole-history deletion is intentionally unsupported. */
  async deleteUploads(
    ids: readonly (string | number)[],
    options: DeepbridRequestOptions & { confirm?: boolean } = {}
  ): Promise<DeepbridHistoryDeletionResult> {
    return this.deleteSelectedHistory('/usenet/uploads/delete', ids, options);
  }

  async deleteDownloads(
    ids: readonly (string | number)[],
    options: DeepbridRequestOptions & { confirm?: boolean } = {}
  ): Promise<DeepbridHistoryDeletionResult> {
    return this.deleteSelectedHistory('/downloads/delete', ids, options);
  }

  private async deleteSelectedHistory(
    endpoint: '/usenet/uploads/delete' | '/downloads/delete',
    rawIds: readonly (string | number)[],
    options: DeepbridRequestOptions & { confirm?: boolean }
  ): Promise<DeepbridHistoryDeletionResult> {
    if (options.confirm !== true) {
      throw new DeepbridApiError(
        'Deleting Deepbrid history requires explicit confirmation.',
        undefined,
        'history-delete-confirmation-required'
      );
    }
    if (!Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > 100) {
      throw new DeepbridApiError(
        'Select between 1 and 100 Deepbrid history entries.',
        undefined,
        'invalid-history-ids'
      );
    }
    const ids = [...new Set(rawIds.map(normalizeDeepbridHistoryId))];
    if (ids.length !== rawIds.length) {
      throw new DeepbridApiError(
        'Deepbrid history IDs must be unique positive integers.',
        undefined,
        'invalid-history-ids'
      );
    }
    const query = new URLSearchParams({ ids: ids.join(',') });
    const json = await this.requestJson(`${endpoint}?${query}`, {
      ...options,
      method: 'DELETE',
    });
    return {
      deleted: Number.isInteger(Number(json.deleted))
        ? Math.max(0, Number(json.deleted))
        : 0,
      ids: normalizeDeepbridHistoryIdList(json.ids),
      notFound: normalizeDeepbridHistoryIdList(json.not_found),
    };
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

  /** Resolve a supported folder via Deepbrid; callers must keep returned links
   * server-side and expose only safe file metadata. */
  async resolveFolder(
    folderLink: string,
    options: DeepbridRequestOptions = {}
  ): Promise<DeepbridFolderFile[]> {
    const url = validateDeepbridFolderUrl(folderLink);
    const json = await this.requestJson('/generate/folder', {
      ...options,
      method: 'POST',
      body: new URLSearchParams({ link: url.toString() }),
    });
    return parseDeepbridFiles(json).map((file) => {
      let trusted = false;
      try {
        trusted = isTrustedDeepbridDownloadHost(
          validateDeepbridDownloadUrl(file.link).hostname
        );
      } catch {
        // The UI receives metadata only; an untrusted link is never a
        // playable candidate and is never returned to the caller.
      }
      const assessment = trusted
        ? classifyDeepbridUploadFile(file)
        : {
            playableCandidate: false,
            status: 'unreachable' as const,
            reason: 'untrusted-link' as const,
          };
      return { ...file, ...assessment };
    });
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
  private readonly requestMetrics: AccountAwareDeepbridFinderRequestMetrics;

  constructor(
    private readonly apiKey: string,
    private readonly timeoutMs = 20_000
  ) {
    if (!apiKey.trim())
      throw new DeepbridApiError('Deepbrid API key is required.');
    this.requestMetrics = new AccountAwareDeepbridFinderRequestMetrics(
      getAccountFinderMetrics(apiKey)
    );
  }

  getRequestMetrics(): DeepbridFinderRequestReport {
    return {
      ...this.requestMetrics.snapshot(),
      sharedAccountGate: getDeepbridApiRequestGateMetrics(this.apiKey),
    };
  }

  private async getJson(
    path: string,
    options: DeepbridRequestOptions = {}
  ): Promise<Record<string, unknown>> {
    const isSearchPage = path.startsWith('/usenet/finder/search?');
    if (!isSearchPage) return this.getJsonUncoalesced(path, options);
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    if (
      options.deadlineAtMs !== undefined &&
      Number.isFinite(options.deadlineAtMs) &&
      Date.now() >= options.deadlineAtMs
    ) {
      throw new DeepbridApiError(
        'Deepbrid Finder deadline expired.',
        undefined,
        'retry-exhausted',
        undefined,
        'wrapper_budget_before_attempt'
      );
    }

    const cacheLookupStartedAt = Date.now();
    const cached = finderSearchResponseCache.get(this.apiKey, path);
    if (cached) {
      if (cached.freshness === 'fresh') {
        this.requestMetrics.recordFreshSearchCacheHit(
          Date.now() - cacheLookupStartedAt
        );
      }
      return structuredClone(cached.value);
    }

    const timeoutMs = Math.max(
      250,
      Math.min(this.timeoutMs, options.timeoutMs ?? this.timeoutMs)
    );
    const key = inflightFinderSearchKey(this.apiKey, path, this.timeoutMs);
    let entry = inflightFinderSearches.get(key);
    if (!entry && inflightFinderSearches.size < MAX_INFLIGHT_FINDER_SEARCHES) {
      const controller = new AbortController();
      entry = {
        controller,
        promise: Promise.resolve({}),
        subscribers: 0,
        settled: false,
      };
      const requestEntry = entry;
      inflightFinderSearches.set(key, requestEntry);
      requestEntry.promise = Promise.resolve()
        .then(() =>
          this.getJsonUncoalesced(path, {
            timeoutMs: this.timeoutMs,
            signal: controller.signal,
          })
        )
        .finally(() => {
          requestEntry.settled = true;
          if (inflightFinderSearches.get(key) === requestEntry) {
            inflightFinderSearches.delete(key);
          }
        });
      // The last subscriber may cancel while the provider request is winding
      // down. Keep that deliberate abort from becoming an unhandled rejection.
      void requestEntry.promise.catch(() => {});
    } else if (!entry) {
      // Under an unusual burst, preserve correctness and bounded memory by
      // making this caller independent instead of growing the single-flight map.
      return this.getJsonUncoalesced(path, options);
    } else {
      this.requestMetrics.recordCoalescedSearchRequest();
    }

    return subscribeToInflightFinderSearch(
      key,
      entry,
      options.signal,
      options.deadlineAtMs ?? Date.now() + timeoutMs * 3 + 250 * (2 ** 2 - 1)
    );
  }

  private async getJsonUncoalesced(
    path: string,
    options: DeepbridRequestOptions = {}
  ): Promise<Record<string, unknown>> {
    const timeoutMs = Math.max(
      250,
      Math.min(this.timeoutMs, options.timeoutMs ?? this.timeoutMs)
    );
    const isSearchPage = path.startsWith('/usenet/finder/search?');
    const maxTransportRetries = isSearchPage ? 2 : 5;
    const transportRetryBackoffBudgetMs = 250 * (2 ** maxTransportRetries - 1);
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    if (
      options.deadlineAtMs !== undefined &&
      Number.isFinite(options.deadlineAtMs) &&
      Date.now() >= options.deadlineAtMs
    ) {
      throw new DeepbridApiError(
        'Deepbrid Finder deadline expired.',
        undefined,
        'retry-exhausted',
        undefined,
        'wrapper_budget_before_attempt'
      );
    }
    const coldSearchStartedAt = isSearchPage ? Date.now() : undefined;
    try {
      const value = await withDeepbridRateLimitRetry(
        async (remainingMs, retryDeadlineAtMs) => {
          const attemptStartedAt = Date.now();
          // The shared account gate may wait for quota pacing or a provider
          // cooldown. Carry the retry helper's local deadline into that gate
          // so queued work cannot start after its own budget has expired.
          const requestDeadlineAtMs = retryDeadlineAtMs;
          try {
            return await this.getJsonOnce(path, {
              ...options,
              timeoutMs: Math.min(timeoutMs, remainingMs),
              deadlineAtMs: requestDeadlineAtMs,
            });
          } catch (error) {
            // A stale local clock is indistinguishable from a forbidden
            // signature. The first response's Date header corrected the signer;
            // retry once with a fresh nonce before surfacing the real error.
            if (error instanceof DeepbridApiError && error.code === 'api_15') {
              if (options.signal?.aborted) {
                throw (
                  options.signal.reason ??
                  new DOMException('Aborted', 'AbortError')
                );
              }
              const signatureRetryTimeoutMs =
                remainingMs - (Date.now() - attemptStartedAt);
              const parentRemainingMs =
                requestDeadlineAtMs === undefined
                  ? Number.POSITIVE_INFINITY
                  : requestDeadlineAtMs - Date.now();
              if (signatureRetryTimeoutMs < 250 || parentRemainingMs < 250) {
                throw new DeepbridApiError(
                  'Deepbrid Finder deadline expired before signature correction.',
                  undefined,
                  'retry-exhausted',
                  undefined,
                  'signature_correction_budget'
                );
              }
              return this.getJsonOnce(path, {
                ...options,
                deadlineAtMs: requestDeadlineAtMs,
                timeoutMs: Math.min(
                  timeoutMs,
                  signatureRetryTimeoutMs,
                  parentRemainingMs
                ),
              });
            }
            throw error;
          }
        },
        {
          // Content lookups get two extra narrowly classified timeout retries
          // because live telemetry showed occasional unrecovered timeouts.
          // Search-page retry behavior remains unchanged. The shared account
          // gate still paces every attempt under the provider cap.
          timeoutMs:
            timeoutMs * (maxTransportRetries + 1) +
            transportRetryBackoffBudgetMs,
          attemptTimeoutMs: timeoutMs,
          maxTransportRetries,
          deadlineAtMs: options.deadlineAtMs,
          signal: options.signal,
          onCooldownWait: (elapsedMs) =>
            this.requestMetrics.recordRetryWait(elapsedMs),
          onTransportRetry: (recovered) =>
            this.requestMetrics.recordTransportRetry(
              finderRequestKind(path),
              recovered
            ),
        }
      );
      if (isSearchPage) {
        finderSearchResponseCache.set(this.apiKey, path, value);
        this.requestMetrics.recordColdSearchFetch(
          Date.now() - (coldSearchStartedAt ?? Date.now())
        );
      }
      return value;
    } catch (error) {
      if (
        options.deadlineAtMs !== undefined &&
        Number.isFinite(options.deadlineAtMs) &&
        Date.now() >= options.deadlineAtMs
      ) {
        if (isSearchPage) this.requestMetrics.recordColdSearchFetchFailure();
        throw new DeepbridApiError(
          'Deepbrid Finder deadline expired.',
          undefined,
          'retry-exhausted',
          undefined,
          'wrapper_completed_after_deadline'
        );
      }
      // Search pages are stable enough to bridge a short provider cooldown.
      // Only rate-limit failures use stale data; auth, safety, parsing, and
      // configuration errors remain visible to the normal caller.
      if (
        isSearchPage &&
        !options.signal?.aborted &&
        isDeepbridRateLimitError(error)
      ) {
        const cached = finderSearchResponseCache.get(this.apiKey, path, true);
        if (cached?.freshness === 'stale') {
          this.requestMetrics.recordStaleSearchCacheFallback();
          logger.warn(
            { cache: 'recent-success', fallback: 'rate-limit' },
            'Deepbrid Finder rate limited; reused a recent successful search page'
          );
          return cached.value;
        }
      }
      if (isSearchPage) this.requestMetrics.recordColdSearchFetchFailure();
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
    const queuedAtMs = Date.now();
    let startedAtMs: number | undefined;
    let response: Response;
    try {
      response = await runDeepbridApiRequest(
        this.apiKey,
        (gateSignal) => {
          // Start the endpoint timeout only after the shared account gate
          // admits this request. Recheck the parent deadline here because
          // quota pacing can consume the remaining resolver budget in queue.
          const attemptTimeoutMs = getDeepbridAttemptTimeoutMs(
            timeoutMs,
            options.deadlineAtMs
          );
          if (attemptTimeoutMs === undefined) {
            throw new DeepbridApiError(
              'Deepbrid Finder deadline expired before request start.',
              undefined,
              'retry-exhausted',
              undefined,
              'finder_budget_at_gate'
            );
          }
          const timeoutSignal = AbortSignal.timeout(attemptTimeoutMs);
          const signal = gateSignal
            ? AbortSignal.any([gateSignal, timeoutSignal])
            : timeoutSignal;
          startedAtMs = Date.now();
          this.requestMetrics.recordStart(
            finderRequestKind(path),
            queuedAtMs,
            startedAtMs
          );
          return makeRequest(`${DEEPBRID_API_BASE}${path}`, {
            timeout: attemptTimeoutMs,
            signal,
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${this.apiKey}`,
              'User-Agent': DEEPBRID_FINDER_USER_AGENT,
              ...this.signer.sign('GET', path),
            },
          });
        },
        options.signal,
        options.deadlineAtMs
      );
      this.requestMetrics.recordResponse(
        response.status,
        response.headers,
        Date.now() - (startedAtMs ?? queuedAtMs)
      );
    } catch (error) {
      if (startedAtMs !== undefined) {
        this.requestMetrics.recordTransportFailure(
          finderRequestKind(path),
          error
        );
      }
      throw error;
    }
    this.signer.noteServerDate(response.headers.get('date'));
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      this.requestMetrics.recordTransportFailure(
        finderRequestKind(path),
        error
      );
      throw error;
    }
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
        'http-error',
        retryAfterMs(response)
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

  async searchPage(
    query: string,
    options: {
      category?: string;
      offset?: number;
      limit?: number;
      timeoutMs?: number;
      deadlineAtMs?: number;
      signal?: AbortSignal;
    } = {}
  ): Promise<{
    results: DeepbridFinderResult[];
    rawCount: number;
    invalidCount: number;
  }> {
    const trimmed = query.trim();
    if (trimmed.length < 3) {
      return { results: [], rawCount: 0, invalidCount: 0 };
    }
    const offset = Math.max(0, Math.floor(options.offset || 0));
    const limit = Math.min(100, Math.max(1, Math.floor(options.limit || 50)));
    const params = new URLSearchParams({
      q: trimmed,
      offset: String(offset),
      limit: String(limit),
    });
    if (options.category) params.set('category', options.category);
    const json = await this.getJson(`/usenet/finder/search?${params}`, options);
    if (!Array.isArray(json.items)) {
      throw new DeepbridApiError(
        'Deepbrid Finder returned an invalid search page.',
        undefined,
        'invalid-search-shape'
      );
    }
    const items = json.items;
    const results = items.flatMap((value) => {
      const parsed = parseDeepbridFinderResult(value);
      return parsed ? [parsed] : [];
    });
    return {
      results,
      rawCount: items.length,
      invalidCount: items.length - results.length,
    };
  }

  async search(
    query: string,
    options: {
      category?: string;
      offset?: number;
      limit?: number;
      timeoutMs?: number;
      deadlineAtMs?: number;
      signal?: AbortSignal;
    } = {}
  ): Promise<DeepbridFinderResult[]> {
    return (await this.searchPage(query, options)).results;
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
      const nzbUrl = normalizeDeepbridFinderNzbUrl(
        file.nzb_url || file.nzbUrl || file.nzb
      );
      try {
        return [
          {
            name,
            link: validateDeepbridDownloadUrl(link).toString(),
            size: file.size,
            sizeHuman: file.size_human || file.sizeHuman || '',
            ...(nzbUrl ? { nzbUrl } : {}),
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
  return /\.(?:rar|r\d{2,}|7z(?:\.\d{3})?|zip(?:\.\d{3})?|z\d{2,}|s\d{2}|part\d+\.rar|tar|gz|bz2)$/i.test(
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
