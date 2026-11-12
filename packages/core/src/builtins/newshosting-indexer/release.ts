export interface NewshostingMediaRequest {
  type: 'movie' | 'series';
  season?: number;
  episode?: number;
}

export interface NewshostingMediaMetadata {
  title?: string;
  aliases?: string[];
  year?: number;
  /** Preferred cut when known (e.g. extended, director's cut, remastered). */
  edition?: string;
  countries?: string[];
  isAnime?: boolean;
}

export interface ParsedNewshostingRelease {
  resolution: '2160p' | '1080p' | '720p' | '480p' | 'unknown';
  quality: 'REMUX' | 'BluRay' | 'WEB-DL' | 'WEBRip' | 'HDTV' | 'unknown';
  codec: 'x265' | 'x264' | 'AV1' | 'unknown';
  hdr: 'HDR10' | 'DV' | 'HDR10+' | 'none' | 'unknown';
  /** All filename-inferred HDR labels; a release can carry multiple tags. */
  hdrFormats?: Array<'HDR10' | 'DV' | 'HDR10+'>;
  edition?: 'theatrical' | 'extended' | 'directors-cut' | 'remastered';
  audio?: string;
  /** Channel layout inferred from the release name, not from a media probe. */
  audioChannels?: string;
  /** Audio format tags inferred from the release name, in source order. */
  audioFormats?: string[];
  /** Spoken-language codes inferred from common release-name tags only. */
  languages?: string[];
  releaseGroup?: string;
  normalizedTitle: string;
  season?: number;
  episode?: number;
  absoluteEpisode?: number;
  episodeRange?: { start: number; end: number };
  seasonPack?: boolean;
  sizeBytes?: number;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseSizeBytes(title: string): number | undefined {
  const match = title.match(/(\d+(?:\.\d+)?)\s*(gb|gib|mb|mib)\b/i);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return undefined;
  return Math.round(
    value * (match[2].toLowerCase().startsWith('g') ? 1_073_741_824 : 1_048_576)
  );
}

function parseEdition(title: string): ParsedNewshostingRelease['edition'] {
  if (
    /\b(?:director'?s[ ._-]*cut|the[ ._-]*director'?s[ ._-]*edition)\b/i.test(
      title
    )
  )
    return 'directors-cut';
  if (/\b(?:extended(?:[ ._-]*edition)?|unrated[ ._-]*extended)\b/i.test(title))
    return 'extended';
  if (
    /\b(?:theatrical(?:[ ._-]*cut|[ ._-]*edition)?|cinema[ ._-]*cut)\b/i.test(
      title
    )
  )
    return 'theatrical';
  if (
    /\b(?:remaster(?:ed)?|restored(?:[ ._-]*edition)?|4k[ ._-]*remaster)\b/i.test(
      title
    )
  )
    return 'remastered';
  return undefined;
}

function normalizeReleaseTitle(title: string, releaseGroup?: string): string {
  let normalized = title;
  if (releaseGroup) {
    const escaped = releaseGroup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    normalized = normalized.replace(
      new RegExp(`(?:[-_.\\s]|\\[)${escaped}(?:\\])?$`, 'i'),
      ' '
    );
  }
  return normalized
    .replace(/\[[^\]]+\]|\([^)]+\)/g, ' ')
    .replace(
      /\b(?:2160p|1080p|720p|480p|4k|uhd|hdr10\+?|hdr|dv|dovi|dolby vision|remux|blu-?ray|web-?dl|webrip|hdtv|x26[45]|h26[45]|hevc|avc|av1|aac|ac3|eac3|ddp?5\.1|ddp?7\.1|atmos|truehd|dts(?:[.\s-]*x|[.\s-]*hd(?:[.\s-]*ma)?)?|ma|flac|(?:1|2|5|7)\.\d(?:\.\d)?|proper|repack|internal|multi|subbed|dubbed|dual audio|complete|season\s*\d{1,2}|season|pack|mkv|mp4|avi|rar|7z|zip|theatrical(?:[ ._-]*cut|[ ._-]*edition)?|extended(?:[ ._-]*edition)?|director'?s[ ._-]*cut|remaster(?:ed)?|restored(?:[ ._-]*edition)?|cinema[ ._-]*cut)\b/gi,
      ' '
    )
    .replace(/\bs\d{1,2}(?:[\s._-]*e\d{1,3}(?:[\s._-]*e\d{1,3})?)?\b/gi, ' ')
    .replace(/\b\d{1,2}x\d{1,3}\b/gi, ' ')
    .replace(/\b(?:ep|episode)\s*\d{1,4}\b/gi, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*(?:gb|gib|mb|mib)\b/gi, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/[-_.]+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
}

export function parseNewshostingRelease(
  title: string
): ParsedNewshostingRelease {
  let resolution: ParsedNewshostingRelease['resolution'] = 'unknown';
  if (/\b(?:2160p|4k|uhd)\b/i.test(title)) resolution = '2160p';
  else if (/\b1080p\b/i.test(title)) resolution = '1080p';
  else if (/\b720p\b/i.test(title)) resolution = '720p';
  else if (/\b480p\b/i.test(title)) resolution = '480p';

  let quality: ParsedNewshostingRelease['quality'] = 'unknown';
  if (/\bremux\b/i.test(title)) quality = 'REMUX';
  else if (/\bblu-?ray\b/i.test(title)) quality = 'BluRay';
  else if (/\bweb-?dl\b/i.test(title)) quality = 'WEB-DL';
  else if (/\bwebrip\b/i.test(title)) quality = 'WEBRip';
  else if (/\bhdtv\b/i.test(title)) quality = 'HDTV';

  let codec: ParsedNewshostingRelease['codec'] = 'unknown';
  if (/\b(?:x265|h265|hevc)\b/i.test(title)) codec = 'x265';
  else if (/\b(?:x264|h264|avc)\b/i.test(title)) codec = 'x264';
  else if (/\bav1\b/i.test(title)) codec = 'AV1';

  const hdrFormats: NonNullable<ParsedNewshostingRelease['hdrFormats']> = [];
  if (/(?:^|[\s._-])(?:hdr10\+|hdr10plus)(?:$|[\s._-])/i.test(title))
    hdrFormats.push('HDR10+');
  if (/\b(?:dv|dovi|dolby[ ._-]*vision)\b/i.test(title)) hdrFormats.push('DV');
  if ([...title.matchAll(/\bhdr(?:10)?\b(?!\s*\+|\s*plus)/gi)].length > 0) {
    hdrFormats.push('HDR10');
  }
  const hdr: ParsedNewshostingRelease['hdr'] = hdrFormats.includes('HDR10+')
    ? 'HDR10+'
    : hdrFormats.includes('DV')
      ? 'DV'
      : hdrFormats.includes('HDR10')
        ? 'HDR10'
        : 'none';
  const edition = parseEdition(title);

  const audioFormats = [
    ...new Set(
      [
        ...title.matchAll(
          /\b(?:truehd(?:[.\s-]*atmos)?|atmos|dts[.\s-]*x|dts[.\s-]*hd(?:[.\s-]*ma)?|dts|ddp?7\.1|ddp?5\.1|eac3(?:[.\s-]*joc)?|ac3|aac|flac)\b/gi
        ),
      ].map((match) => match[0])
    ),
  ];
  const languageAliases: Record<string, string> = {
    english: 'en',
    eng: 'en',
    en: 'en',
    french: 'fr',
    fre: 'fr',
    fra: 'fr',
    german: 'de',
    ger: 'de',
    deu: 'de',
    spanish: 'es',
    spa: 'es',
    italian: 'it',
    ita: 'it',
    japanese: 'ja',
    jpn: 'ja',
    korean: 'ko',
    kor: 'ko',
    chinese: 'zh',
    chi: 'zh',
    mandarin: 'zh',
    russian: 'ru',
    rus: 'ru',
  };
  const languages = [
    ...new Set(
      [
        ...title.matchAll(
          /(?:^|[\s._\[(-])(english|eng|en|french|fre|fra|german|ger|deu|spanish|spa|italian|ita|japanese|jpn|korean|kor|chinese|chi|mandarin|russian|rus)(?=$|[\s._\])-])/gi
        ),
      ].map((match) => languageAliases[match[1].toLowerCase()])
    ),
  ];
  const audioChannelsMatch = title.match(
    /(?<!\d)((?:1|2|5|7)\.\d(?:\.\d)?)(?!\.\d)/i
  );
  const releaseGroupMatch =
    title.match(/(?:^|[-_.\s])([A-Za-z0-9]{2,})$/) ||
    title.match(/\[([A-Za-z0-9]{2,})\]\s*$/);
  const sxeMatch = title.match(
    /\bS(\d{1,2})[\s._-]*E(\d{1,3})(?:\s*(?:[-~]\s*E?|E)(\d{1,3}))?\b/i
  );
  const xMatch = title.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  const seasonEpisodeMatch = title.match(
    /\bSeason\s*(\d{1,2}).*?\b(?:Episode|Ep)\s*(\d{1,3})\b/i
  );
  const seasonOnlyMatch = title.match(/\bS(?:eason)?\s*(\d{1,2})\b/i);
  const absoluteMatches = [
    ...title.matchAll(
      /(?:^|[\s._-])(?:E(?:P|pisode)?\s*)?(\d{2,4})(?:\s*[-~]\s*(\d{2,4}))?(?=$|[\s._\[\]-])/gi
    ),
  ];
  const seasonPack =
    !sxeMatch &&
    (/\b(?:complete|season\s*\d{1,2}|s\d{1,2})\b.*\b(?:season|pack|complete)\b/i.test(
      title
    ) ||
      /\bS\d{1,2}\b(?![\s._-]*E\d{1,3})/i.test(title));

  const season = parseNumber(
    sxeMatch?.[1] ||
      xMatch?.[1] ||
      seasonEpisodeMatch?.[1] ||
      seasonOnlyMatch?.[1]
  );
  const episode = parseNumber(
    sxeMatch?.[2] || xMatch?.[2] || seasonEpisodeMatch?.[2]
  );
  const absoluteMatch = absoluteMatches.find((match) => {
    const value = parseNumber(match[1]);
    if (!value || (value >= 1900 && value <= 2099)) return false;
    const end = (match.index ?? 0) + match[0].length;
    if (title[end] === '.' && /\d/.test(title[end + 1] || '')) {
      return /^(?:2160p|1080p|720p|480p)\b/i.test(title.slice(end + 1));
    }
    return true;
  });
  const rangeEnd = parseNumber(sxeMatch?.[3]);
  const absoluteEpisode =
    episode !== undefined ? undefined : parseNumber(absoluteMatch?.[1]);
  const absoluteRangeEnd =
    absoluteEpisode !== undefined ? parseNumber(absoluteMatch?.[2]) : undefined;
  const explicitEpisodeRange =
    episode !== undefined && rangeEnd !== undefined && rangeEnd >= episode
      ? { start: episode, end: rangeEnd }
      : undefined;
  const absoluteEpisodeRange =
    absoluteEpisode !== undefined &&
    absoluteRangeEnd !== undefined &&
    absoluteRangeEnd >= absoluteEpisode
      ? { start: absoluteEpisode, end: absoluteRangeEnd }
      : undefined;
  // Keep range endpoints from the same filename expression; an S/E number
  // must never be paired with an unrelated numeric range elsewhere in title.
  const episodeRange = explicitEpisodeRange ?? absoluteEpisodeRange;
  const candidateGroup = releaseGroupMatch?.[1];
  const releaseGroup =
    candidateGroup &&
    !/^(?:2160p|1080p|720p|480p|4k|uhd|hevc|x265|x264|h264|h265|avc|av1|web|dl|webdl|webrip|bluray|remux|dv|dovi|hdr|hdr10|aac|ac3|eac3|dts|truehd|atmos)$/i.test(
      candidateGroup
    )
      ? candidateGroup
      : undefined;
  let normalizedTitle = normalizeReleaseTitle(title, releaseGroup);
  if (absoluteEpisode) {
    normalizedTitle = normalizedTitle
      .replace(new RegExp(`\\b0*${absoluteEpisode}\\b`, 'g'), ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return {
    resolution,
    quality,
    codec,
    hdr,
    hdrFormats,
    edition,
    audio: audioFormats[0],
    audioChannels: audioChannelsMatch?.[1],
    audioFormats,
    languages,
    releaseGroup,
    normalizedTitle,
    season,
    episode,
    absoluteEpisode,
    episodeRange,
    seasonPack,
    sizeBytes: parseSizeBytes(title),
  };
}

export function normalizeNewshostingComparableTitle(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['\u2019`]/g, '')
    .replace(/\b(?:[A-Za-z][.*]){2,}[A-Za-z]\b/g, (acronym) =>
      acronym.replace(/[.*]/g, '')
    )
    .replace(/&/g, ' and ')
    .replace(/\b(?:the|a|an)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function tokens(value: string): string[] {
  return normalizeNewshostingComparableTitle(value)
    .split(' ')
    .filter((token) => token.length > 1 || /^\d$/.test(token));
}

function titleSimilarity(left: string, right: string): number {
  const leftTokens = new Set(tokens(left));
  const rightTokens = new Set(tokens(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap++;
  }
  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function releaseTitleStem(rawTitle: string): string {
  return rawTitle
    .replace(/\bS\d{1,2}\s*E\d{1,3}.*$/i, ' ')
    .replace(/\b\d{1,2}x\d{1,3}.*$/i, ' ')
    .replace(/\bSeason\s*\d{1,2}.*$/i, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(
      /\b(?:2160p|1080p|720p|480p|4k|uhd|web-?dl|webrip|hdtv|blu-?ray|remux).*/i,
      ' '
    )
    .replace(/[-_.]+/g, ' ')
    .trim();
}

function bestTitleSimilarity(
  parsed: ParsedNewshostingRelease,
  rawTitle: string,
  metadata?: NewshostingMediaMetadata
): number {
  const titles = [metadata?.title, ...(metadata?.aliases || [])].filter(
    (title): title is string => Boolean(title)
  );
  if (!titles.length) return 0.5;
  const stem = releaseTitleStem(rawTitle);
  return Math.max(
    ...titles.map((title) =>
      Math.max(
        titleSimilarity(parsed.normalizedTitle, title),
        titleSimilarity(rawTitle, title),
        titleSimilarity(stem, title)
      )
    )
  );
}

function metadataContains(
  metadata: NewshostingMediaMetadata | undefined,
  phrase: string
): boolean {
  return [metadata?.title, ...(metadata?.aliases || [])]
    .filter((value): value is string => Boolean(value))
    .some((value) =>
      normalizeNewshostingComparableTitle(value).includes(phrase)
    );
}

function animeUniversePenalty(
  rawTitle: string,
  metadata?: NewshostingMediaMetadata
): { penalty: number; reasons: string[] } {
  if (!metadata?.isAnime) return { penalty: 0, reasons: [] };
  const normalizedRaw = normalizeNewshostingComparableTitle(rawTitle);
  const conflicts = [
    'shippuden',
    'boruto',
    'rock lee',
    'ninja pals',
    'spin off',
    'brotherhood',
    'dragon ball z',
    'dragon ball daima',
    'dragon ball gt',
    'dragon ball kai',
    'dragon ball super',
    'live action',
  ].filter(
    (term) => normalizedRaw.includes(term) && !metadataContains(metadata, term)
  );
  return {
    penalty: conflicts.length * 1200,
    reasons: conflicts.map((term) => `anime-conflict:${term}`),
  };
}

export function scoreNewshostingReleaseMatch(
  rawTitle: string,
  media: NewshostingMediaRequest,
  parsed = parseNewshostingRelease(rawTitle),
  metadata?: NewshostingMediaMetadata
): {
  score: number;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  signals: Record<string, number>;
} {
  const similarity = bestTitleSimilarity(parsed, rawTitle, metadata);
  const signals: Record<string, number> = {
    title: Math.round(similarity * 500),
  };
  let score = signals.title;
  const reasons: string[] = [];

  if (similarity >= 0.8) {
    score += 500;
    reasons.push('title');
  } else if (similarity >= 0.45) {
    score += 220;
    reasons.push('partial-title');
  } else {
    reasons.push('weak-title');
  }

  const releaseYear = Number.parseInt(
    rawTitle.match(/\b(?:19|20)\d{2}\b/)?.[0] || '',
    10
  );
  if (
    media.type === 'movie' &&
    metadata?.year &&
    Number.isFinite(releaseYear)
  ) {
    if (releaseYear === metadata.year) {
      signals.year = 180;
      score += signals.year;
      reasons.push('year');
    } else {
      signals.year = metadata.isAnime ? -900 : -320;
      score += signals.year;
      reasons.push('year-mismatch');
    }
  }
  if (metadata?.edition) {
    const wanted = normalizeNewshostingComparableTitle(metadata.edition);
    const actual = parsed.edition?.replace('-', ' ');
    if (actual && normalizeNewshostingComparableTitle(actual) === wanted) {
      signals.edition = 140;
      score += signals.edition;
      reasons.push('edition');
    } else if (actual) {
      signals.edition = -180;
      score += signals.edition;
      reasons.push('edition-mismatch');
    } else {
      // Missing edition tags are uncertainty, not proof that the requested
      // cut is absent. Keep the candidate available, but don't present it as
      // an edition-confirmed match or let it outrank a positively tagged cut.
      signals.edition = -120;
      score += signals.edition;
      reasons.push('edition-unconfirmed');
    }
  }

  // These modest, explicit weights rank better-specified releases without
  // turning missing filename tags into hard exclusions.
  const resolutionPoints: Record<
    ParsedNewshostingRelease['resolution'],
    number
  > = {
    '2160p': 35,
    '1080p': 30,
    '720p': 18,
    '480p': 5,
    unknown: 0,
  };
  signals.resolution = resolutionPoints[parsed.resolution];
  score += signals.resolution;
  if (parsed.resolution !== 'unknown')
    reasons.push(`resolution:${parsed.resolution}`);
  if (parsed.audioFormats?.length) {
    signals.audio = Math.min(
      24,
      parsed.audioFormats.length * 8 + (parsed.audioChannels ? 4 : 0)
    );
    score += signals.audio;
    reasons.push(`audio:${parsed.audioFormats.join('+')}`);
  }
  if (parsed.languages?.length) {
    signals.language = Math.min(12, parsed.languages.length * 4);
    score += signals.language;
    reasons.push(`language:${parsed.languages.join('+')}`);
  }
  if (parsed.sizeBytes !== undefined) {
    // Reward plausible feature-sized media; avoid assuming larger is always better.
    const gib = parsed.sizeBytes / 1_073_741_824;
    signals.size = gib >= 1 && gib <= 35 ? 18 : gib > 0.2 && gib < 80 ? 6 : -10;
    score += signals.size;
    reasons.push('size');
  }

  if (media.type === 'series') {
    // For series, a release-year often describes a later season rather than
    // the show's premiere. Preserve the established cautious series weighting.
    if (metadata?.year && Number.isFinite(releaseYear)) {
      if (releaseYear === metadata.year) {
        signals.year = 180;
        score += signals.year;
        reasons.push('year');
      } else {
        signals.year = metadata.isAnime ? -900 : -320;
        score += signals.year;
        reasons.push('year-mismatch');
      }
    }
    const normalizedRaw = normalizeNewshostingComparableTitle(rawTitle);
    const countries = (metadata?.countries || []).map((country) =>
      country.toLowerCase()
    );
    const isUsSeries = countries.some(
      (country) =>
        country.includes('united states') ||
        country === 'us' ||
        country === 'usa'
    );
    if (isUsSeries && /\b(?:us|u s|usa)\b/.test(normalizedRaw)) {
      score += 120;
      reasons.push('country');
    }

    const animePenalty = animeUniversePenalty(rawTitle, metadata);
    score -= animePenalty.penalty;
    reasons.push(...animePenalty.reasons);

    const seasonMatches =
      parsed.season === media.season || parsed.season === undefined;
    const directEpisode = parsed.episode === media.episode;
    const rangeEpisode = Boolean(
      parsed.episodeRange &&
      media.episode &&
      parsed.episodeRange.start <= media.episode &&
      parsed.episodeRange.end >= media.episode
    );

    if (parsed.season === media.season && directEpisode) {
      score += 500;
      reasons.push('episode');
    } else if (seasonMatches && rangeEpisode) {
      score += 360;
      reasons.push('episode-range');
    } else if (parsed.season === media.season && parsed.seasonPack) {
      score += 260;
      reasons.push('season-pack');
    } else if (parsed.absoluteEpisode === media.episode) {
      score += metadata?.isAnime ? 480 : 190;
      reasons.push('absolute-episode');
    } else if (
      parsed.episode !== undefined ||
      parsed.season !== undefined ||
      parsed.absoluteEpisode !== undefined
    ) {
      score -= metadata?.isAnime ? 1000 : 250;
      reasons.push('episode-mismatch');
    } else {
      score -= 80;
      reasons.push('uncertain-episode');
    }
  }

  const finalScore = Math.max(0, score);
  const editionUnconfirmed = reasons.includes('edition-unconfirmed');
  const editionMismatch = reasons.includes('edition-mismatch');
  return {
    score: finalScore,
    reason: reasons.join(','),
    confidence:
      finalScore >= 1_100 &&
      !reasons.includes('episode-mismatch') &&
      !editionUnconfirmed &&
      !editionMismatch
        ? 'high'
        : finalScore >= 650 &&
            !reasons.includes('episode-mismatch') &&
            !editionMismatch
          ? 'medium'
          : 'low',
    signals,
  };
}
