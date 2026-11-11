/** The minimal attribution needed to count native Deepbrid Finder streams. */
export interface DeepbridFinderStreamLike {
  addon?: {
    identifier?: string | null;
  } | null;
}

/**
 * Count only streams produced by the native Deepbrid Finder addon.
 * External indexer results resolved through Deepbrid retain their source
 * addon's identifier and must not be included in this count.
 */
export function countDeepbridFinderStreams(
  streams: readonly DeepbridFinderStreamLike[]
): number {
  let count = 0;

  for (const stream of streams) {
    if (stream.addon?.identifier === 'deepbrid-usenet') count += 1;
  }

  return count;
}
