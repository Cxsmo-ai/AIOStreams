const HARBRR_RELEASE_COUNTRY_TAG = /\b(?:US|UK|GB|AU|NZ|CA)\b(?=\s+(?:S\d{1,2}|E\d{1,3}|\d{1,3})\b)/gi;
const HARBRR_SEASON_ONLY_QUERY = /\sS\d{1,2}$/i;

/**
 * Some metadata providers append a country disambiguator to a show's title
 * (for example, "The Mentalist US S01"). Tracker search commonly treats that
 * token as literal title text and returns nothing, while the countryless
 * release name is searchable. Keep the original query and add a conservative
 * fallback so a legitimate title is never removed.
 */
export function expandHarbrrQueries(
  queries: string[],
  options: { includeSeasonPackQueries?: boolean } = {}
): string[] {
  const expanded: string[] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    const candidates = [
      query,
      query
        .replace(HARBRR_RELEASE_COUNTRY_TAG, '')
        .replace(/\s{2,}/g, ' ')
        .trim(),
    ];
    for (const candidate of candidates) {
      // Season packs often contain the requested episode but do not include
      // an episode marker in the release title. A focused Blu-ray query makes
      // those packs visible early enough for paced private trackers to have
      // their authenticated torrent links checked by the configured debrid
      // services. The original and countryless queries remain unchanged, and
      // all their results are still retained.
      if (
        options.includeSeasonPackQueries &&
        candidate === candidates[1] &&
        HARBRR_SEASON_ONLY_QUERY.test(candidate)
      ) {
        const packQuery = `${candidate} BluRay`;
        if (!seen.has(packQuery)) {
          seen.add(packQuery);
          expanded.push(packQuery);
        }
      }
      if (candidate && !seen.has(candidate)) {
        seen.add(candidate);
        expanded.push(candidate);
      }
    }
  }
  return expanded;
}
