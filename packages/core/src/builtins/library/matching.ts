import {
  ParsedId,
  BuiltinServiceId,
  createLogger,
  getTimeTakenSincePoint,
  constants,
} from '../../utils/index.js';
import {
  NZB,
  UnprocessedTorrent,
  DebridDownload,
  getDebridService,
  isCountryWrong,
  isTorrentDebridService,
  isUsenetDebridService,
} from '../../debrid/index.js';
import {
  titleMatch,
  cleanTitle,
  preprocessTitle,
  normaliseTitle,
} from '../../parser/utils.js';
import { parseTorrentTitleCached } from '../../parser/title.js';
import { SearchMetadata } from '../base/debrid.js';

const logger = createLogger('library');

const TITLE_MATCH_THRESHOLD = 0.85;

/**
 * Matches title-based criteria against a download item name.
 */
export function isItemMatch(
  itemName: string,
  metadata: SearchMetadata,
  parsedId: ParsedId
): boolean {
  const parsed = parseTorrentTitleCached(itemName);
  const preprocessedTitle = preprocessTitle(
    parsed.title ?? '',
    itemName,
    metadata.titles
  );

  // Title match
  const cleanedTitles = metadata.titles.map((title) => cleanTitle(title));
  if (
    !titleMatch(cleanTitle(preprocessedTitle), cleanedTitles, {
      threshold: TITLE_MATCH_THRESHOLD,
    })
  ) {
    return false;
  }

  if (isCountryWrong(parsed, metadata)) {
    return false;
  }

  // For series, check season/episode matching
  if (parsedId.mediaType === 'series') {
    const season = parsedId.season ? Number(parsedId.season) : undefined;
    const episode = parsedId.episode ? Number(parsedId.episode) : undefined;

    // a parsed release date is authoritative when the requested air date is
    // known
    const parsedDate = parsed.date || undefined;
    if (parsedDate && metadata.airDates?.length) {
      return metadata.airDates.includes(parsedDate);
    }

    // If the item has season info, check it matches
    if (parsed.seasons && parsed.seasons.length > 0 && season !== undefined) {
      if (!parsed.seasons.includes(season)) {
        return false;
      }
    }

    // If we need a specific episode, verify it's a season pack or has the right episode
    // Season packs (no episode info) are valid matches for any episode in that season
    if (
      episode !== undefined &&
      parsed.episodes &&
      parsed.episodes.length > 0
    ) {
      const absoluteEpisode = metadata.absoluteEpisode;
      const relativeAbsoluteEpisode = metadata.relativeAbsoluteEpisode;
      const hasMatchingEpisode =
        parsed.episodes.includes(episode) ||
        (absoluteEpisode !== undefined &&
          parsed.episodes.includes(absoluteEpisode)) ||
        (relativeAbsoluteEpisode !== undefined &&
          parsed.episodes.includes(relativeAbsoluteEpisode));

      if (!hasMatchingEpisode) {
        return false;
      }
    }
  }

  return true;
}

export function matchTorrents(
  items: DebridDownload[],
  metadata: SearchMetadata,
  parsedId: ParsedId,
  sourceServiceId?: BuiltinServiceId
): UnprocessedTorrent[] {
  const results: UnprocessedTorrent[] = [];

  for (const item of items) {
    if (!item.name || !item.hash) continue;
    if (item.status !== 'cached' && item.status !== 'downloaded') continue;

    if (!isItemMatch(item.name, metadata, parsedId)) continue;

    results.push({
      type: 'torrent',
      hash: item.hash,
      sources: [],
      title: item.name,
      size: item.size ?? 0,
      library: true,
      confirmed: true,
      indexer: sourceServiceId,
      serviceItemId: item.id.toString(),
    });
  }

  return results;
}

export function matchNzbs(
  items: DebridDownload[],
  metadata: SearchMetadata,
  parsedId: ParsedId,
  sourceServiceId?: BuiltinServiceId
): NZB[] {
  const results: NZB[] = [];

  for (const item of items) {
    if (!item.name) continue;
    if (item.status !== 'cached' && item.status !== 'downloaded') continue;

    if (!isItemMatch(item.name, metadata, parsedId)) continue;

    results.push({
      type: 'usenet',
      hash: item.hash ?? item.name,
      nzb: '', // no NZB data needed — item is already on account
      title: item.name,
      size: item.size ?? 0,
      library: true,
      confirmed: true,
      indexer: sourceServiceId,
      serviceItemId: item.id.toString(),
    });
  }

  return results;
}

/**
 * Searches for matching torrents across all configured torrent-capable services.
 */
export async function searchTorrents(
  services: { id: BuiltinServiceId; credential: string }[],
  metadata: SearchMetadata,
  parsedId: ParsedId,
  clientIp?: string
): Promise<UnprocessedTorrent[]> {
  const servicePromises = services.map(async (service) => {
    try {
      let start = Date.now();
      const debridService = getDebridService(
        service.id,
        service.credential,
        clientIp
      );
      if (!isTorrentDebridService(debridService)) return [];
      const items = await debridService.listMagnets();
      const searchTime = getTimeTakenSincePoint(start);
      start = Date.now();
      const matched = matchTorrents(items, metadata, parsedId, service.id);
      logger.info(`Matched torrents from service library`, {
        serviceId: service.id,
        totalItems: items.length,
        matchedItems: matched.length,
        searchTime,
        matchTime: getTimeTakenSincePoint(start),
      });
      return matched;
    } catch (error) {
      logger.warn(`Failed to list magnets from ${service.id}`, {
        error: (error as Error).message,
      });
      return [];
    }
  });

  const results = await Promise.all(servicePromises);
  const allTorrents = results.flat();

  // Deduplicate by hash, service item id, and finally exact release name plus
  // size.  The id fallback matters for providers that omit torrent hashes.
  const seen = new Set<string>();
  return allTorrents.filter((t) => {
    const keys = [
      t.hash ? `hash:${t.hash.toLowerCase()}` : undefined,
      t.serviceItemId ? `id:${t.serviceItemId}` : undefined,
      `release:${normaliseTitle(t.title ?? '')}:size:${t.size ?? 0}`,
    ].filter((key): key is string => Boolean(key));
    if (keys.some((key) => seen.has(key))) return false;
    for (const key of keys) seen.add(key);
    return true;
  });
}

/**
 * Searches for matching NZBs across all configured NZB-capable services.
 */
export async function searchNzbs(
  services: { id: BuiltinServiceId; credential: string }[],
  metadata: SearchMetadata,
  parsedId: ParsedId,
  clientIp?: string
): Promise<NZB[]> {
  const servicePromises = services.map(async (service) => {
    try {
      let start = Date.now();
      const debridService = getDebridService(
        service.id,
        service.credential,
        clientIp
      );
      if (service.id === constants.DEEPBRID_SERVICE) return [];
      if (!isUsenetDebridService(debridService) || !debridService.listNzbs)
        return [];
      const items = await debridService.listNzbs();
      const searchTime = getTimeTakenSincePoint(start);
      start = Date.now();
      const matched = matchNzbs(items, metadata, parsedId, service.id);
      const matchTime = getTimeTakenSincePoint(start);
      logger.info(`Matched NZBs from service library`, {
        serviceId: service.id,
        totalItems: items.length,
        matchedItems: matched.length,
        searchTime,
        matchTime,
      });
      return matched;
    } catch (error) {
      logger.warn(`Failed to list NZBs from ${service.id}`, {
        error: (error as Error).message,
      });
      return [];
    }
  });

  const results = await Promise.all(servicePromises);
  const allNzbs = results.flat();

  // Keep the same identity rules as torrent library matching. In particular,
  // an NZB row without a hash must still not be emitted twice.
  const seen = new Set<string>();
  return allNzbs.filter((n) => {
    const keys = [
      n.hash ? `hash:${n.hash.toLowerCase()}` : undefined,
      n.serviceItemId ? `id:${n.serviceItemId}` : undefined,
      `release:${normaliseTitle(n.title ?? '')}:size:${n.size ?? 0}`,
    ].filter((key): key is string => Boolean(key));
    if (keys.some((key) => seen.has(key))) return false;
    for (const key of keys) seen.add(key);
    return true;
  });
}
