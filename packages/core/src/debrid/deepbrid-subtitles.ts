import { createLogger, makeRequest, Cache, appConfig, normaliseLanguage } from '../utils/index.js';
import { Subtitle } from '../db/schemas.js';

const logger = createLogger('deepbrid:subtitles');

export const DEEPBRID_SUBTITLE_BASE = 'https://streaming-2.myfast.link:8443';
export const DEEPBRID_SUBTITLE_USER_AGENT =
  'Deepbrid/1.0 (ios) DBX/k9Q4mZ2xV7bN1pR8sT3wY6cH0jL5dF';

export interface DeepbridOpenSubtitleItem {
  file_id: number;
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

const subtitleSearchCache = Cache.getInstance<string, DeepbridOpenSubtitleItem[]>(
  'deepbrid:subtitles:search',
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
  if (cached) return cached;

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
    const results = Array.isArray(data.results) ? data.results : [];
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
  return items.slice(0, maxResults).map((item) => {
    const rawLang = item.lang || 'en';
    const langName = normaliseLanguage(rawLang) || rawLang;
    
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
      lang: rawLang.toLowerCase(),
      title: displayTitle,
    };
  });
}
