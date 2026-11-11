/** Detect top-level and nested HLS playlists even with generic content types. */
export function isDeepbridHlsPlaylistResponse(
  mode: 'direct' | 'remux' | 'hls' | 'hls-asset',
  pathname: string,
  contentType: string
): boolean {
  if (mode === 'hls') return true;
  if (mode !== 'hls-asset') return false;
  return (
    contentType.toLowerCase().includes('mpegurl') ||
    pathname.toLowerCase().endsWith('.m3u8')
  );
}

/** HLS manifests are small whole documents; Range applies only to media assets. */
export function shouldForwardDeepbridRange(
  mode: 'direct' | 'remux' | 'hls' | 'hls-asset',
  pathname: string,
  contentType = ''
): boolean {
  if (mode === 'hls') return false;
  if (mode === 'hls-asset') {
    if (
      pathname.toLowerCase().endsWith('.m3u8') ||
      contentType.toLowerCase().includes('mpegurl')
    ) {
      return false;
    }
  }
  return true;
}

/** Rewritten HLS responses cannot safely use origin-manifest validators. */
export function shouldForwardDeepbridConditionalHeaders(
  mode: 'direct' | 'remux' | 'hls' | 'hls-asset'
): boolean {
  return mode === 'direct' || mode === 'remux';
}

export function isDeepbridRedirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

export const DEEPBRID_HLS_HEADERS_TO_REMOVE = [
  'ETag',
  'Last-Modified',
  'Content-Length',
  'Content-Range',
  'Accept-Ranges',
] as const;

/** Rewrite all media-bearing HLS references before returning a playlist. */
export function rewriteDeepbridHlsPlaylist(
  text: string,
  playlistUrl: string,
  toLocalAsset: (absoluteUrl: string) => string
): string {
  const normalized = text.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('#EXTM3U')) {
    throw new Error('Deepbrid HLS response is not a valid M3U8 playlist.');
  }
  const localize = (value: string) => {
    const absolute = new URL(value.trim(), playlistUrl);
    if (
      absolute.protocol !== 'https:' ||
      absolute.username ||
      absolute.password
    ) {
      throw new Error('Deepbrid HLS playlist contains an unsafe media URL.');
    }
    return toLocalAsset(absolute.toString());
  };
  return normalized
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (!trimmed.startsWith('#')) return localize(trimmed);
      return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => {
        return `URI="${localize(uri)}"`;
      });
    })
    .join('\n');
}
