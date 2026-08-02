import type { UsenetLibraryStatus } from '../../db/index.js';
import { usenetEngineRegistry } from './engine.js';

export type DamagePolicy = 'tolerant' | 'strict';

/**
 * Strict-policy lens: hide a degraded entry from results and resolves unless
 * its content is mid-playback (re-resolves must keep their stream). Interprets
 * the row, never mutates it, and never feeds the blocklist.
 */
export function shouldSkipDegraded(
  status: UsenetLibraryStatus | undefined,
  policy: DamagePolicy | undefined,
  hasRecentActivity = false
): boolean {
  return policy === 'strict' && status === 'degraded' && !hasRecentActivity;
}

/** Last range-request/reader-close time per content hash. Process-local. */
const streamActivity = new Map<string, number>();

/** Grace window after the last range request or reader close. */
export const STREAM_ACTIVITY_WINDOW_MS = 10 * 60_000;

export function noteStreamActivity(hash: string, now = Date.now()): void {
  streamActivity.set(hash, now);
}

/** A read stream is open for the content, or one was active within the grace window. */
export function hasRecentStreamActivity(
  hash: string,
  now = Date.now()
): boolean {
  if (usenetEngineRegistry.all().some((e) => e.hasLiveStream(hash))) {
    return true;
  }
  const last = streamActivity.get(hash);
  if (last === undefined) return false;
  if (now - last > STREAM_ACTIVITY_WINDOW_MS) {
    streamActivity.delete(hash);
    return false;
  }
  return true;
}

export function pruneStreamActivity(now = Date.now()): void {
  for (const [hash, last] of streamActivity) {
    if (now - last > STREAM_ACTIVITY_WINDOW_MS) {
      streamActivity.delete(hash);
    }
  }
}
