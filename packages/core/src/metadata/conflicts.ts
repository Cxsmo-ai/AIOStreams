/**
 * Finds same-name series (reboots, country variants) so queries and matching
 * filters can tell them apart. The TVDB source falls back to Skyhook when no
 * key is set or the keyed search fails.
 */
import { createLogger } from '../logging/logger.js';
import { normaliseTitle } from '../parser/utils.js';
import { appConfig } from '../utils/index.js';
import { TitleConflict } from './utils.js';
import { TMDBMetadata } from './tmdb.js';
import { TVDBMetadata } from './tvdb.js';
import { SkyhookMetadata } from './skyhook.js';

const logger = createLogger('title-conflicts');

const MAX_CONFLICTS = 10;

/** Strips disambiguators TVDB embeds in names: "The Office (CA) (2012)". */
export function stripTitleDisambiguators(title: string): string {
  let stripped = title;
  for (;;) {
    const next = stripped
      .replace(/\s*\((?:[A-Z]{2,3}|\d{4})\)\s*$/, '')
      .trimEnd();
    if (next === stripped || !next) return stripped;
    stripped = next;
  }
}

interface Candidate {
  title: string;
  year?: number;
  country?: string;
  tmdbId?: number;
  tvdbId?: number;
}

export interface DetectConflictsInput {
  /** The show's primary title (may still carry a TVDB disambiguator). */
  title: string;
  year?: number;
  country?: string;
  tmdbId?: number | null;
  tvdbId?: number | null;
  tmdbAuth?: { accessToken?: string; apiKey?: string };
  tvdbApiKey?: string;
}

export async function detectTitleConflicts(
  input: DetectConflictsInput
): Promise<TitleConflict[]> {
  const baseTitle = stripTitleDisambiguators(input.title);
  const normBase = normaliseTitle(baseTitle);
  if (!normBase) return [];

  const tmdbAvailable = !!(
    input.tmdbAuth?.accessToken ||
    input.tmdbAuth?.apiKey ||
    appConfig.metadata.tmdb.accessToken ||
    appConfig.metadata.tmdb.apiKey
  );
  const tvdbKeyAvailable = !!(
    input.tvdbApiKey || appConfig.metadata.tvdb.apiKey
  );

  const tmdbPromise: Promise<Candidate[]> = tmdbAvailable
    ? new TMDBMetadata(input.tmdbAuth)
        .searchSeries(baseTitle)
        .then((results) =>
          results
            .filter(
              (r) =>
                normaliseTitle(r.name ?? '') === normBase ||
                normaliseTitle(r.originalName ?? '') === normBase
            )
            .map((r) => ({
              title: r.name ?? baseTitle,
              year: r.year,
              country: r.country,
              tmdbId: r.tmdbId,
            }))
        )
        .catch((error) => {
          logger.debug(`TMDB conflict search failed: ${error}`);
          return [];
        })
    : Promise.resolve([]);

  const skyhookSearch = (): Promise<Candidate[]> =>
    new SkyhookMetadata()
      .search(baseTitle)
      .then((results) =>
        results
          .filter(
            (r) =>
              normaliseTitle(stripTitleDisambiguators(r.title)) === normBase
          )
          .map((r) => ({
            title: r.title,
            year: r.year,
            country: r.country,
            tvdbId: r.tvdbId,
          }))
      )
      .catch((error) => {
        logger.debug(`Skyhook conflict search failed: ${error}`);
        return [];
      });

  const tvdbPromise: Promise<Candidate[]> = tvdbKeyAvailable
    ? new TVDBMetadata({ apiKey: input.tvdbApiKey })
        .searchSeries(baseTitle)
        .then((results) =>
          results
            .filter(
              (r) =>
                normaliseTitle(stripTitleDisambiguators(r.name)) === normBase
            )
            .map((r) => ({
              title: r.name,
              year: r.year,
              country: r.country,
              tvdbId: r.tvdbId,
            }))
        )
        .catch((error) => {
          logger.debug(
            `TVDB conflict search failed, falling back to Skyhook: ${error}`
          );
          return skyhookSearch();
        })
    : skyhookSearch();

  const [tmdbCandidates, tvdbCandidates] = await Promise.all([
    tmdbPromise,
    tvdbPromise,
  ]);

  const isSelf = (c: Candidate) =>
    (c.tmdbId != null && input.tmdbId != null && c.tmdbId === input.tmdbId) ||
    (c.tvdbId != null && input.tvdbId != null && c.tvdbId === input.tvdbId) ||
    // cross-source identity when the id from that source is unknown
    (input.year !== undefined &&
      input.country !== undefined &&
      c.year === input.year &&
      c.country === input.country);

  // TMDB and TVDB entries for the same show carry different ids, so
  // cross-source dedup keys on (year, country).
  const byKey = new Map<string, Candidate>();
  for (const candidate of [...tmdbCandidates, ...tvdbCandidates]) {
    if (isSelf(candidate)) continue;
    if (candidate.year === undefined && candidate.country === undefined)
      continue;
    const key = `${candidate.year ?? '?'}:${candidate.country ?? '?'}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.tmdbId ??= candidate.tmdbId;
      existing.tvdbId ??= candidate.tvdbId;
    } else {
      byKey.set(key, { ...candidate });
    }
  }

  return [...byKey.values()]
    .sort((a, b) => (a.year ?? Infinity) - (b.year ?? Infinity))
    .slice(0, MAX_CONFLICTS);
}
