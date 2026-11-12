import { createHash } from 'node:crypto';
import {
  isTrustedDeepbridDownloadHost,
  validateDeepbridDownloadUrl,
} from '@aiostreams/core';

export interface DeepbridPlaybackRefreshPayload {
  apiKey: string;
  filename: string;
  size?: number;
  mode?: 'direct' | 'remux' | 'hls' | 'hls-asset';
  finderToken?: string;
  finderArchives?: boolean;
}

export interface DeepbridRefreshableFile {
  name: string;
  link: string;
  size?: number;
}

const CACHE_TTL_MS = 2 * 60_000;
const MAX_CACHE_ENTRIES = 1024;
const refreshedLinks = new Map<string, { url: string; expiresAt: number }>();
const inFlightRefreshes = new Map<string, Promise<string | undefined>>();

function isFinderStorageHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'myfast.link' || host.endsWith('.myfast.link');
}

function refreshKey(payload: DeepbridPlaybackRefreshPayload): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        payload.apiKey,
        payload.finderToken,
        payload.filename.normalize('NFKC').trim().toLowerCase(),
        payload.size ?? null,
        payload.finderArchives === true,
      ])
    )
    .digest('hex');
}

function prune(now: number): void {
  for (const [key, value] of refreshedLinks) {
    if (value.expiresAt <= now) refreshedLinks.delete(key);
  }
  while (refreshedLinks.size >= MAX_CACHE_ENTRIES) {
    const oldest = refreshedLinks.keys().next().value;
    if (oldest === undefined) break;
    refreshedLinks.delete(oldest);
  }
}

/**
 * Re-resolve a Finder file only after a direct storage link returns 410 Gone.
 * A 403 can mean account/access failure, so it is not treated as proof that a
 * signed URL expired. This requires the encrypted Finder identity, accepts
 * only an exact filename/size match on Deepbrid storage hosts, and reuses a
 * short-lived refreshed URL across range requests. No provider request occurs
 * for healthy links, other status codes, or player-transformed modes.
 */
export async function refreshExpiredDeepbridFinderLink(
  status: number,
  payload: DeepbridPlaybackRefreshPayload,
  currentUrl: string,
  getContent: (
    token: string,
    archives: boolean
  ) => Promise<{ files: readonly DeepbridRefreshableFile[] }>,
  now = Date.now()
): Promise<string | undefined> {
  if (
    status !== 410 ||
    (payload.mode !== undefined && payload.mode !== 'direct') ||
    !payload.finderToken
  ) {
    return undefined;
  }

  let current: URL;
  try {
    current = validateDeepbridDownloadUrl(currentUrl);
  } catch {
    return undefined;
  }
  if (
    !isFinderStorageHost(current.hostname) ||
    !isTrustedDeepbridDownloadHost(current.hostname)
  ) {
    return undefined;
  }

  const key = refreshKey(payload);
  const cached = refreshedLinks.get(key);
  if (cached && cached.expiresAt > now && cached.url !== current.toString()) {
    return cached.url;
  }
  if (cached) refreshedLinks.delete(key);

  const existing = inFlightRefreshes.get(key);
  if (existing) return existing;

  const refresh = (async (): Promise<string | undefined> => {
    try {
      const content = await getContent(
        payload.finderToken!,
        payload.finderArchives === true
      );
      const expectedName = payload.filename
        .normalize('NFKC')
        .trim()
        .toLowerCase();
      const match = content.files.find((file) => {
        if (file.name.normalize('NFKC').trim().toLowerCase() !== expectedName) {
          return false;
        }
        return !(
          payload.size !== undefined &&
          payload.size > 0 &&
          file.size !== undefined &&
          file.size > 0 &&
          file.size !== payload.size
        );
      });
      if (!match) return undefined;

      const target = validateDeepbridDownloadUrl(match.link);
      if (
        !isFinderStorageHost(target.hostname) ||
        target.toString() === current.toString()
      ) {
        return undefined;
      }

      prune(now);
      refreshedLinks.set(key, {
        url: target.toString(),
        expiresAt: now + CACHE_TTL_MS,
      });
      return target.toString();
    } catch {
      return undefined;
    }
  })();
  inFlightRefreshes.set(key, refresh);
  try {
    return await refresh;
  } finally {
    inFlightRefreshes.delete(key);
  }
}

/** Test-only cache reset; production callers should never need this. */
export function clearDeepbridPlaybackRefreshCacheForTests(): void {
  refreshedLinks.clear();
  inFlightRefreshes.clear();
}
