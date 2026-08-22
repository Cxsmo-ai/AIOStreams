import { Stream, UserData } from '../db/index.js';
import {
  constants,
  createLogger,
  getSimpleTextHash,
  makeRequest,
} from '../utils/index.js';

const API_BASE_URL = 'https://torrentclaw.com';
const LIVE_TTL_MS = 90_000;
const STATIC_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 1_000;
const logger = createLogger('torrentclaw-api');

export type TorrentClawApiTorrent = {
  infoHash?: string | null;
  rawTitle?: string | null;
  quality?: string | null;
  codec?: string | null;
  sourceType?: string | null;
  sizeBytes?: string | number | null;
  seeders?: number | null;
  leechers?: number | null;
  source?: string | null;
  qualityScore?: number | null;
  uploadedAt?: string | null;
  languages?: string[] | null;
  audioCodec?: string | null;
  audioTracks?: Array<Record<string, unknown>> | null;
  subtitleTracks?: Array<Record<string, unknown>> | null;
  videoInfo?: Record<string, unknown> | null;
  scanStatus?: string | null;
  threatLevel?: string | null;
  torrentFiles?: Array<Record<string, unknown>> | null;
  hdrType?: string | null;
  audioChannels?: string | number | null;
  releaseGroup?: string | null;
  isProper?: boolean | null;
  isRepack?: boolean | null;
  isRemastered?: boolean | null;
  season?: number | null;
  episode?: number | null;
  subtitleLanguages?: string[] | null;
};

export type TorrentClawServiceConfig = {
  apiKey: string;
  unarrUrl: string;
};

type CacheEntry<T> = { value: T; expires: number };

const liveCache = new Map<string, CacheEntry<TorrentClawApiTorrent[]>>();
const staticCache = new Map<string, CacheEntry<TorrentClawApiTorrent[]>>();
const inFlight = new Map<string, Promise<TorrentClawApiTorrent[]>>();

function setBounded<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  ttl: number
): void {
  cache.delete(key);
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
  cache.set(key, { value, expires: Date.now() + ttl });
}

function getFresh<T>(cache: Map<string, CacheEntry<T>>, key: string) {
  const entry = cache.get(key);
  if (!entry || entry.expires <= Date.now()) return undefined;
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function staticTorrent(torrent: TorrentClawApiTorrent): TorrentClawApiTorrent {
  const { seeders: _seeders, leechers: _leechers, ...metadata } = torrent;
  return metadata;
}

function torrentIdentity(torrent: TorrentClawApiTorrent): string {
  return [
    String(torrent.infoHash || '').toLowerCase(),
    normaliseRelease(torrent.rawTitle),
    String(torrent.source || '').toLowerCase(),
    String(torrent.sizeBytes || ''),
  ].join('|');
}

function mergeLayers(
  staticItems: TorrentClawApiTorrent[],
  liveItems: TorrentClawApiTorrent[]
): TorrentClawApiTorrent[] {
  const liveByIdentity = new Map(
    liveItems.map((item) => [torrentIdentity(item), item])
  );
  const merged = staticItems.map((item) => ({
    ...item,
    ...(liveByIdentity.get(torrentIdentity(item)) || {}),
  }));
  const seen = new Set(merged.map(torrentIdentity));
  for (const item of liveItems) {
    if (!seen.has(torrentIdentity(item))) merged.push(item);
  }
  return merged;
}

function positiveNumber(value: unknown): number | undefined {
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    typeof value === 'boolean'
  ) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function normaliseRelease(value: unknown): string {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

export function getTorrentClawServiceConfig(
  userData: UserData
): TorrentClawServiceConfig | undefined {
  const service = userData.services?.find(
    (candidate) =>
      candidate.id === constants.TORRENTCLAW_SERVICE &&
      candidate.enabled !== false
  );
  const apiKey = service?.credentials?.apiKey?.trim();
  if (!apiKey) return undefined;
  const configuredUrl = service?.credentials?.unarrUrl?.trim();
  return {
    apiKey,
    unarrUrl: configuredUrl || 'https://unarr.app',
  };
}

export function isTrustedTorrentClawUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'torrentclaw.com' ||
        url.hostname.endsWith('.torrentclaw.com'))
    );
  } catch {
    return false;
  }
}

export function buildTorrentClawHeaders(options: {
  manifestUrl: string;
  userAgent: string;
  apiKey?: string;
}): Record<string, string> {
  return {
    'User-Agent': options.userAgent,
    'X-Search-Source': 'aiostreams',
    ...(options.apiKey && isTrustedTorrentClawUrl(options.manifestUrl)
      ? { Authorization: `Bearer ${options.apiKey}` }
      : {}),
  };
}

export function torrentClawAuthScope(apiKey?: string): string {
  return apiKey ? getSimpleTextHash(apiKey).slice(0, 16) : 'anonymous';
}

function streamText(stream: Stream): string {
  return [stream.name, stream.title, stream.description]
    .filter(Boolean)
    .join('\n');
}

function hintedMetadata(stream: Stream): TorrentClawApiTorrent | undefined {
  const value = (stream.behaviorHints as Record<string, unknown> | undefined)
    ?.tcMetadata;
  return value && typeof value === 'object'
    ? (value as TorrentClawApiTorrent)
    : undefined;
}

function streamScore(stream: Stream): number | undefined {
  const hinted = positiveNumber(hintedMetadata(stream)?.qualityScore);
  if (hinted !== undefined) return hinted;
  const match = streamText(stream).match(/\b(\d{1,3})\/100\b/);
  return match ? Number(match[1]) : undefined;
}

function streamSeeders(stream: Stream): number | undefined {
  const hints = stream.behaviorHints as Record<string, unknown> | undefined;
  const hinted = positiveNumber(
    hintedMetadata(stream)?.seeders ?? hints?.seeders
  );
  if (hinted !== undefined) return hinted;
  const match = streamText(stream).match(/[👥👤]\s*(\d+)/u);
  return match ? Number(match[1]) : undefined;
}

function streamSize(stream: Stream): number | undefined {
  return positiveNumber(
    stream.behaviorHints?.videoSize ??
      (stream as Record<string, unknown>).sizeBytes ??
      (stream as Record<string, unknown>).size
  );
}

function candidateNames(stream: Stream): string[] {
  return [
    stream.behaviorHints?.filename,
    (stream.behaviorHints as Record<string, unknown> | undefined)?.folderName,
    stream.name,
  ]
    .map(normaliseRelease)
    .filter(Boolean);
}

export function matchTorrentClawTorrent(
  stream: Stream,
  torrents: TorrentClawApiTorrent[]
): TorrentClawApiTorrent | undefined {
  const hash = String(stream.infoHash || '').toLowerCase();
  if (hash) {
    const byHash = torrents.filter(
      (torrent) => String(torrent.infoHash || '').toLowerCase() === hash
    );
    if (byHash.length === 1) return byHash[0];
  }

  const score = streamScore(stream);
  const seeders = streamSeeders(stream);
  if (score !== undefined && seeders !== undefined) {
    const exact = torrents.filter(
      (torrent) =>
        positiveNumber(torrent.qualityScore) === score &&
        positiveNumber(torrent.seeders) === seeders
    );
    if (exact.length === 1) return exact[0];
  }

  const names = candidateNames(stream);
  const exactTitle = torrents.filter((torrent) =>
    names.includes(normaliseRelease(torrent.rawTitle))
  );
  if (exactTitle.length === 1) return exactTitle[0];

  const size = streamSize(stream);
  if (size) {
    const sameSize = torrents.filter((torrent) => {
      const candidateSize = positiveNumber(torrent.sizeBytes);
      return (
        candidateSize !== undefined &&
        Math.abs(candidateSize - size) / Math.max(candidateSize, size) <= 0.01
      );
    });
    if (sameSize.length === 1) return sameSize[0];
    if (score !== undefined) {
      const sameSizeAndScore = sameSize.filter(
        (torrent) => positiveNumber(torrent.qualityScore) === score
      );
      if (sameSizeAndScore.length === 1) return sameSizeAndScore[0];
    }
  }

  return undefined;
}

async function requestTorrentClawTorrents(options: {
  id: string;
  type: string;
  apiKey?: string;
  timeout: number;
}): Promise<TorrentClawApiTorrent[]> {
  const parts = options.id.split(':');
  const url = new URL('/api/v1/search', API_BASE_URL);
  url.searchParams.set('q', parts[0]);
  url.searchParams.set('type', options.type === 'series' ? 'show' : 'movie');
  url.searchParams.set('limit', '5');
  if (options.type === 'series' && parts[1]) {
    url.searchParams.set('season', parts[1]);
  }
  if (options.type === 'series' && parts[2]) {
    url.searchParams.set('episode', parts[2]);
  }
  const response = await makeRequest(url.toString(), {
    timeout: options.timeout,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'AIOStreams TorrentClaw metadata enrichment',
      'X-Search-Source': 'aiostreams',
      ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`TorrentClaw enrichment failed (${response.status})`);
  }
  const payload = (await response.json()) as {
    results?: Array<{ imdbId?: string | null; torrents?: unknown }>;
  };
  const requestedId = parts[0].toLowerCase();
  const result = (payload.results || []).find(
    (item) => String(item.imdbId || '').toLowerCase() === requestedId
  );
  return Array.isArray(result?.torrents)
    ? (result.torrents as TorrentClawApiTorrent[])
    : [];
}

export async function getTorrentClawTorrents(options: {
  id: string;
  type: string;
  apiKey?: string;
  timeout?: number;
  maxWait?: number;
}): Promise<TorrentClawApiTorrent[]> {
  const cacheKey = [
    options.type,
    options.id.toLowerCase(),
    torrentClawAuthScope(options.apiKey),
  ].join(':');
  const live = getFresh(liveCache, cacheKey);
  const staticItems = getFresh(staticCache, cacheKey);
  if (live) return mergeLayers(staticItems || [], live);
  const existing = inFlight.get(cacheKey);
  if (existing) {
    if (!options.maxWait) return existing;
    return Promise.race([
      existing,
      new Promise<TorrentClawApiTorrent[]>((resolve) =>
        setTimeout(() => resolve(staticItems || []), options.maxWait)
      ),
    ]);
  }

  const request = (async () => {
    try {
      const fresh = await requestTorrentClawTorrents({
        ...options,
        timeout: Math.min(8_000, Math.max(1_500, options.timeout ?? 3_500)),
      });
      if (fresh.length) {
        setBounded(liveCache, cacheKey, fresh, LIVE_TTL_MS);
        setBounded(
          staticCache,
          cacheKey,
          fresh.map(staticTorrent),
          STATIC_TTL_MS
        );
      }
      return fresh.length ? fresh : staticItems || [];
    } catch (error) {
      logger.debug(
        { error: error instanceof Error ? error.message : String(error) },
        'TorrentClaw enrichment unavailable; preserving upstream streams'
      );
      return staticItems || [];
    }
  })();
  inFlight.set(cacheKey, request);
  request.finally(() => {
    inFlight.delete(cacheKey);
  });
  if (!options.maxWait) return request;
  return Promise.race([
    request,
    new Promise<TorrentClawApiTorrent[]>((resolve) =>
      setTimeout(() => resolve(staticItems || []), options.maxWait)
    ),
  ]);
}

export async function enrichTorrentClawStreams(options: {
  streams: Stream[];
  id: string;
  type: string;
  apiKey?: string;
  timeout?: number;
  maxWait?: number;
}): Promise<Stream[]> {
  if (!/^tt\d+/i.test(options.id)) return options.streams;
  const torrents = await getTorrentClawTorrents(options);
  if (!torrents.length) return options.streams;
  return options.streams.map((stream) => {
    const metadata = matchTorrentClawTorrent(stream, torrents);
    if (!metadata) return stream;
    return {
      ...stream,
      behaviorHints: {
        ...(stream.behaviorHints || {}),
        tcMetadata: metadata,
      },
    } as Stream;
  });
}

export function getTorrentClawMetadata(
  stream: Stream
): TorrentClawApiTorrent | undefined {
  return hintedMetadata(stream);
}

export function torrentClawThreatLevel(stream: Stream): string | undefined {
  const value = getTorrentClawMetadata(stream)?.threatLevel;
  return typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : undefined;
}

export function isUnsafeTorrentClawStream(stream: Stream): boolean {
  const threat = torrentClawThreatLevel(stream);
  return Boolean(
    threat && !['clean', 'safe', 'none', 'unknown'].includes(threat)
  );
}
