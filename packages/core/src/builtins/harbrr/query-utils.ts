const HARBRR_RELEASE_COUNTRY_TAG = /\b(?:US|UK|GB|AU|NZ|CA)\b(?=\s+(?:S\d{1,2}|E\d{1,3}|\d{1,3})\b)/gi;

/**
 * Some metadata providers append a country disambiguator to a show's title
 * (for example, "The Mentalist US S01"). Tracker search commonly treats that
 * token as literal title text and returns nothing, while the countryless
 * release name is searchable. Keep the original query and add a conservative
 * fallback so a legitimate title is never removed.
 */
export function expandHarbrrQueries(queries: string[]): string[] {
  const expanded: string[] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    for (const candidate of [
      query,
      query
        .replace(HARBRR_RELEASE_COUNTRY_TAG, '')
        .replace(/\s{2,}/g, ' ')
        .trim(),
    ]) {
      if (candidate && !seen.has(candidate)) {
        seen.add(candidate);
        expanded.push(candidate);
      }
    }
  }
  return expanded;
}
