import {
  createLogger,
  makeRequest,
  Cache,
  appConfig,
  languageToCode,
  normaliseLanguage,
} from '../utils/index.js';
import { Subtitle } from '../db/schemas.js';

const logger = createLogger('deepbrid:subtitles');

export const DEEPBRID_SUBTITLE_BASE = 'https://streaming-2.myfast.link:8443';
export const DEEPBRID_SUBTITLE_USER_AGENT =
  'Deepbrid/1.0 (ios) DBX/k9Q4mZ2xV7bN1pR8sT3wY6cH0jL5dF';

export interface DeepbridOpenSubtitleItem {
  file_id: number | string;
  file_name?: string;
  release?: string;
  title?: string;
  lang?: string;
  hearing_impaired?: boolean;
  ai_translated?: boolean;
  downloads?: number;
  year?: number;
}

export interface DeepbridOpenSubtitleSearchResponse {
  query?: string;
  results?: DeepbridOpenSubtitleItem[];
}

function normaliseSearchText(value: string) {
  return value
    .replace(/&amp;/gi, ' and ')
    .replace(/\.[a-z]{2,4}$/i, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

function requestedSubtitleParts(query: string) {
  const raw = query.trim();
  const episodeMatch = raw.match(
    /\b(?:s(\d{1,3})\s*e(\d{1,3})|(\d{1,3})\s*x\s*(\d{1,3})|season\s*(\d{1,3})\s*episode\s*(\d{1,3}))\b/i
  );
  const yearMatch = raw.match(/\b(19\d{2}|20\d{2})\b/);
  const season = episodeMatch
    ? Number(episodeMatch[1] ?? episodeMatch[3] ?? episodeMatch[5])
    : undefined;
  const episode = episodeMatch
    ? Number(episodeMatch[2] ?? episodeMatch[4] ?? episodeMatch[6])
    : undefined;
  const title = normaliseSearchText(
    raw
      .replace(episodeMatch?.[0] ?? '', ' ')
      .replace(yearMatch?.[0] ?? '', ' ')
  );
  return {
    title,
    year: yearMatch ? Number(yearMatch[1]) : undefined,
    season,
    episode,
  };
}

function releaseEpisode(value: string) {
  const match = value.match(
    /\bs(\d{1,3})\s*e(\d{1,3})\b|\b(\d{1,3})\s*x\s*(\d{1,3})\b|\bseason\s*(\d{1,3})\s*episode\s*(\d{1,3})\b/i
  );
  if (!match) return undefined;
  return {
    season: Number(match[1] ?? match[3] ?? match[5]),
    episode: Number(match[2] ?? match[4] ?? match[6]),
    index: match.index ?? 0,
  };
}

function releaseCore(value: string, requested: ReturnType<typeof requestedSubtitleParts>) {
  let text = value.replace(/^\[[^\]]+\]\s*/, '');
  const marker = releaseEpisode(text);
  if (marker) text = text.slice(0, marker.index);
  if (requested.year) {
    const yearIndex = text.search(new RegExp(`\\b${requested.year}\\b`));
    if (yearIndex >= 0) text = text.slice(0, yearIndex);
  }
  // Releases commonly place the series/movie year between the title and the
  // season marker even when the incoming query does not include a year.
  text = text.replace(/\b(?:19|20)\d{2}\b/g, ' ');
  text = text.replace(
    /\b(?:2160p|1080p|720p|576p|540p|480p|360p|4k|8k|uhd|hdr|web[- ]?dl|web[- ]?rip|webrip|bluray|brrip|dvdrip|hdtv|xvid|x264|x265|h264|h265|hevc|remux|proper|repack|extended|uncut|multi|dual|forced|sdh|hi|cc|cd\s*\d+|disc\s*\d+|part\s*\d+)\b.*$/i,
    ''
  );
  return normaliseSearchText(text);
}

/** Rejects fuzzy OpenSubtitles hits for another title, year, or episode. */
export function matchesDeepbridSubtitleQuery(
  item: DeepbridOpenSubtitleItem,
  query: string
) {
  const requested = requestedSubtitleParts(query);
  if (!requested.title) return false;
  if (requested.year && item.year && Number(item.year) !== requested.year) return false;

  const candidates = [item.file_name, item.release, item.title]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()));
  const episodeMarkers = candidates
    .map((value) => releaseEpisode(value))
    .filter((value): value is NonNullable<ReturnType<typeof releaseEpisode>> => Boolean(value));
  if (
    requested.season !== undefined &&
    requested.episode !== undefined &&
    episodeMarkers.some(
      (marker) =>
        marker.season !== requested.season || marker.episode !== requested.episode
    )
  ) {
    return false;
  }

  return candidates.some((value) => releaseCore(value, requested) === requested.title);
}

export function filterDeepbridSubtitles(
  items: DeepbridOpenSubtitleItem[],
  query: string,
  lang?: string
) {
  const requestedLanguage = normaliseLanguage(lang)?.toLowerCase();
  const seen = new Set<string>();
  return items.filter((item) => {
    const fileId = String(item.file_id ?? '').trim();
    if (!/^\d+$/.test(fileId) || Number(fileId) <= 0 || seen.has(fileId)) return false;
    const itemLanguage = normaliseLanguage(item.lang)?.toLowerCase();
    if (requestedLanguage && itemLanguage && itemLanguage !== requestedLanguage) return false;
    if (!matchesDeepbridSubtitleQuery(item, query)) return false;
    seen.add(fileId);
    return true;
  });
}

const subtitleSearchCache = Cache.getInstance<string, DeepbridOpenSubtitleItem[]>(
  // v2 invalidates entries created before exact title/episode validation was
  // added; otherwise a stale fuzzy result could survive for an hour.
  'deepbrid:subtitles:search:v2',
  300,
  appConfig.bootstrap.redisUri ? 'redis' : 'sql'
);

/**
 * Search Deepbrid OpenSubtitles endpoint for matching subtitles
 */
export async function searchDeepbridOpenSubtitles(
  query: string,
  lang: string = 'en',
  options?: { timeout?: number; signal?: AbortSignal }
): Promise<DeepbridOpenSubtitleItem[]> {
  const cleanQuery = query.trim();
  if (!cleanQuery) return [];

  const cacheKey = `${cleanQuery.toLowerCase()}:${lang.toLowerCase()}`;
  const cached = await subtitleSearchCache.get(cacheKey);
  if (cached) return filterDeepbridSubtitles(cached, cleanQuery, lang);

  const url = `${DEEPBRID_SUBTITLE_BASE}/web/sub/ossearch?query=${encodeURIComponent(
    cleanQuery
  )}&lang=${encodeURIComponent(lang)}&url=`;

  try {
    const res = await makeRequest(url, {
      method: 'GET',
      headers: {
        'User-Agent': DEEPBRID_SUBTITLE_USER_AGENT,
        Referer: 'https://www.deepbrid.com/',
      },
      timeout: options?.timeout ?? 10_000,
      signal: options?.signal,
    });

    if (!res.ok) {
      logger.warn(
        { status: res.status, query: cleanQuery },
        'Deepbrid OpenSubtitles search returned non-OK status'
      );
      return [];
    }

    const data = (await res.json()) as DeepbridOpenSubtitleSearchResponse;
    const results = Array.isArray(data.results)
      ? filterDeepbridSubtitles(data.results, cleanQuery, lang)
      : [];
    await subtitleSearchCache.set(cacheKey, results, 3600);
    return results;
  } catch (err: any) {
    logger.warn(
      { err: err?.message, query: cleanQuery },
      'Failed to search Deepbrid OpenSubtitles'
    );
    return [];
  }
}

/**
 * Convert OpenSubtitles items into standardized, beautifully formatted Stremio Subtitle descriptors
 */
export function formatDeepbridSubtitles(
  items: DeepbridOpenSubtitleItem[],
  baseUrl: string,
  maxResults: number = 8
): Subtitle[] {
  const root = baseUrl.replace(/\/+$/, '');
  const limit = Number.isFinite(maxResults)
    ? Math.max(0, Math.floor(maxResults))
    : 0;
  return items.filter((item) => /^\d+$/.test(String(item.file_id ?? ''))).slice(0, limit).map((item) => {
    const rawLang = typeof item.lang === 'string' && item.lang.trim() ? item.lang.trim() : 'en';
    const langName = normaliseLanguage(rawLang) || rawLang;
    const langCode = languageToCode(langName)?.toLowerCase() || rawLang.toLowerCase();
    
    // Clean release/title
    const releaseTitle = (item.release || item.file_name || item.title || 'OpenSubtitles')
      .replace(/\.srt$|\.vtt$/i, '')
      .trim();

    const hiTag = item.hearing_impaired ? ' [SDH]' : '';
    const aiTag = item.ai_translated ? ' [AI]' : '';
    const dlCount = item.downloads ? ` (${item.downloads} dl)` : '';

    // Standard Stremio Subtitle specification
    const displayTitle = `[DB] ${releaseTitle}${hiTag}${aiTag}${dlCount}`;
    const cleanFilename = `${encodeURIComponent(
      releaseTitle.replace(/[^a-zA-Z0-9.-]/g, '_')
    )}.vtt`;
    const url = `${root}/builtins/deepbrid-subtitles/download/${item.file_id}/${cleanFilename}`;

    return {
      id: `deepbrid-os-${item.file_id}`,
      url,
      lang: langCode,
      title: displayTitle,
    };
  });
}
