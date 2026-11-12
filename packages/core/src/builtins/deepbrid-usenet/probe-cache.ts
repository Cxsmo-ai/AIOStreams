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
const FAILURE_WINDOW_MS = 60_000;
const FAILURE_THRESHOLD = 3;
const QUARANTINE_MS = 30_000;

interface Entry {
  expiresAt: number;
}

interface FailureEntry {
  failures: number;
  windowExpiresAt: number;
  quarantineExpiresAt?: number;
}

const entries = new Map<string, Entry>();
const failures = new Map<string, FailureEntry>();

function trim(now: number): void {
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(key);
  }
  for (const [key, entry] of failures) {
    if (
      entry.windowExpiresAt <= now &&
      (!entry.quarantineExpiresAt || entry.quarantineExpiresAt <= now)
    ) {
      failures.delete(key);
    }
  }
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  while (failures.size > MAX_ENTRIES) {
    const oldest = failures.keys().next().value;
    if (oldest === undefined) break;
    failures.delete(oldest);
  }
}

/** Skip a repeated probe only after several failures in a short window. */
export function isDeepbridProbeQuarantined(key: string): boolean {
  const now = Date.now();
  const entry = failures.get(key);
  if (!entry?.quarantineExpiresAt) return false;
  if (entry.quarantineExpiresAt <= now) {
    // Give a recovered endpoint a clean retry window after quarantine ends.
    failures.delete(key);
    return false;
  }
  failures.delete(key);
  failures.set(key, entry);
  return true;
}

/** Record a failed probe; one-off/transient failures never quarantine a link. */
export function rememberFailedDeepbridProbe(key: string): void {
  const now = Date.now();
  trim(now);
  const previous = failures.get(key);
  const entry =
    !previous || previous.windowExpiresAt <= now
      ? { failures: 1, windowExpiresAt: now + FAILURE_WINDOW_MS }
      : {
          ...previous,
          failures: previous.failures + 1,
          // This is a fixed observation window, not a sliding one. Otherwise
          // widely spaced failures could eventually trip the quarantine.
          windowExpiresAt: previous.windowExpiresAt,
        };
  if (entry.failures >= FAILURE_THRESHOLD) {
    entry.quarantineExpiresAt = now + QUARANTINE_MS;
  }
  failures.delete(key);
  failures.set(key, entry);
  trim(now);
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
  failures.delete(key);
  entries.delete(key);
  entries.set(key, { expiresAt: now + TTL_MS });
  trim(now);
}

/** Test-only reset; not exported from the addon barrel. */
export function clearDeepbridProbeCacheForTests(): void {
  entries.clear();
  failures.clear();
}
