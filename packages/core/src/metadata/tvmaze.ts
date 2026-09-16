import { Cache } from '../utils/cache.js';
import { appConfig } from '../utils/index.js';
import { makeRequest } from '../utils/http.js';
import { createLogger } from '../logging/logger.js';
import type { ParsedMeta } from '../db/schemas.js';

const logger = createLogger('tvmaze');
const TVMAZE_BASE = 'https://api.tvmaze.com';
const LOOKUP_TTL_SECONDS = 24 * 60 * 60;
const EPISODE_TTL_SECONDS = 12 * 60 * 60;
const REQUEST_TIMEOUT_MS = 3500;
type MetaVideo = NonNullable<ParsedMeta['videos']>[number];

interface TvMazeShow {
  id: number;
  name: string;
  premiered?: string | null;
}

interface TvMazeEpisode {
  name?: string | null;
  season?: number | null;
  number?: number | null;
  airdate?: string | null;
  airstamp?: string | null;
  summary?: string | null;
  image?: { medium?: string | null; original?: string | null } | null;
}

const showLookupCache = Cache.getInstance<string, TvMazeShow | null>(
  'tvmaze:show'
);
const episodeCache = Cache.getInstance<number, TvMazeEpisode[]>(
  'tvmaze:episodes'
);

function normalise(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

function stripHtml(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const text = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || undefined;
}

function releaseYear(meta: ParsedMeta): number | undefined {
  const value = String(meta.releaseInfo ?? '').match(/\b(19|20)\d{2}\b/)?.[0];
  const year = value ? Number(value) : undefined;
  return year && Number.isFinite(year) ? year : undefined;
}

function isSupportedSeriesId(id: string): boolean {
  return /^(?:tt\d+|(?:tmdb|tvdb)[:\-]\d+)(?::\d+:\d+)?$/i.test(id);
}

function rootMetaId(id: string): string {
  const match = id.match(/^(tt\d+|(?:tmdb|tvdb)[:\-]\d+)/i);
  return match?.[1] ?? id;
}

async function lookupShow(
  id: string,
  meta: ParsedMeta
): Promise<TvMazeShow | null> {
  const parsed = id.match(/^(tt\d+|tmdb[:\-]\d+|tvdb[:\-]\d+)/i);
  const lookupKey =
    parsed?.[1].toLowerCase() ?? `name:${normalise(meta.name ?? '')}`;
  // Do not treat a transient provider timeout as a 24-hour answer. Older
  // versions used Cache.wrap(), which persisted null and made an IMDb lookup
  // stay empty until its negative TTL expired even after TVMaze recovered.
  const cached = await showLookupCache.get(lookupKey);
  if (cached) return cached;

  try {
    let show: TvMazeShow | null = null;
    if (/^tt\d+$/i.test(lookupKey) || /^tvdb[:\-]\d+$/i.test(lookupKey)) {
      const parameter = /^tt/i.test(lookupKey) ? 'imdb' : 'thetvdb';
      const value = lookupKey.match(/\d+$/)?.[0];
      const response = await makeRequest(
        `${TVMAZE_BASE}/lookup/shows?${parameter}=${value}`,
        {
          method: 'GET',
          timeout: REQUEST_TIMEOUT_MS,
          headers: { 'User-Agent': appConfig.http.defaultUserAgent },
        }
      );
      if (response.ok) show = (await response.json()) as TvMazeShow;
    }

    if (!show && meta.name) {
      const response = await makeRequest(
        `${TVMAZE_BASE}/search/shows?q=${encodeURIComponent(meta.name)}`,
        {
          method: 'GET',
          timeout: REQUEST_TIMEOUT_MS,
          headers: { 'User-Agent': appConfig.http.defaultUserAgent },
        }
      );
      if (response.ok) {
        const results = (await response.json()) as Array<{
          show?: TvMazeShow;
        }>;
        const wantedName = normalise(meta.name);
        const wantedYear = releaseYear(meta);
        const exactMatches = results
          .map((result) => result.show)
          .filter(
            (candidate): candidate is TvMazeShow =>
              !!candidate && normalise(candidate.name) === wantedName
          );
        show =
          exactMatches.find(
            (candidate) =>
              !!wantedYear &&
              candidate.premiered?.startsWith(String(wantedYear))
          ) ??
          exactMatches[0] ??
          null;
      }
    }
    // Only successful matches are cached. A null result is intentionally
    // retryable so a temporary TVMaze/network failure self-heals quickly.
    if (show) await showLookupCache.set(lookupKey, show, LOOKUP_TTL_SECONDS);
    return show;
  } catch (error) {
    logger.debug(`TVMaze show lookup failed for ${id}: ${error}`);
    return null;
  }
}

async function getEpisodes(showId: number): Promise<TvMazeEpisode[]> {
  return episodeCache.wrap(
    async () => {
      try {
        const response = await makeRequest(
          `${TVMAZE_BASE}/shows/${showId}/episodes?specials=0`,
          {
            method: 'GET',
            timeout: REQUEST_TIMEOUT_MS,
            headers: { 'User-Agent': appConfig.http.defaultUserAgent },
          }
        );
        if (!response.ok) return [];
        const value = (await response.json()) as TvMazeEpisode[];
        return Array.isArray(value) ? value : [];
      } catch (error) {
        logger.debug(`TVMaze episode lookup failed for ${showId}: ${error}`);
        return [];
      }
    },
    showId,
    EPISODE_TTL_SECONDS
  );
}

function tvMazeVideo(rootId: string, episode: TvMazeEpisode): MetaVideo | null {
  if (
    typeof episode.season !== 'number' ||
    episode.season < 1 ||
    typeof episode.number !== 'number' ||
    episode.number < 1
  )
    return null;
  return {
    id: `${rootId}:${episode.season}:${episode.number}`,
    title: episode.name || null,
    season: episode.season,
    episode: episode.number,
    released: episode.airstamp || episode.airdate || undefined,
    thumbnail: episode.image?.original || episode.image?.medium || undefined,
    overview: stripHtml(episode.summary),
    available: episode.airdate
      ? new Date(`${episode.airdate}T23:59:59Z`).getTime() <= Date.now()
      : null,
  };
}

/** Add missing current episodes while preserving addon metadata and streams. */
export async function supplementSeriesMetaWithTvMaze(
  id: string,
  meta: ParsedMeta
): Promise<ParsedMeta> {
  if (!isSupportedSeriesId(id) || !meta || meta.type !== 'series') return meta;
  const show = await lookupShow(id, meta);
  if (!show) return meta;
  const episodes = await getEpisodes(show.id);
  if (!episodes.length) return meta;

  const existing = new Map<string, MetaVideo>();
  for (const video of meta.videos ?? []) {
    if (typeof video.season !== 'number' || typeof video.episode !== 'number')
      continue;
    existing.set(`${video.season}:${video.episode}`, video);
  }
  for (const episode of episodes) {
    const video = tvMazeVideo(rootMetaId(id), episode);
    if (!video) continue;
    const key = `${video.season}:${video.episode}`;
    const current = existing.get(key);
    if (!current) {
      existing.set(key, video);
      continue;
    }
    existing.set(key, {
      ...video,
      ...current,
      title: current.title || video.title,
      name: current.name || video.name,
      released: current.released || video.released,
      thumbnail: current.thumbnail || video.thumbnail,
      overview: current.overview || video.overview,
      available: current.available ?? video.available,
    });
  }
  return {
    ...meta,
    videos: [...existing.values()].sort(
      (a, b) =>
        Number(a.season ?? 0) - Number(b.season ?? 0) ||
        Number(a.episode ?? 0) - Number(b.episode ?? 0)
    ),
  };
}
