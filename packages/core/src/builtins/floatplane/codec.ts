export function containsAv1(value: unknown): boolean {
  try {
    return /\bav1\b|av01/i.test(JSON.stringify(value));
  } catch {
    return false;
  }
}

export type FloatplanePlaylistProbe = 'valid' | 'invalid' | 'unknown';
export type FloatplaneMediaProbe = 'valid' | 'invalid' | 'unknown';

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
    let playlistUrl = streamUrl;
    for (let depth = 0; depth < 4; depth += 1) {
      const response = await fetch(playlistUrl, {
        headers: {
          Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*',
        },
        signal: controller.signal,
      });
      if (!response.ok) return 'invalid';
      const body = await response.text();
      if (!/#EXTM3U/i.test(body)) return 'invalid';

      const lines = body
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const uriLines = lines.filter((line) => !line.startsWith('#'));
      if (!uriLines.length) return 'invalid';

      // Resolve the first variant before validating the media playlist. This
      // catches a valid master whose child playlist is stale or unauthorized.
      if (body.includes('#EXT-X-STREAM-INF')) {
        playlistUrl = new URL(uriLines[0], playlistUrl).href;
        continue;
      }

      const quotedUri = (line: string): string | undefined => {
        const marker = 'URI="';
        const start = line.indexOf(marker);
        if (start < 0) return undefined;
        const valueStart = start + marker.length;
        const valueEnd = line.indexOf('"', valueStart);
        return valueEnd > valueStart
          ? line.slice(valueStart, valueEnd)
          : undefined;
      };

      // Floatplane fMP4 playlists currently reference watchKey. A 403 here
      // means ordinary media players will spin forever even though the
      // playlist and segment endpoints themselves return 200.
      const keyLine = lines.find((line) => line.startsWith('#EXT-X-KEY'));
      if (keyLine) {
        const method = keyLine.match(/METHOD=([^,]+)/i)?.[1]?.toUpperCase();
        const keyUri = quotedUri(keyLine);
        if (method !== 'AES-128' || !keyUri) return 'invalid';
        const keyResponse = await fetch(new URL(keyUri, playlistUrl), {
          signal: controller.signal,
        });
        if (!keyResponse.ok) return 'invalid';
        await keyResponse.body?.cancel();
      }

      const mapLine = lines.find((line) => line.startsWith('#EXT-X-MAP'));
      if (mapLine) {
        const mapUri = quotedUri(mapLine);
        if (!mapUri) return 'invalid';
        const mapResponse = await fetch(new URL(mapUri, playlistUrl), {
          headers: { Range: 'bytes=0-4095' },
          signal: controller.signal,
        });
        if (!mapResponse.ok) return 'invalid';
        await mapResponse.body?.cancel();
      }

      const mediaResponse = await fetch(
        new URL(uriLines[0], playlistUrl),
        {
          headers: { Range: 'bytes=0-4095' },
          signal: controller.signal,
        }
      );
      if (!mediaResponse.ok) return 'invalid';
      await mediaResponse.body?.cancel();
      return 'valid';
    }
    return 'invalid';
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

/**
 * Validate a Floatplane `flat` delivery without downloading the media. A
 * ranged read proves that the signed URL is still accepted and that the
 * response is not an HTML/API error page while keeping the client-side video
 * path direct to Floatplane's CDN.
 */
export async function probeFloatplaneMedia(
  mediaUrl: string
): Promise<FloatplaneMediaProbe> {
  if (!/^https?:\/\//i.test(mediaUrl) || containsAv1(mediaUrl)) {
    return 'invalid';
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    PLAYLIST_PROBE_TIMEOUT_MS
  );
  try {
    const response = await fetch(mediaUrl, {
      headers: { Range: 'bytes=0-4095' },
      signal: controller.signal,
    });
    if (!response.ok && response.status !== 206) return 'invalid';
    const contentType = response.headers.get('content-type') || '';
    if (/text\/html|application\/json/i.test(contentType)) return 'invalid';
    await response.body?.cancel();
    return 'valid';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timeout);
  }
}

export async function filterPlayableFloatplaneMedia<
  T extends { url?: string | null }
>(
  streams: T[]
): Promise<T[]> {
  const checked = await Promise.all(
    streams.map(async (stream) => ({
      stream,
      result:
        typeof stream.url === 'string'
          ? await probeFloatplaneMedia(stream.url)
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
