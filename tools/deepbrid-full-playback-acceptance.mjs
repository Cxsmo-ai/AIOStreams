import { readFile } from 'node:fs/promises';
import { collectProgressiveResult } from './progressive-ndjson.mjs';
import { decodeDeepbridCapability } from './deepbrid-local-ffmpeg.mjs';
import {
  countInvalidPlaybackUrls,
  episodeTargetMatch,
  episodeModeSelectionPassed as checkEpisodeModeSelection,
  encodedFilenameCoverage,
  isAllowedPlaybackUrl,
  isDeepbridFinderEntry,
  largestPlaybackEntryPerMode,
  mediaDecodePassed,
  normalizePlaybackMode,
  playbackAcceptancePassed,
  requestTimeoutMs,
  safeProbeErrorCategory,
  streamPlaybackMode,
} from './playback-safety.mjs';

async function readStdinInput() {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of process.stdin) {
    byteLength += chunk.byteLength;
    if (byteLength > 1024 * 1024) throw new Error('input-size-limit');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid-stdin-json');
  }
}

const input = process.env.TEST_INPUT_FILE
  ? JSON.parse(await readFile(process.env.TEST_INPUT_FILE, 'utf8'))
  : process.env.AIOSTREAMS_MANIFEST_URL
    ? {
        manifest: process.env.AIOSTREAMS_MANIFEST_URL,
        cases: JSON.parse(process.env.TEST_CASES_JSON || '[]'),
      }
    : !process.stdin.isTTY
      ? await readStdinInput()
      : {};

if (!input.manifest) throw new Error('AIOSTREAMS_MANIFEST_URL is required');

const manifestUrl = new URL(input.manifest);
if (!manifestUrl.pathname.endsWith('/manifest.json')) {
  throw new Error('AIOStreams manifest URL must end with /manifest.json');
}
manifestUrl.pathname = manifestUrl.pathname.slice(0, -'/manifest.json'.length) + '/';
const base = manifestUrl;
// The deployed capability service emits BASE_URL-rooted URLs. Keep this
// verifier pinned to the origin-rooted builtin route, not the profile path.
const allowedPlaybackBasePaths = ['/'];
const labels = new Set(
  String(process.env.TEST_LABELS || '')
    .split('|')
    .map((value) => value.trim())
    .filter(Boolean)
);
const cases = labels.size
  ? input.cases.filter((item) => labels.has(item.label))
  : input.cases;

const sizeFactors = {
  B: 1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
};

async function readTextCapped(response, maxBytes) {
  if (!response.body) throw new Error('response-body-missing');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('response-size-limit');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function findLargestSize(text) {
  let largest = 0;
  for (const match of text.matchAll(/(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|KB|B)\b/gi)) {
    const bytes = Number(match[1].replace(',', '.')) * sizeFactors[match[2].toUpperCase()];
    if (Number.isFinite(bytes)) largest = Math.max(largest, bytes);
  }
  return largest;
}

function streamSize(stream) {
  const hinted = Number(
    stream.behaviorHints?.deepbridReleaseSize ||
      stream.behaviorHints?.videoSize ||
      0
  );
  return Math.max(
    Number.isFinite(hinted) ? hinted : 0,
    findLargestSize(
      `${stream.name || ''}\n${stream.description || ''}\n${stream.behaviorHints?.deepbridReleaseTitle || ''}`
    )
  );
}

function isBuiltinPlaybackStream(stream) {
  if (typeof stream?.url !== 'string') return false;
  try {
    return isAllowedPlaybackUrl(
      new URL(stream.url),
      base.origin,
      allowedPlaybackBasePaths
    );
  } catch {
    return false;
  }
}

function hasEncodedFilenameSeparator(stream) {
  if (!isBuiltinPlaybackStream(stream)) return false;
  const url = new URL(stream.url);
  const marker = '/builtins/deepbrid-usenet/play/';
  const markerIndex = url.pathname.lastIndexOf(marker);
  if (markerIndex < 0) return false;
  const capability = url.pathname.slice(markerIndex + marker.length);
  const filenameStart = capability.indexOf('/');
  return (
    filenameStart > 0 &&
    /%2f|%5c/i.test(capability.slice(filenameStart + 1))
  );
}

async function safePlaybackFetch(rawUrl, init) {
  let url = new URL(rawUrl);
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!isAllowedPlaybackUrl(url, base.origin, allowedPlaybackBasePaths)) {
      throw new Error('playback-origin-rejected');
    }
    const response = await fetch(url, { ...init, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (!location || redirects === 3) throw new Error('playback-redirect-rejected');
    url = new URL(location, url);
  }
  throw new Error('playback-redirect-rejected');
}

async function mapLimit(items, limit, mapper) {
  const results = Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await mapper(items[index], index);
      }
    })
  );
  return results;
}

function isSeasonPack(stream) {
  const release = `${stream.name || ''}\n${stream.description || ''}`;
  return (
    stream.behaviorHints?.deepbridSeasonPack === true ||
    /\b(?:complete|season[ ._-]*\d{1,2}|s\d{1,2})\b.*\b(?:season|pack|complete)\b/i.test(
      release
    ) ||
    /\bS\d{1,2}\b(?![ ._-]*E\d{1,3})/i.test(release)
  );
}

async function rangeProbe(url, start) {
  const end = start + 65535;
  const response = await safePlaybackFetch(url, {
    headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' },
    signal: AbortSignal.timeout(120_000),
  });
  const reader = response.body?.getReader();
  let bytes = 0;
  let complete = false;
  if (reader) {
    try {
      while (bytes < 65536) {
        const { done, value } = await reader.read();
        if (done) {
          complete = true;
          break;
        }
        bytes += Math.min(value.byteLength, 65536 - bytes);
      }
    } finally {
      if (!complete) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  const contentRange = response.headers.get('content-range') || '';
  const contentType = response.headers.get('content-type') || '';
  const rangeHonored =
    response.status === 206 &&
    bytes > 0 &&
    new RegExp(`^bytes\\s+${start}-\\d+/(?:\\d+|\\*)$`, 'i').test(
      contentRange
    );
  return {
    status: response.status,
    bytes,
    complete,
    contentType,
    rangeHonored,
    ok: rangeHonored ||
      ((response.status === 200 || response.status === 206) &&
        start === 0 &&
        bytes > 0 &&
        /^(?:video\/|application\/(?:octet-stream|vnd\.apple\.mpegurl))/i.test(
          contentType
        )),
  };
}

async function hlsProbe(url, depth = 0) {
  const response = await safePlaybackFetch(url, {
    headers: { Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*' },
    signal: AbortSignal.timeout(120_000),
  });
  const body = await readTextCapped(response, 2 * 1024 * 1024);
  const contentType = response.headers.get('content-type') || '';
  const isManifest =
    response.ok &&
    body.startsWith('#EXTM3U') &&
    /#EXT(?:INF|X-STREAM-INF)/.test(body);
  let assetReference;
  let assetIsVariantPlaylist = false;
  let variantUriExpected = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      variantUriExpected = true;
      continue;
    }
    if (!line.startsWith('#')) {
      assetReference = line;
      assetIsVariantPlaylist = variantUriExpected;
      break;
    }
  }
  if (!isManifest || !assetReference) {
    return { status: response.status, contentType, isManifest, hasAsset: false, ok: false };
  }
  const assetUrl = new URL(assetReference, url);
  const localCapability = isAllowedPlaybackUrl(
    assetUrl,
    base.origin,
    allowedPlaybackBasePaths
  );
  if (!localCapability || depth >= 2) {
    return { status: response.status, contentType, isManifest, localCapability, ok: false };
  }
  const isNestedPlaylist =
    assetIsVariantPlaylist ||
    /\.m3u8$/i.test(assetUrl.pathname);
  const media = isNestedPlaylist
    ? await hlsProbe(assetUrl.toString(), depth + 1)
    : await rangeProbe(assetUrl.toString(), 0);
  return {
    status: response.status,
    contentType,
    isManifest,
    localCapability,
    nestedPlaylist: isNestedPlaylist,
    media,
    ok: media.ok,
  };
}

let failed = false;
for (const item of cases) {
  const started = performance.now();
  let responseStatus = null;
  try {
    const progressive =
      manifestUrl.searchParams.get('client') === 'nuvio-progressive';
    const streamUrl = new URL(
      progressive
        ? `stream-progressive/${item.type}/${encodeURIComponent(item.id)}.ndjson`
        : `stream/${item.type}/${encodeURIComponent(item.id)}.json`,
      base
    );
    streamUrl.search = manifestUrl.search;
    const response = await fetch(
      streamUrl,
      {
        headers: { 'User-Agent': 'AIOStreams-Deepbrid-acceptance/1.0' },
        signal: AbortSignal.timeout(requestTimeoutMs(progressive)),
      }
    );
    responseStatus = response.status;
    let payload;
    let progressiveSnapshotCount = 0;
    let progressiveFirstSnapshotMs = null;
    let progressiveFirstNonEmptySnapshotMs = null;
    let progressiveFirstDeepbridMs = null;
    let progressiveFirstFinderMs = null;
    let progressiveLastDeepbridMs = null;
    let progressiveLastFinderMs = null;
    let progressiveMaxDeepbridSnapshotCount = 0;
    let progressiveMaxFinderSnapshotCount = 0;
    if (progressive) {
      const progressiveResult = await collectProgressiveResult(response, {
        startedAt: started,
        classifySnapshot: (event) => {
          const streams = Array.isArray(event.streams) ? event.streams : [];
          return {
            deepbrid: streams.some((stream) =>
              /deepbrid/i.test(`${stream?.name || ''}\n${stream?.description || ''}`)
            ),
            finder: streams.some(isDeepbridFinderEntry),
            deepbridCount: streams.filter((stream) =>
              /(?:deepbrid|\bDB\b)/i.test(`${stream?.name || ''}\n${stream?.description || ''}`)
            ).length,
            finderCount: streams.filter(isDeepbridFinderEntry).length,
          };
        },
      });
      payload = progressiveResult.payload;
      progressiveSnapshotCount = progressiveResult.snapshotCount;
      progressiveFirstSnapshotMs = progressiveResult.firstSnapshotElapsedMs;
      progressiveFirstNonEmptySnapshotMs =
        progressiveResult.firstNonEmptySnapshotElapsedMs;
      progressiveFirstDeepbridMs = progressiveResult.firstDeepbridSnapshotElapsedMs;
      progressiveFirstFinderMs = progressiveResult.firstFinderSnapshotElapsedMs;
      progressiveLastDeepbridMs = progressiveResult.lastDeepbridSnapshotElapsedMs;
      progressiveLastFinderMs = progressiveResult.lastFinderSnapshotElapsedMs;
      progressiveMaxDeepbridSnapshotCount = progressiveResult.maximumDeepbridSnapshotCount;
      progressiveMaxFinderSnapshotCount = progressiveResult.maximumFinderSnapshotCount;
    } else {
      payload = await response.json();
    }
    const deepbridEntries = (payload.streams || []).filter((stream) =>
      /(?:deepbrid|\bDB\b)/i.test(
        `${stream.name || ''}\n${stream.description || ''}`
      )
    );
    const finderEntries = deepbridEntries.filter(isDeepbridFinderEntry);
    const incompleteFinderErrorCount = deepbridEntries.filter((stream) =>
      /deepbrid\s+finder\s+resolution\s+incomplete/i.test(
        `${stream?.name || ''}\n${stream?.description || ''}`
      )
    ).length;
    const transportSummary = finderEntries.slice(0, 12).map((stream) => {
      let url;
      try {
        url = new URL(stream.url);
      } catch {
        return {
          hasUrl: typeof stream.url === 'string',
          transport: 'non-http-or-missing',
        };
      }
      return {
        playbackMode: normalizePlaybackMode(
          stream.behaviorHints?.deepbridPlaybackMode
        ),
        builtinFinderProxy: url.pathname.includes(
          '/builtins/deepbrid-usenet/play/'
        ),
        externalResolverProxy: url.pathname.includes('/debrid/'),
        filenameHint: Boolean(stream.behaviorHints?.filename),
      };
    });
    const playbackModeCounts = finderEntries.reduce((counts, stream) => {
      const mode = normalizePlaybackMode(
        stream.behaviorHints?.deepbridPlaybackMode
      );
      counts[mode] = (counts[mode] || 0) + 1;
      return counts;
    }, Object.create(null));
    const playableFinderEntries = finderEntries.filter(isBuiltinPlaybackStream);
    const playbackModeOf = (stream) =>
      streamPlaybackMode(stream.behaviorHints?.deepbridPlaybackMode);
    const invalidPlaybackModeCount = playableFinderEntries.filter(
      (stream) => playbackModeOf(stream) === 'unknown'
    ).length;
    const allStreams = playableFinderEntries
      .filter((stream) => playbackModeOf(stream) !== 'unknown')
      .map((stream) => ({
        stream,
        playbackMode: playbackModeOf(stream),
        releaseBytes: streamSize(stream),
        seasonPack: isSeasonPack(stream),
        episodeTargetMatch: episodeTargetMatch(
          stream,
          item.targetSeason,
          item.targetEpisode
        ),
      }));

    const invalidPlayableUrlCount = countInvalidPlaybackUrls(
      finderEntries,
      isBuiltinPlaybackStream
    );
    const invalidPlayableUrlReasons = Object.create(null);
    for (const stream of finderEntries) {
      if (isBuiltinPlaybackStream(stream)) continue;
      let category = 'route-shape';
      if (typeof stream?.url !== 'string') {
        category = 'missing-or-non-string-url';
      } else {
        try {
          const url = new URL(stream.url);
          if (url.origin !== base.origin) category = 'origin-mismatch';
          else if (url.username || url.password) category = 'url-userinfo';
          else if (/%2f|%5c/i.test(url.pathname)) category = 'encoded-separator';
          else if (url.pathname.includes('/builtins/deepbrid-usenet/play/')) {
            category = 'unexpected-path-prefix';
          }
        } catch {
          category = 'malformed-url';
        }
      }
      invalidPlayableUrlReasons[category] =
        (invalidPlayableUrlReasons[category] || 0) + 1;
    }
    const normalPerMode = largestPlaybackEntryPerMode(allStreams);
    const episodePerMode = largestPlaybackEntryPerMode(allStreams, {
      preferEpisodes: true,
      targetSeason: item.targetSeason,
      targetEpisode: item.targetEpisode,
    });
    let selected = item.probeAll ? allStreams : normalPerMode.entries;
    let probeBudget = Math.max(1, Math.min(12, Number(item.maxProbes || 3)));
    if (item.selectLargest) {
      selected = allStreams.length
        ? [allStreams.reduce((largest, current) =>
            current.releaseBytes > largest.releaseBytes ? current : largest
          )]
        : [];
    } else if (item.selectLargestPack) {
      const packs = allStreams.filter((entry) => entry.seasonPack);
      selected = packs.length
        ? [packs.reduce((largest, current) =>
            current.releaseBytes > largest.releaseBytes ? current : largest
          )]
        : [];
    } else if (item.selectLargestPerMode) {
      selected = normalPerMode.entries;
    } else if (item.selectLargestEpisodePerMode) {
      selected = episodePerMode.entries;
    }

    const episodeModeVerificationRequested =
      item.selectLargestEpisodePerMode === true;
    const episodeTargetConfigured =
      item.targetSeason !== undefined &&
      item.targetSeason !== null &&
      String(item.targetSeason).trim() !== '' &&
      Number.isInteger(Number(item.targetSeason)) &&
      Number(item.targetSeason) >= 0 &&
      item.targetEpisode !== undefined &&
      item.targetEpisode !== null &&
      String(item.targetEpisode).trim() !== '' &&
      Number.isInteger(Number(item.targetEpisode)) &&
      Number(item.targetEpisode) >= 1;
    const requiredEpisodeModeCount = episodeModeVerificationRequested
      ? episodePerMode.entries.length
      : 0;

    const episodeModeBudgetComplete =
      !episodeModeVerificationRequested || selected.length <= probeBudget;
    if (selected.length > probeBudget) {
      selected = selected.slice(0, probeBudget);
    }
    const encodedFilenameSample = allStreams.find((entry) =>
      hasEncodedFilenameSeparator(entry.stream)
    );
    let selectedEncodedFilenameSample = Boolean(
      encodedFilenameSample &&
        selected.some((entry) => entry.stream.url === encodedFilenameSample.stream.url)
    );
    if (
      item.includeEncodedFilenameSample === true &&
      encodedFilenameSample &&
      !selected.some((entry) => entry.stream.url === encodedFilenameSample.stream.url) &&
      selected.length < probeBudget
    ) {
      selected.push(encodedFilenameSample);
      selectedEncodedFilenameSample = true;
    }
    const skippedProbeCount = allStreams.length - selected.length;

    // Keep playback probes serial: remux/HLS may spin up encoders and the
    // user's upstream account is limited to one active stream.
    const results = await mapLimit(
      selected,
      1,
      async ({ stream, playbackMode, releaseBytes, seasonPack, episodeTargetMatch }) => {
        const url = new URL(stream.url);
        try {
          if (playbackMode === 'hls') {
            const playlist = await hlsProbe(stream.url);
            return {
              mode: playbackMode,
              releaseBytes,
              seasonPack,
              episodeTargetMatch,
              archiveExpanded:
                stream.behaviorHints?.deepbridArchiveExpanded === true,
              validatedCapabilityUrl: isAllowedPlaybackUrl(
                url,
                base.origin,
                allowedPlaybackBasePaths
              ),
              playlist,
              ok: playlist.ok,
            };
          }
          const first = await rangeProbe(stream.url, 0);
          // Remux's endpoint is a streaming representation and may ignore
          // byte ranges; don't launch a second independent remux operation.
          // Arbitrary byte seeking and time-based `start=` are separate tests.
          const second =
            playbackMode === 'remux'
              ? null
              : await rangeProbe(stream.url, 1_048_576);
          return {
            mode: playbackMode,
            releaseBytes,
            seasonPack,
            episodeTargetMatch,
            archiveExpanded:
              stream.behaviorHints?.deepbridArchiveExpanded === true,
            validatedCapabilityUrl: isAllowedPlaybackUrl(
              url,
              base.origin,
              allowedPlaybackBasePaths
            ),
            first,
            second,
            probeKind:
              playbackMode === 'remux'
                ? 'sequential-transport-only'
                : 'byte-range-transport',
            byteSeekable:
              playbackMode === 'remux'
                ? null
                : first.rangeHonored && second?.rangeHonored === true,
            transportValid:
              playbackMode === 'remux'
                ? first.ok && /mp4/i.test(first.contentType)
                : first.ok && second?.ok === true,
            ok:
              playbackMode === 'remux'
                ? first.ok && /mp4/i.test(first.contentType)
                : first.ok && second?.ok === true,
          };
        } catch (error) {
          return {
            mode: playbackMode,
            releaseBytes,
            seasonPack,
            episodeTargetMatch,
            errorCategory: safeProbeErrorCategory(error),
            ok: false,
          };
        }
      }
    );

    const encodedFilenameSelectedIndex = encodedFilenameSample
      ? selected.findIndex(
          (entry) => entry.stream.url === encodedFilenameSample.stream.url
        )
      : -1;
    const encodedFilenameCoverageResult = encodedFilenameCoverage({
      requested: item.includeEncodedFilenameSample === true,
      sampleAvailable: Boolean(encodedFilenameSample),
      selected: encodedFilenameSelectedIndex >= 0,
      probeOk: results[encodedFilenameSelectedIndex]?.ok === true,
    });
    const requestedDecodeModes = Array.isArray(item.decodePlaybackModes)
      ? [...new Set(item.decodePlaybackModes.map((mode) => String(mode).toLowerCase()))]
      : [];
    const decodeResults = [];
    for (const mode of requestedDecodeModes) {
      const candidate = selected.find((entry) => entry.playbackMode === mode);
      if (!candidate) {
        decodeResults.push({ mode, status: 'sample_not_selected' });
        continue;
      }
      const report = await decodeDeepbridCapability({
        capabilityUrl: candidate.stream.url,
        expectedOrigin: base.origin,
        allowedBasePaths: allowedPlaybackBasePaths,
        ffmpegPath: process.env.DEEPBIRD_FFMPEG_PATH || 'ffmpeg',
        ffprobePath: process.env.DEEPBIRD_FFPROBE_PATH || 'ffprobe',
        seconds: Number(item.decodeSeconds || process.env.DEEPBIRD_DECODE_SECONDS || 15),
        timeoutMs: Number(item.decodeTimeoutMs || process.env.DEEPBIRD_DECODE_TIMEOUT_MS || 90_000),
      });
      decodeResults.push({ mode, ...report });
    }
    const decodePassed =
      requestedDecodeModes.length === 0 ||
      mediaDecodePassed(
        decodeResults,
        Number(item.minimumDecodeSeconds || 1),
        item.maximumAudioVideoSkewMs === undefined
          ? undefined
          : Number(item.maximumAudioVideoSkewMs)
      );

    const minimumReleaseBytes = Number(item.minimumReleaseBytes || 0);
    const transportPassed = playbackAcceptancePassed({
      responseOk: response.ok,
      invalidPlayableUrlCount,
      invalidPlaybackModeCount,
      incompleteFinderErrorCount,
      results,
      requireSeasonPack: item.requireSeasonPack === true,
      requireIndividualEpisodes: item.selectLargestEpisodePerMode === true,
      requireEpisodeTargetMatch: item.selectLargestEpisodePerMode === true,
      minimumReleaseBytes,
      encodedFilenameCoverageRequested:
        item.includeEncodedFilenameSample === true,
      encodedFilenameSampleAvailable: Boolean(encodedFilenameSample),
      encodedFilenameSampleVerified: encodedFilenameCoverageResult.verified,
    });
    const episodeModeSelectionResult = checkEpisodeModeSelection({
      requested: episodeModeVerificationRequested,
      targetConfigured: episodeTargetConfigured,
      selected,
      availableModeCount: requiredEpisodeModeCount,
      probeBudget,
    });
    const playbackPassed =
      transportPassed && decodePassed && episodeModeSelectionResult;
    failed ||= !playbackPassed;
    process.stdout.write(
      `${JSON.stringify({
        label: item.label,
        playbackPassed,
        transportPassed,
        decodePassed,
        episodeModeSelectionPassed: episodeModeSelectionResult,
        episodeModeSelectionStatus:
          item.selectLargestEpisodePerMode !== true
            ? 'not-requested'
            : !episodeTargetConfigured
              ? 'target-season-episode-required'
              : !episodeModeBudgetComplete
                ? 'probe-budget-omitted-mode'
                : episodePerMode.entries.length
                  ? 'target-matched-individual-episodes-selected'
                  : 'no-target-matched-episode-candidates',
        verificationScope:
          requestedDecodeModes.length > 0
            ? 'transport-and-decode'
            : 'transport-only',
        audioVideoSyncToleranceMs:
          item.maximumAudioVideoSkewMs === undefined
            ? null
            : Number(item.maximumAudioVideoSkewMs),
        status: response.status,
        elapsedMs: Math.round(performance.now() - started),
        sourceCount: allStreams.length,
        deepbridEntryCount: deepbridEntries.length,
        deepbridFinderEntryCount: finderEntries.length,
        invalidPlayableUrlCount,
        invalidPlayableUrlReasons,
        invalidPlaybackModeCount,
        incompleteFinderErrorCount,
        playbackModeCounts,
        progressiveSnapshotCount,
        progressiveFirstSnapshotMs,
        progressiveFirstNonEmptySnapshotMs,
        progressiveFirstDeepbridMs,
        progressiveFirstFinderMs,
        progressiveLastDeepbridMs,
        progressiveLastFinderMs,
        progressiveMaxDeepbridSnapshotCount,
        progressiveMaxFinderSnapshotCount,
        transportSummary,
        packSources: allStreams.filter((entry) => entry.seasonPack).length,
        selectedCount: results.length,
        skippedProbeCount,
        probeBudget,
        selectedLargest: item.selectLargest === true,
        selectedLargestPack: item.selectLargestPack === true,
        selectedLargestPerMode: item.selectLargestPerMode === true,
        selectedLargestEpisodePerMode: item.selectLargestEpisodePerMode === true,
        selectedEpisodeFallbackModes: episodePerMode.seasonPackFallbackModes,
        availableEpisodeModeCount: episodePerMode.entries.length -
          episodePerMode.seasonPackFallbackModes.length,
        requiredEpisodeModeCount,
        episodeModeBudgetComplete,
        encodedFilenameSampleFound: Boolean(encodedFilenameSample),
        selectedEncodedFilenameSample,
        encodedFilenameCoverageStatus: encodedFilenameCoverageResult.status,
        encodedFilenameTransportVerified: encodedFilenameCoverageResult.verified,
        requestedDecodeModes,
        decodeResults,
        selectedPlaybackModes: results.map((entry) => entry.mode),
        results,
      })}\n`
    );
  } catch (error) {
    failed = true;
    process.stdout.write(
      `${JSON.stringify({
        label: item.label,
        passed: false,
        status: responseStatus,
        elapsedMs: Math.round(performance.now() - started),
        requestErrorCategory: safeProbeErrorCategory(error),
      })}\n`
    );
  }
}

if (failed) process.exitCode = 1;
