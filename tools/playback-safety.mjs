const PLAYBACK_MODES = new Set(['direct', 'native', 'hls', 'remux']);

export function isAllowedPlaybackUrl(
  value,
  expectedOrigin,
  allowedBasePaths = ['/']
) {
  try {
    const url = value instanceof URL ? value : new URL(value);
    const expected = new URL(expectedOrigin);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (url.origin !== expected.origin || url.username || url.password)
      return false;
    if (url.hash) return false;
    return allowedBasePaths.some((basePath) => {
      const base = String(basePath || '/');
      const normalized = base.endsWith('/') ? base : `${base}/`;
      return normalized === '/'
        ? url.pathname.startsWith('/')
        : url.pathname === normalized.slice(0, -1) ||
            url.pathname.startsWith(normalized);
    });
  } catch {
    return false;
  }
}

export function isDeepbridFinderEntry(stream) {
  const identifiers = [
    stream?.addon?.id,
    stream?.addon?.identifier,
    stream?.behaviorHints?.addonId,
    stream?.behaviorHints?.source,
    stream?.behaviorHints?.deepbridProvider,
  ]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  return (
    identifiers.includes('deepbrid-usenet') ||
    identifiers.includes('deepbrid_usenet') ||
    identifiers.includes('deepbrid finder')
  );
}

export function streamPlaybackMode(value) {
  const mode = String(value ?? '')
    .trim()
    .toLowerCase();
  if (mode === 'direct' || mode === 'native') return mode;
  return PLAYBACK_MODES.has(mode) ? mode : 'unknown';
}

export function normalizePlaybackMode(value) {
  const mode = streamPlaybackMode(value);
  return mode === 'unknown' ? 'unknown' : mode;
}

export function countInvalidPlaybackUrls(entries, isValid) {
  return entries.filter((entry) => !isValid(entry)).length;
}

function releaseText(stream) {
  return [
    stream?.behaviorHints?.deepbridReleaseTitle,
    stream?.behaviorHints?.filename,
    stream?.name,
    stream?.description,
  ]
    .filter((value) => typeof value === 'string')
    .join('\n');
}

function mentionsEpisode(text, season, episode) {
  const s = String(Number(season));
  const e = String(Number(episode));
  const seasonPattern = `S0?${s}`;
  const episodePattern = `E0?${e}`;
  const padded = new RegExp(
    `\\b${seasonPattern}\\s*[-._ ]?\\s*${episodePattern}\\b`,
    'i'
  );
  const compact = new RegExp(`\\b${Number(season)}x${Number(episode)}\\b`, 'i');
  const range = new RegExp(
    `\\b${seasonPattern}\\s*[-._ ]?\\s*${episodePattern}\\s*[-–]\\s*E?\\d+`,
    'i'
  );
  return padded.test(text) || compact.test(text) || range.test(text);
}

export function episodeTargetMatch(stream, season, episode) {
  if (!Number.isInteger(Number(season)) || !Number.isInteger(Number(episode)))
    return false;
  const hints = stream?.behaviorHints || {};
  if (
    Number(hints.season) === Number(season) &&
    Number(hints.episode) === Number(episode)
  )
    return true;
  return mentionsEpisode(releaseText(stream), season, episode);
}

export function largestPlaybackEntryPerMode(entries, options = {}) {
  const grouped = new Map();
  for (const entry of entries) {
    if (!entry || !PLAYBACK_MODES.has(entry.playbackMode)) continue;
    const group = grouped.get(entry.playbackMode) || [];
    group.push(entry);
    grouped.set(entry.playbackMode, group);
  }
  const selected = [];
  const seasonPackFallbackModes = [];
  for (const mode of [...grouped.keys()].sort()) {
    const group = grouped.get(mode);
    let candidates = group;
    if (options.preferEpisodes) {
      const episodes = group.filter(
        (entry) => !entry.seasonPack && entry.episodeTargetMatch
      );
      if (episodes.length) candidates = episodes;
      else {
        const packs = group.filter((entry) => entry.seasonPack);
        if (packs.length) {
          candidates = packs;
          seasonPackFallbackModes.push(mode);
        } else candidates = [];
      }
    }
    candidates.sort(
      (a, b) =>
        (Number(b.releaseBytes) || 0) - (Number(a.releaseBytes) || 0) ||
        String(a.stream?.url || '').localeCompare(String(b.stream?.url || ''))
    );
    if (candidates[0]) selected.push(candidates[0]);
  }
  return { entries: selected, seasonPackFallbackModes };
}

export function encodedFilenameCoverage({
  requested,
  sampleAvailable,
  selected,
  probeOk,
}) {
  if (!requested) return { status: 'not-requested', verified: false };
  if (!sampleAvailable)
    return { status: 'sample-unavailable', verified: false };
  if (!selected) return { status: 'sample-not-selected', verified: false };
  return probeOk
    ? { status: 'verified', verified: true }
    : { status: 'probe-failed', verified: false };
}

export function episodeModeSelectionPassed({
  requested,
  targetConfigured,
  selected,
  availableModeCount,
  probeBudget,
}) {
  if (!requested) return true;
  return Boolean(
    targetConfigured &&
    availableModeCount > 0 &&
    selected.length >= availableModeCount &&
    availableModeCount <= probeBudget
  );
}

export function mediaDecodePassed(results, minimumSeconds = 1, maximumSkewMs) {
  if (!Array.isArray(results) || results.length === 0) return false;
  return results.every(
    (result) =>
      result?.status === 'decoded' &&
      Number(result.decodedSeconds) >= minimumSeconds &&
      (maximumSkewMs === undefined ||
        (Number.isFinite(Number(result.audioVideoSkewMs)) &&
          Math.abs(Number(result.audioVideoSkewMs)) <= maximumSkewMs))
  );
}

export function playbackAcceptancePassed(options) {
  const {
    responseOk,
    invalidPlayableUrlCount = 0,
    invalidPlaybackModeCount = 0,
    incompleteFinderErrorCount = 0,
    results = [],
    requireSeasonPack = false,
    requireIndividualEpisodes = false,
    requireEpisodeTargetMatch = false,
    minimumReleaseBytes = 0,
    encodedFilenameCoverageRequested = false,
    encodedFilenameSampleAvailable = false,
    encodedFilenameSampleVerified = false,
  } = options;
  return (
    responseOk === true &&
    invalidPlayableUrlCount === 0 &&
    invalidPlaybackModeCount === 0 &&
    incompleteFinderErrorCount === 0 &&
    results.length > 0 &&
    results.every(
      (result) =>
        result.ok === true && result.releaseBytes >= minimumReleaseBytes
    ) &&
    (!requireSeasonPack || results.some((result) => result.seasonPack)) &&
    (!requireIndividualEpisodes ||
      results.every((result) => !result.seasonPack)) &&
    (!requireEpisodeTargetMatch ||
      results.every((result) => result.episodeTargetMatch)) &&
    (!encodedFilenameCoverageRequested ||
      (encodedFilenameSampleAvailable && encodedFilenameSampleVerified))
  );
}

export function requestTimeoutMs(progressive) {
  return progressive ? 240_000 : 120_000;
}

export function safeProbeErrorCategory(error) {
  const code = String(error?.code || '').toUpperCase();
  const allowed = new Set([
    'TIMEOUT',
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'ABORT_ERR',
  ]);
  if (allowed.has(code))
    return code === 'TIMEOUT' ? 'timeout' : code.toLowerCase();
  const status = Number(error?.status || error?.statusCode);
  if (Number.isInteger(status) && status >= 400 && status <= 599)
    return `http-${status}`;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError')
    return 'timeout';
  if (error instanceof SyntaxError) return 'invalid-response';
  return 'probe-failed';
}
