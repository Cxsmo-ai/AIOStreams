/**
 * Short-lived positive cache for Deepbrid playback probes.
 *
 * A probe is an intentionally small range request, but repeated Stremio
 * refreshes can otherwise repeat it for the same CDN object.  Only successful
 * probes are admitted; failures are retried on the next request so a transient
 * CDN problem cannot suppress a valid source.  The cache is bounded and has a
 * short TTL because Deepbrid storage links can expire or be replaced.
 */
const MAX_ENTRIES = 2048;
const TTL_MS = 90_000;

interface Entry {
  expiresAt: number;
}

const entries = new Map<string, Entry>();

function trim(now: number): void {
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(key);
  }
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

/** Return true when a recently successful probe exists for this object. */
export function hasSuccessfulDeepbridProbe(key: string): boolean {
  const now = Date.now();
  const entry = entries.get(key);
  if (!entry || entry.expiresAt <= now) {
    if (entry) entries.delete(key);
    return false;
  }
  // Refresh recency without changing the expiry window.
  entries.delete(key);
  entries.set(key, entry);
  return true;
}

/** Admit a successful probe and keep the cache bounded. */
export function rememberSuccessfulDeepbridProbe(key: string): void {
  const now = Date.now();
  trim(now);
  entries.delete(key);
  entries.set(key, { expiresAt: now + TTL_MS });
  trim(now);
}

/** Test-only reset; not exported from the addon barrel. */
export function clearDeepbridProbeCacheForTests(): void {
  entries.clear();
}
