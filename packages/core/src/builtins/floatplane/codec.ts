export function containsAv1(value: unknown): boolean {
  try {
    return /\bav1\b|av01/i.test(JSON.stringify(value));
  } catch {
    return false;
  }
}

export type FloatplanePlaylistProbe = 'valid' | 'invalid' | 'unknown';

const PLAYLIST_PROBE_TIMEOUT_MS = 5_000;

/**
 * Signed Floatplane playlist URLs are short-lived.  A URL can therefore be
 * syntactically correct but already unusable by the time a client receives
 * it.  Probe only the small HLS manifest (never media bytes) before exposing
 * it to Stremio.  Network failures are kept as `unknown` so a temporary CDN
 * outage does not make a fresh stream disappear from the result entirely.
 */
export async function probeFloatplanePlaylist(
  streamUrl: string
): Promise<FloatplanePlaylistProbe> {
  if (!/^https?:\/\//i.test(streamUrl) || containsAv1(streamUrl)) {
    return 'invalid';
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    PLAYLIST_PROBE_TIMEOUT_MS
  );
  try {
    const response = await fetch(streamUrl, {
      headers: {
        Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*',
      },
      signal: controller.signal,
    });
    if (!response.ok) return 'invalid';
    const body = await response.text();
    return /#EXTM3U/i.test(body) ? 'valid' : 'invalid';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Keep only links that were accepted by the CDN.  If every probe failed for
 * a transport reason, retain the candidates so a transient local/network
 * failure does not turn a valid fresh delivery into an empty result.
 */
export async function filterPlayableFloatplanePlaylists<
  T extends { url?: string | null }
>(
  streams: T[]
): Promise<T[]> {
  const checked = await Promise.all(
    streams.map(async (stream) => ({
      stream,
      result:
        typeof stream.url === 'string'
          ? await probeFloatplanePlaylist(stream.url)
          : ('invalid' as const),
    }))
  );
  const valid = checked
    .filter(({ result }) => result === 'valid')
    .map(({ stream }) => stream);
  if (valid.length) return valid;
  return checked
    .filter(({ result }) => result === 'unknown')
    .map(({ stream }) => stream);
}
