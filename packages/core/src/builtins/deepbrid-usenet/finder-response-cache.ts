import { createHash } from 'node:crypto';

export interface CachedFinderResponse<T> {
  value: T;
  freshness: 'fresh' | 'stale';
}

interface Entry<T> {
  value: T;
  freshUntil: number;
  staleUntil: number;
}

export interface FinderResponseCacheOptions {
  freshMs?: number;
  staleMs?: number;
  maxEntries?: number;
  now?: () => number;
}

/** Only upstream throttling is allowed to activate stale-page fallback. */
export function isDeepbridRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    name?: unknown;
    status?: unknown;
    code?: unknown;
  };
  return (
    candidate.status === 429 ||
    candidate.code === 'api_429' ||
    candidate.name === 'RateLimitedError'
  );
}

/**
 * Small, process-local fallback cache for successful Deepbrid Finder search
 * pages. It never persists provider results or credentials to disk. The API
 * key is hashed into the cache key so profile data cannot cross-contaminate.
 */
export class DeepbridFinderResponseCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly freshMs: number;
  private readonly staleMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: FinderResponseCacheOptions = {}) {
    this.freshMs = Math.max(0, options.freshMs ?? 15_000);
    this.staleMs = Math.max(this.freshMs, options.staleMs ?? 120_000);
    this.maxEntries = Math.max(1, options.maxEntries ?? 512);
    this.now = options.now ?? Date.now;
  }

  private key(apiKey: string, path: string): string {
    return createHash('sha256')
      .update(apiKey)
      .update('\0')
      .update(path)
      .digest('hex');
  }

  get(
    apiKey: string,
    path: string,
    allowStale = false
  ): CachedFinderResponse<T> | undefined {
    const key = this.key(apiKey, path);
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    const now = this.now();
    const freshness =
      now < entry.freshUntil
        ? 'fresh'
        : allowStale && now < entry.staleUntil
          ? 'stale'
          : undefined;
    if (!freshness) {
      if (now >= entry.staleUntil) this.entries.delete(key);
      return undefined;
    }

    // Refresh LRU position without extending the validity window.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { value: entry.value, freshness };
  }

  set(apiKey: string, path: string, value: T): void {
    const now = this.now();
    const key = this.key(apiKey, path);
    this.entries.delete(key);
    this.entries.set(key, {
      value,
      freshUntil: now + this.freshMs,
      staleUntil: now + this.staleMs,
    });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
