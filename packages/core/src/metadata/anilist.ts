import { Cache } from '../utils/cache.js';
import { appConfig } from '../utils/index.js';
import { makeRequest } from '../utils/http.js';
import { createLogger } from '../logging/logger.js';
import type { Metadata } from './utils.js';

const logger = createLogger('anilist');
const ANILIST_URL = 'https://graphql.anilist.co';
const CACHE_TTL_SECONDS = 24 * 60 * 60;
const REQUEST_TIMEOUT_MS = 3500;

const MEDIA_QUERY = `
  query ($id: Int!) {
    Media(id: $id) {
      title { romaji english native userPreferred }
      startDate { year month day }
      endDate { year month day }
      duration
      genres
      countryOfOrigin
    }
  }
`;

interface AniListMedia {
  title?: {
    romaji?: string | null;
    english?: string | null;
    native?: string | null;
    userPreferred?: string | null;
  } | null;
  startDate?: { year?: number | null; month?: number | null; day?: number | null } | null;
  endDate?: { year?: number | null; month?: number | null; day?: number | null } | null;
  duration?: number | null;
  genres?: string[] | null;
  countryOfOrigin?: string | null;
}

interface AniListResponse {
  data?: { Media?: AniListMedia | null };
  errors?: unknown[];
}

const cache = Cache.getInstance<string, Metadata | null>('anilist:metadata');

function isoDate(value?: AniListMedia['startDate']): string | undefined {
  if (!value?.year) return undefined;
  const month = String(value.month ?? 1).padStart(2, '0');
  const day = String(value.day ?? 1).padStart(2, '0');
  return `${value.year}-${month}-${day}`;
}

function firstTitle(title?: AniListMedia['title']): string | undefined {
  return [title?.english, title?.userPreferred, title?.romaji, title?.native]
    .find((value): value is string => !!value?.trim())
    ?.trim();
}

/** Public, keyless enrichment for anime records with a trusted AniList ID. */
export async function getAniListMetadata(
  anilistId: number
): Promise<Metadata | undefined> {
  if (!Number.isInteger(anilistId) || anilistId <= 0) return undefined;

  const cacheKey = String(anilistId);
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  try {
    const response = await makeRequest(ANILIST_URL, {
      method: 'POST',
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': appConfig.http.defaultUserAgent,
      },
      body: JSON.stringify({ query: MEDIA_QUERY, variables: { id: anilistId } }),
    });
    if (!response.ok) return undefined;

    const payload = (await response.json()) as AniListResponse;
    const media = payload.data?.Media;
    const title = firstTitle(media?.title);
    if (!media || !title || payload.errors?.length) return undefined;

    const titles = [
      media.title?.english,
      media.title?.userPreferred,
      media.title?.romaji,
      media.title?.native,
    ]
      .filter((value): value is string => !!value?.trim())
      .map((value) => value.trim())
      .filter((value, index, values) => values.indexOf(value) === index)
      .map((value) => ({ title: value }));
    const startDate = isoDate(media.startDate);
    const endDate = isoDate(media.endDate);
    const metadata: Metadata = {
      title,
      titles,
      year: media.startDate?.year ?? undefined,
      yearEnd: media.endDate?.year ?? undefined,
      originalLanguage:
        media.countryOfOrigin?.toLowerCase() === 'jp' ? 'ja' : undefined,
      country: media.countryOfOrigin?.toLowerCase() ?? undefined,
      runtime: media.duration ?? undefined,
      genres: media.genres ?? undefined,
      releaseDate: startDate,
      firstAiredDate: startDate,
      lastAiredDate: endDate,
    };
    await cache.set(cacheKey, metadata, CACHE_TTL_SECONDS);
    return metadata;
  } catch (error) {
    logger.debug(`AniList lookup failed for ${anilistId}: ${error}`);
    return undefined;
  }
}
