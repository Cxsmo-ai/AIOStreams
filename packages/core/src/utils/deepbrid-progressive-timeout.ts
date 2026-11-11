/**
 * Progressive Finder results are delivered as validated batches while the
 * complete candidate queue continues resolving. Keep that work bounded but
 * long enough to finish large result sets; ordinary requests keep their
 * configured timeout.
 */
// The account-wide Deepbrid quota gate paces requests below the provider's
// published per-minute limit. A live 1,393-candidate scrape still had 1,015
// candidates unattempted at 12 minutes under normal quota, so progressive
// Finder work needs a generous completion window; otherwise the terminal
// event can arrive with a silently truncated tail.
export const DEEPBRID_PROGRESSIVE_RESOLUTION_TIMEOUT_MS = 3_600_000;
export const DEEPBRID_PROGRESSIVE_OUTER_TIMEOUT_MARGIN_MS = 60_000;

export function deepbridResolutionTimeout(
  configuredTimeoutMs: number,
  progressive: boolean
): number {
  return progressive
    ? Math.max(configuredTimeoutMs, DEEPBRID_PROGRESSIVE_RESOLUTION_TIMEOUT_MS)
    : configuredTimeoutMs;
}

export function deepbridProgressiveOuterTimeout(
  configuredTimeoutMs: number
): number {
  const resolutionTimeout = deepbridResolutionTimeout(
    configuredTimeoutMs,
    true
  );
  return Math.max(
    configuredTimeoutMs,
    resolutionTimeout + DEEPBRID_PROGRESSIVE_OUTER_TIMEOUT_MARGIN_MS
  );
}
