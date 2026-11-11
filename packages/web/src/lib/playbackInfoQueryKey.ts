/** Builds a cache key for a playback-info request and its server-side mode. */
export function playbackInfoQueryKey(
  baseKey: readonly unknown[],
  itemId: string,
  sourceId?: string,
  purpose?: string,
  kept = false
): readonly unknown[] {
  return [
    ...baseKey,
    'playback-info',
    itemId,
    sourceId ?? null,
    purpose ?? null,
    kept ? 'kept' : 'fresh',
  ];
}
