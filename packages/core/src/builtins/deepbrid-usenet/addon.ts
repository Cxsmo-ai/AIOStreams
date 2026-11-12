import { createHash, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import pLimit from 'p-limit';
import { ParsedId } from '../../utils/id-parser.js';
import { constants, createLogger } from '../../utils/index.js';
import { IdParser } from '../../utils/id-parser.js';
import { Stream } from '../../db/index.js';
import {
  BaseDebridAddon,
  BaseDebridConfigSchema,
  SearchMetadata,
} from '../base/debrid.js';
import { Torrent, NZB, hashNzbUrl } from '../../debrid/index.js';
import { buildNewshostingQueries } from '../newshosting-indexer/addon.js';
import {
  NewshostingMediaMetadata,
  NewshostingMediaRequest,
  parseNewshostingRelease,
  scoreNewshostingReleaseMatch,
} from '../newshosting-indexer/release.js';
import {
  DeepbridApiError,
  DeepbridFinderClient,
  DeepbridFinderContent,
  DeepbridFinderFile,
  DeepbridFinderResult,
  DeepbridRetryExhaustionReason,
  assessDeepbridArchiveVolumes,
  classifyDeepbridUploadFile,
  isDeepbridArchiveName,
  isDeepbridVideoName,
  validateDeepbridDownloadUrl,
} from './client.js';
import { probeDeepbridVideo } from './probe.js';
import { createDeepbridPlaybackVariants } from './playback.js';
export {
  createDeepbridPlaybackToken,
  decodeDeepbridPlaybackToken,
  type DeepbridPlaybackPayload,
} from './playback.js';
import {
  hasSuccessfulDeepbridProbe,
  isDeepbridProbeQuarantined,
  rememberFailedDeepbridProbe,
  rememberSuccessfulDeepbridProbe,
} from './probe-cache.js';
import {
  ValidatedFinderResolutionQueue,
  ValidatedProgressiveStreamCollector,
} from './merge-progressive.js';
import { deepbridResolutionTimeout } from '../../utils/deepbrid-progressive-timeout.js';

const logger = createLogger('deepbrid-usenet');
// Deepbrid throttles bursts across simultaneous AIOStreams requests. Share a
// process-wide ceiling while still allowing one request to resolve candidates
// in parallel and retain every valid result.
const deepbridNetworkLimit = pLimit(10);

/** Keep private/signed download capabilities out of process-local cache keys. */
function deepbridProbeCacheKey(
  apiKey: string,
  link: string,
  extension: string
): string {
  return createHash('sha256')
    .update(JSON.stringify([apiKey, link, extension]))
    .digest('hex');
}

export const DeepbridUsenetConfigSchema = BaseDebridConfigSchema.extend({
  /** Copied from the global Deepbrid service during preset generation. */
  apiKey: z.string().trim().min(16).max(512).optional(),
  mode: z.enum(['direct', 'indexer', 'both']).default('direct'),
  // Player delivery is intentionally separate from the Finder routing mode.
  playbackMode: z.enum(['direct', 'remux', 'hls', 'all']).default('direct'),
  convertSubtitlesToWebVtt: z.boolean().default(false),
  resolveExternalIndexers: z.boolean().default(false),
  // Zero means unlimited results/candidates. Request deadlines, cancellation,
  // and concurrency remain bounded independently of these output limits.
  maxResults: z.number().int().min(0).max(50).default(0),
  maxContentResolves: z.number().int().min(0).max(30).default(0),
  resolveConcurrency: z.number().int().min(1).max(10).default(5),
  progressiveResolveConcurrency: z.number().int().min(1).max(10).default(10),
  timeout: z.number().int().min(1_000).max(120_000).default(30_000),
});
export type DeepbridUsenetConfig = z.infer<typeof DeepbridUsenetConfigSchema>;

export function requireDeepbridApiKey(config: DeepbridUsenetConfig): string {
  if (!config.apiKey) {
    throw new Error(
      'Deepbrid service is not configured. Add your API key under Services > Deepbrid, then regenerate this addon.'
    );
  }
  return config.apiKey;
}

function metadataForSearch(metadata: SearchMetadata): NewshostingMediaMetadata {
  const aliases = [metadata.primaryTitle, ...(metadata.titles || [])].filter(
    (value): value is string => Boolean(value)
  );
  return {
    title: metadata.primaryTitle || aliases[0],
    aliases: [...new Set(aliases)],
    year: metadata.year,
    countries: metadata.country ? [metadata.country] : [],
    isAnime: metadata.isAnime,
  };
}

function mediaForSearch(parsedId: ParsedId): NewshostingMediaRequest {
  const series =
    parsedId.mediaType !== 'movie' ||
    Boolean(parsedId.season || parsedId.episode);
  return {
    type: series ? 'series' : 'movie',
    season: parsedId.season ? Number(parsedId.season) : undefined,
    episode: parsedId.episode ? Number(parsedId.episode) : undefined,
  };
}

function categoryFor(
  media: NewshostingMediaRequest,
  anime: boolean | undefined
): string {
  if (anime) return 'c36';
  return media.type === 'movie' ? 'c11' : 'c30';
}

function ageHours(value: string): number | undefined {
  const numeric = Number(value);
  const timestamp = Number.isFinite(numeric)
    ? numeric > 10_000_000_000
      ? numeric
      : numeric * 1_000
    : Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.max(0, Math.ceil((Date.now() - timestamp) / 3_600_000))
    : undefined;
}

function rankResult(
  result: DeepbridFinderResult,
  media: NewshostingMediaRequest,
  metadata: NewshostingMediaMetadata
): {
  score: number;
  confirmed: boolean;
  confidence: 'high' | 'medium' | 'low';
  matchReason: string;
} {
  const parsedRelease = parseNewshostingRelease(result.title);
  if (parsedRelease.sizeBytes === undefined && result.size > 0) {
    parsedRelease.sizeBytes = result.size;
  }
  const match = scoreNewshostingReleaseMatch(
    result.title,
    media,
    parsedRelease,
    metadata
  );
  let score = match.score + Math.min(200, result.sources * 10);
  // Keep candidate ordering compatible with the established Finder ranking.
  // DeepSpec is display-only and must not alter progressive candidate choice.
  if (
    /\b(?:2160p|1080p|720p|4k|uhd|web-?dl|webrip|blu-?ray|remux|hdtv)\b/i.test(
      result.title
    )
  )
    score += 120;
  if (
    /\b(?:sample|trailer|cam|telesync|screener|password|encrypted)\b/i.test(
      result.title
    )
  )
    score -= 1000;
  return {
    score,
    confirmed: match.score >= (media.type === 'series' ? 650 : 600),
    confidence: match.confidence,
    matchReason: match.reason,
  };
}

export function chooseDeepbridVideoFiles(
  files: DeepbridFinderFile[],
  media: NewshostingMediaRequest,
  releaseTitle?: string
): DeepbridFinderFile[] {
  const videos = files.filter(
    (file) =>
      classifyDeepbridUploadFile(file).playableCandidate &&
      !/(?:^|[._ -])(?:sample|trailer|proof)(?:[._ -]|$)/i.test(file.name)
  );
  if (media.type !== 'series' || !media.season || !media.episode) return videos;
  const code = new RegExp(
    `(?:s0*${media.season}[._ -]*e0*${media.episode}|${media.season}x0*${media.episode})(?:\\D|$)`,
    'i'
  );
  const exact = videos.filter((file) => code.test(file.name));
  if (exact.length) return exact;

  // Expanded season archives frequently name files as E01/01 without
  // repeating S01. Only interpret those short forms when the parent release
  // is a confirmed pack for the requested season.
  const release = releaseTitle
    ? parseNewshostingRelease(releaseTitle)
    : undefined;
  if (release?.season === media.season && release.seasonPack) {
    const packEpisode = videos.filter((file) => {
      const parsed = parseNewshostingRelease(file.name);
      return (
        parsed.episode === media.episode ||
        parsed.absoluteEpisode === media.episode ||
        Boolean(
          parsed.episodeRange &&
          media.episode &&
          parsed.episodeRange.start <= media.episode &&
          parsed.episodeRange.end >= media.episode
        )
      );
    });
    if (packEpisode.length) return packEpisode;
  }

  if (videos.length !== 1) return [];
  const only = parseNewshostingRelease(videos[0].name);
  const explicitSeasonMismatch =
    only.season !== undefined && only.season !== media.season;
  const explicitEpisodeMatch =
    only.episode === media.episode ||
    only.absoluteEpisode === media.episode ||
    Boolean(
      only.episodeRange &&
      media.episode &&
      only.episodeRange.start <= media.episode &&
      only.episodeRange.end >= media.episode
    );
  const hasExplicitEpisode =
    only.episode !== undefined ||
    only.absoluteEpisode !== undefined ||
    only.episodeRange !== undefined;
  return !explicitSeasonMismatch &&
    (!hasExplicitEpisode || explicitEpisodeMatch)
    ? videos
    : [];
}

export function buildDeepbridQueries(
  metadata: NewshostingMediaMetadata,
  media: NewshostingMediaRequest
): string[] {
  const standard = buildNewshostingQueries(metadata, media);
  if (media.type !== 'series' || !media.season || !media.episode) {
    return standard.slice(0, 2);
  }
  const exact = standard.find((query) => /\bS\d{2}E\d{2,3}\b/i.test(query));
  const season = standard.find(
    (query) => /\bS\d{2}\b/i.test(query) && !/\bS\d{2}E\d{2,3}\b/i.test(query)
  );
  const broad = standard.find(
    (query) => !/\bS\d{2}(?:E\d{2,3})?\b/i.test(query)
  );
  return [...new Set([exact, season, broad].filter(Boolean))] as string[];
}

type RankedDeepbridResult = {
  result: DeepbridFinderResult;
  score: number;
  confirmed: boolean;
  confidence: 'high' | 'medium' | 'low';
  matchReason: string;
};

export function prioritizeDeepbridSeasonPacks(
  ranked: RankedDeepbridResult[],
  media: NewshostingMediaRequest,
  limit: number
): RankedDeepbridResult[] {
  const cappedLimit = Math.max(0, limit);
  if (cappedLimit === 0) return ranked;
  if (media.type !== 'series' || media.season === undefined) {
    return ranked.slice(0, cappedLimit);
  }

  // Exact episode searches can produce enough high-scoring results to fill
  // the resolve budget before a season pack is reached. Reserve a small part
  // of that budget for matching packs and resolve them first, while retaining
  // the original ranking for the rest.
  const packs = ranked.filter((item) => {
    const parsed = parseNewshostingRelease(item.result.title);
    return parsed.season === media.season && parsed.seasonPack === true;
  });
  const packLimit = Math.min(
    packs.length,
    Math.max(1, Math.ceil(cappedLimit / 4))
  );
  const selectedPacks = packs.slice(0, packLimit);
  const packTokens = new Set(selectedPacks.map((item) => item.result.token));
  return [
    ...selectedPacks,
    ...ranked.filter((item) => !packTokens.has(item.result.token)),
  ].slice(0, cappedLimit);
}

type ResolvedDeepbridFile = RankedDeepbridResult & {
  file: DeepbridFinderFile;
  archiveExpanded: boolean;
  archiveIntegrity: 'not-assessed' | 'not-verified' | 'incomplete';
  containerProbePassed: boolean;
};

export interface DeepbridSpecScoreInput {
  titleMatchConfirmed: boolean;
  containerProbePassed: boolean;
  result: Pick<DeepbridFinderResult, 'sources'> &
    Partial<Pick<DeepbridFinderResult, 'size'>>;
  file: Pick<DeepbridFinderFile, 'name' | 'size'>;
}

/** AIOStreams-side card score; not Deepbrid's own TrueSpec verification. */
export function scoreDeepbridSpec(input: DeepbridSpecScoreInput): number {
  const release = parseNewshostingRelease(input.file.name);
  const resolutionPoints: Record<string, number> = {
    '2160p': 10,
    '1080p': 9,
    '720p': 7,
    '480p': 4,
  };
  const qualityPoints: Record<string, number> = {
    REMUX: 8,
    BluRay: 7,
    'WEB-DL': 6,
    WEBRip: 5,
    HDTV: 3,
  };
  const sourcePoints = Math.min(12, Math.max(0, input.result.sources) * 2);
  const metadataPoints =
    (resolutionPoints[release.resolution] ?? 0) +
    (qualityPoints[release.quality] ?? 0) +
    (release.codec === 'unknown' ? 0 : 5) +
    (release.hdr === 'none' || release.hdr === 'unknown' ? 0 : 4) +
    (release.audioFormats?.length ? 5 : 0) +
    (release.audioChannels ? 3 : 0) +
    (input.file.size > 0 || (input.result.size ?? 0) > 0 ? 3 : 0);
  return Math.min(
    100,
    (input.titleMatchConfirmed ? 30 : 0) +
      (input.containerProbePassed ? 25 : 0) +
      sourcePoints +
      metadataPoints
  );
}

function formatDeepbridSpecEvidence(
  result: DeepbridFinderResult,
  file: DeepbridFinderFile,
  score: number,
  containerProbePassed: boolean
): string[] {
  const release = parseNewshostingRelease(file.name);
  const filenameTags = [
    release.resolution !== 'unknown' ? release.resolution : undefined,
    release.codec !== 'unknown' ? release.codec : undefined,
    ...(release.hdrFormats ?? []),
    ...(release.audioFormats ?? (release.audio ? [release.audio] : [])),
    release.audioChannels,
    release.languages?.length
      ? `Languages ${release.languages.join('/')}`
      : undefined,
  ].filter((value): value is string => Boolean(value));
  return [
    result.title,
    file.name,
    filenameTags.length
      ? `🎞 ${filenameTags.join(' · ')} (filename tags; not media-inspected)`
      : undefined,
    `✦ DeepSpec ${score}/100 · AIOStreams estimate v1`,
    `🔎 Finder sources: ${result.sources} · ${
      containerProbePassed
        ? 'range/container probe passed'
        : 'range/container probe not verified'
    }`,
  ].filter((line): line is string => Boolean(line));
}

export interface ResolveDeepbridOptions {
  concurrency: number;
  maxResults: number;
  deadline: number;
  /** Reject uncapped progressive resolution if any eligible candidate is left unattempted. */
  requireCompleteResolution?: boolean;
  signal?: AbortSignal;
  now?: () => number;
  getContent: (
    token: string,
    archives: boolean,
    options: { timeoutMs: number; signal?: AbortSignal }
  ) => Promise<DeepbridFinderContent>;
  probeFile?: (
    file: DeepbridFinderFile,
    options: { timeoutMs: number; signal?: AbortSignal }
  ) => Promise<boolean>;
  /** Set false when probeFile is only an eligibility filter, not a container probe. */
  probeFileValidatesContainer?: boolean;
  /** Receives each successful candidate batch as soon as it is verified. */
  onResolved?: (
    files: ResolvedDeepbridFile[],
    candidateIndex: number
  ) => Promise<void> | void;
  onSummary?: (summary: DeepbridResolutionSummary) => void | Promise<void>;
}

export interface DeepbridResolutionSummary {
  candidates: number;
  attempted: number;
  contentRequests: number;
  resolutionFailures: number;
  resolutionFailureClasses: Record<DeepbridResolutionFailureClass, number>;
  apiFailureKinds: Record<DeepbridApiFailureKind, number>;
  retryExhaustionReasons: Record<DeepbridRetryExhaustionReason, number>;
  api12Skips: number;
  otherApiFailures: number;
  passwordProtected: number;
  episodeMatchedFiles: number;
  returnedFiles: number;
  unattempted: number;
  deadlineSkipped: number;
  stopReason: 'complete' | 'deadline' | 'aborted' | 'max-results' | 'failed';
  deadlineReached: boolean;
  aborted: boolean;
}

export type DeepbridResolutionFailureClass =
  'abort' | 'timeout' | 'connection' | 'api' | 'other';

export type DeepbridApiFailureKind =
  | 'api_12'
  | 'api_response'
  | 'http_error'
  | 'retry_exhausted'
  | 'cloudflare_response'
  | 'invalid_json'
  | 'unsafe_download_url'
  | 'request_gate_capacity'
  | 'other';

const RETRY_EXHAUSTION_REASONS: readonly DeepbridRetryExhaustionReason[] = [
  'request_gate_deadline',
  'wrapper_budget_before_attempt',
  'wrapper_completed_after_deadline',
  'request_json_budget_before_attempt',
  'request_json_budget_at_gate',
  'request_json_loop_exhausted',
  'signature_correction_budget',
  'finder_budget_at_gate',
  'unknown',
];

const RETRY_EXHAUSTION_REASON_SET = new Set<string>(RETRY_EXHAUSTION_REASONS);

function emptyRetryExhaustionReasons(): Record<
  DeepbridRetryExhaustionReason,
  number
> {
  return Object.fromEntries(
    RETRY_EXHAUSTION_REASONS.map((reason) => [reason, 0])
  ) as Record<DeepbridRetryExhaustionReason, number>;
}

function classifyRetryExhaustionReason(
  error: DeepbridApiError
): DeepbridRetryExhaustionReason {
  const reason = error.retryExhaustionReason;
  return reason && RETRY_EXHAUSTION_REASON_SET.has(reason) ? reason : 'unknown';
}

function classifyDeepbridApiFailure(
  error: DeepbridApiError
): DeepbridApiFailureKind {
  if (error.code === 'api_12') return 'api_12';
  if (/^api_\d+$/.test(error.code ?? '')) return 'api_response';
  switch (error.code) {
    case 'http-error':
      return 'http_error';
    case 'retry-exhausted':
      return 'retry_exhausted';
    case 'cloudflare-response':
      return 'cloudflare_response';
    case 'invalid-json':
      return 'invalid_json';
    case 'unsafe-download-url':
      return 'unsafe_download_url';
    case 'request-gate-capacity':
      return 'request_gate_capacity';
    default:
      return 'other';
  }
}

export function classifyDeepbridResolutionFailure(
  error: unknown
): DeepbridResolutionFailureClass {
  const root =
    error && typeof error === 'object'
      ? (error as { name?: unknown; code?: unknown })
      : undefined;
  const rootCode = typeof root?.code === 'string' ? root.code : '';
  if (root?.name === 'AbortError' || rootCode === 'ABORT_ERR') return 'abort';
  if (
    root?.name === 'TimeoutError' ||
    [
      'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
    ].includes(rootCode)
  ) {
    return 'timeout';
  }
  if (
    [
      'ECONNRESET',
      'ECONNREFUSED',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'EPIPE',
      'UND_ERR_SOCKET',
    ].includes(rootCode)
  ) {
    return 'connection';
  }
  if (error instanceof DeepbridApiError) return 'api';

  // Inspect only a bounded cause chain after classifying the root error.
  const seen = new Set<object>();
  let current: unknown =
    root && 'cause' in root ? (root as { cause?: unknown }).cause : undefined;
  for (
    let depth = 0;
    depth < 4 && current && typeof current === 'object';
    depth++
  ) {
    if (seen.has(current)) break;
    seen.add(current);
    const value = current as {
      name?: unknown;
      code?: unknown;
      cause?: unknown;
    };
    const name = typeof value.name === 'string' ? value.name : '';
    const code = typeof value.code === 'string' ? value.code : '';
    // This denotes an abort-shaped error only; it does not prove caller cancellation.
    if (name === 'AbortError' || code === 'ABORT_ERR') return 'abort';
    if (
      name === 'TimeoutError' ||
      [
        'ETIMEDOUT',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_BODY_TIMEOUT',
      ].includes(code)
    ) {
      return 'timeout';
    }
    if (
      [
        'ECONNRESET',
        'ECONNREFUSED',
        'EHOSTUNREACH',
        'ENETUNREACH',
        'EPIPE',
        'UND_ERR_SOCKET',
      ].includes(code)
    ) {
      return 'connection';
    }
    current = value.cause;
  }
  return 'other';
}

/** Archive expansion does not prove that every multipart volume was present. */
export function classifyDeepbridArchiveIntegrity(
  archiveExpanded: boolean,
  listedArchiveFiles: readonly Pick<
    DeepbridFinderFile,
    'name' | 'unreachable'
  >[] = []
): 'not-assessed' | 'not-verified' | 'incomplete' {
  if (assessDeepbridArchiveVolumes(listedArchiveFiles).incomplete) {
    return 'incomplete';
  }
  return archiveExpanded ? 'not-verified' : 'not-assessed';
}

function emptyDeepbridResolutionFailureClasses(): Record<
  DeepbridResolutionFailureClass,
  number
> {
  return {
    abort: 0,
    timeout: 0,
    connection: 0,
    api: 0,
    other: 0,
  };
}

function emptyDeepbridApiFailureKinds(): Record<
  DeepbridApiFailureKind,
  number
> {
  return {
    api_12: 0,
    api_response: 0,
    http_error: 0,
    retry_exhausted: 0,
    cloudflare_response: 0,
    invalid_json: 0,
    unsafe_download_url: 0,
    request_gate_capacity: 0,
    other: 0,
  };
}

export class DeepbridResolutionIncompleteError extends Error {
  constructor(readonly summary: DeepbridResolutionSummary) {
    super(
      `Deepbrid Finder resolution incomplete: attempted ${summary.attempted} of ${summary.candidates} candidates; ${summary.unattempted} unattempted (${summary.stopReason}).`
    );
    this.name = 'DeepbridResolutionIncompleteError';
  }
}

const DEEPBRID_CALL_TIMEOUT_MS = 7_000;
const DEEPBRID_DEADLINE_MARGIN_MS = 3_000;
const DEEPBRID_FINDER_PAGE_RETRY_DELAYS_MS = [250, 750] as const;
const DEEPBRID_MIN_REQUEST_BUDGET_MS = 750;

function remainingRequestBudget(deadline: number, now: () => number): number {
  return Math.min(DEEPBRID_CALL_TIMEOUT_MS, deadline - now());
}

export async function runWithinDeepbridRequestBudget<T>(
  deadline: number,
  now: () => number,
  signal: AbortSignal | undefined,
  run: (timeoutMs: number) => Promise<T>
): Promise<T> {
  const timeoutMs = remainingRequestBudget(deadline, now);
  if (signal?.aborted || timeoutMs < DEEPBRID_MIN_REQUEST_BUDGET_MS) {
    throw new DOMException('Deepbrid request budget exhausted', 'AbortError');
  }
  return run(timeoutMs);
}

/** Recompute the remaining deadline after a request enters a shared queue. */
export function runQueuedDeepbridRequest<T>(
  deadline: number,
  now: () => number,
  signal: AbortSignal | undefined,
  enqueue: (task: () => Promise<T>) => Promise<T>,
  run: (remainingMs: number) => Promise<T>
): Promise<T> {
  return enqueue(() =>
    runWithinDeepbridRequestBudget(deadline, now, signal, run)
  );
}

/**
 * Serializes page batches without waiting inside Finder pagination. Discovery
 * can keep fetching later pages while the earliest available candidate batch
 * resolves; drain() is the only synchronization barrier, at response finish.
 */
export class DeepbridProgressiveResolutionQueue<TInput, TOutput = TInput> {
  private tail: Promise<void> = Promise.resolve();
  private readonly resolved: TOutput[] = [];
  private readonly failures: unknown[] = [];
  private failedBatchCount = 0;
  private pendingCandidates = 0;
  private readonly waiters: Array<() => void> = [];
  private static readonly MAX_PENDING_CANDIDATES = 200;

  async enqueue(
    batch: TInput[],
    resolve: (batch: TInput[]) => Promise<TOutput[]>,
    signal?: AbortSignal
  ): Promise<void> {
    if (batch.length === 0 || signal?.aborted) return;
    while (
      !signal?.aborted &&
      this.pendingCandidates > 0 &&
      this.pendingCandidates + batch.length >
        DeepbridProgressiveResolutionQueue.MAX_PENDING_CANDIDATES
    ) {
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          signal?.removeEventListener('abort', wake);
          resolve();
        };
        this.waiters.push(wake);
        signal?.addEventListener('abort', wake, { once: true });
      });
    }
    if (signal?.aborted) return;
    this.pendingCandidates += batch.length;
    this.tail = this.tail.then(async () => {
      try {
        this.resolved.push(...(await resolve(batch)));
      } catch (error) {
        this.failedBatchCount++;
        if (this.failures.length < 32) this.failures.push(error);
      } finally {
        this.pendingCandidates -= batch.length;
        const waiters = this.waiters.splice(0);
        waiters.forEach((wake) => wake());
      }
    });
  }

  async drain(): Promise<{
    resolved: TOutput[];
    failures: unknown[];
    failedBatchCount: number;
  }> {
    await this.tail;
    return {
      resolved: [...this.resolved],
      failures: [...this.failures],
      failedBatchCount: this.failedBatchCount,
    };
  }
}

export interface DeepbridProbeBatchResult<T> {
  playable: T[];
  rejected: number;
  errors: number;
  aborted: number;
}

/**
 * Probe Finder playback links independently. A single transient request-budget,
 * cooldown, or CDN error must not discard the other already-resolved files.
 */
export async function filterDeepbridProbeResults<T>(
  items: readonly T[],
  options: {
    concurrency: number;
    signal?: AbortSignal;
    probe: (item: T) => Promise<boolean>;
  }
): Promise<DeepbridProbeBatchResult<T>> {
  const limit = pLimit(Math.max(1, Math.min(10, options.concurrency)));
  const outcomes = await Promise.all(
    items.map((item) =>
      limit(async () => {
        if (options.signal?.aborted) return { status: 'aborted' as const };
        try {
          return (await options.probe(item))
            ? { status: 'playable' as const, item }
            : { status: 'rejected' as const };
        } catch (error) {
          if (
            options.signal?.aborted ||
            (error instanceof Error && error.name === 'AbortError')
          ) {
            return { status: 'aborted' as const };
          }
          return { status: 'error' as const };
        }
      })
    )
  );

  return {
    playable: outcomes.flatMap((outcome) =>
      outcome.status === 'playable' ? [outcome.item] : []
    ),
    rejected: outcomes.filter((outcome) => outcome.status === 'rejected')
      .length,
    errors: outcomes.filter((outcome) => outcome.status === 'error').length,
    aborted: outcomes.filter((outcome) => outcome.status === 'aborted').length,
  };
}

export async function resolveDeepbridFiles(
  ranked: RankedDeepbridResult[],
  media: NewshostingMediaRequest,
  options: ResolveDeepbridOptions
): Promise<ResolvedDeepbridFile[]> {
  const now = options.now ?? Date.now;
  const resolvedByIndex = new Map<number, ResolvedDeepbridFile[]>();
  const concurrency = Math.max(1, Math.min(10, options.concurrency));
  let nextIndex = 0;
  let resolvedCount = 0;
  let activeCandidates = 0;
  let attempted = 0;
  let contentRequests = 0;
  let resolutionFailures = 0;
  let api12Skips = 0;
  let otherApiFailures = 0;
  const apiFailureKinds = emptyDeepbridApiFailureKinds();
  const retryExhaustionReasons = emptyRetryExhaustionReasons();
  const resolutionFailureClasses = emptyDeepbridResolutionFailureClasses();
  let passwordProtected = 0;
  let episodeMatchedFiles = 0;
  let deadlineSkipped = 0;
  let capacityWaiters: Array<() => void> = [];
  const notifyCapacity = (): void => {
    const waiters = capacityWaiters;
    capacityWaiters = [];
    waiters.forEach((wake) => wake());
  };
  options.signal?.addEventListener('abort', notifyCapacity, { once: true });
  const worker = async (): Promise<void> => {
    while (true) {
      if (
        options.signal?.aborted ||
        remainingRequestBudget(options.deadline, now) <
          DEEPBRID_MIN_REQUEST_BUDGET_MS ||
        (options.maxResults > 0 && resolvedCount >= options.maxResults)
      ) {
        return;
      }
      if (
        options.maxResults > 0 &&
        resolvedCount + activeCandidates >= options.maxResults
      ) {
        await new Promise<void>((resolve) => capacityWaiters.push(resolve));
        continue;
      }
      const index = nextIndex++;
      if (index >= ranked.length) return;
      attempted += 1;
      const item = ranked[index];
      activeCandidates += 1;
      let resolvedValues: ResolvedDeepbridFile[] | undefined;
      try {
        const release = parseNewshostingRelease(item.result.title);
        const seasonPack =
          media.type === 'series' &&
          media.season !== undefined &&
          release.season === media.season &&
          release.seasonPack === true;
        let timeoutMs = remainingRequestBudget(options.deadline, now);
        if (timeoutMs < DEEPBRID_MIN_REQUEST_BUDGET_MS) {
          deadlineSkipped += 1;
          return;
        }

        // Finder can expand a known season pack in the same request. Avoid
        // first fetching its archive listing and then fetching it again.
        let archiveExpanded = seasonPack;
        contentRequests += 1;
        let content = await options.getContent(item.result.token, seasonPack, {
          timeoutMs,
          signal: options.signal,
        });
        const listedArchiveFiles = content.files.filter((file) =>
          isDeepbridArchiveName(file.name)
        );
        if (content.hasPassword) {
          passwordProtected += 1;
          continue;
        }
        if (
          !seasonPack &&
          content.files.some((file) => isDeepbridArchiveName(file.name))
        ) {
          timeoutMs = remainingRequestBudget(options.deadline, now);
          if (timeoutMs < DEEPBRID_MIN_REQUEST_BUDGET_MS) {
            deadlineSkipped += 1;
            return;
          }
          contentRequests += 1;
          content = await options.getContent(item.result.token, true, {
            timeoutMs,
            signal: options.signal,
          });
          archiveExpanded = true;
        }
        const finderFiles = content.files.map((file) =>
          file.nzbUrl || !item.result.nzbUrl
            ? file
            : { ...file, nzbUrl: item.result.nzbUrl }
        );
        const files = chooseDeepbridVideoFiles(
          finderFiles,
          media,
          item.result.title
        );
        episodeMatchedFiles += files.length;
        if (!options.probeFile) {
          const values = files.map((file) => ({
            ...item,
            file,
            archiveExpanded,
            archiveIntegrity: classifyDeepbridArchiveIntegrity(
              archiveExpanded,
              listedArchiveFiles
            ),
            containerProbePassed: false,
          }));
          resolvedByIndex.set(index, values);
          resolvedCount += values.length;
          resolvedValues = values;
        } else {
          const probed = await Promise.all(
            files.map(async (file) => {
              const probeTimeoutMs = remainingRequestBudget(
                options.deadline,
                now
              );
              if (probeTimeoutMs < DEEPBRID_MIN_REQUEST_BUDGET_MS)
                return undefined;
              return (await options.probeFile!(file, {
                timeoutMs: probeTimeoutMs,
                signal: options.signal,
              }))
                ? {
                    ...item,
                    file,
                    archiveExpanded,
                    archiveIntegrity: classifyDeepbridArchiveIntegrity(
                      archiveExpanded,
                      listedArchiveFiles
                    ),
                    containerProbePassed:
                      options.probeFileValidatesContainer !== false,
                  }
                : undefined;
            })
          );
          const values = probed.filter(
            (value): value is ResolvedDeepbridFile => value !== undefined
          );
          resolvedByIndex.set(index, values);
          resolvedCount += values.length;
          resolvedValues = values;
        }
      } catch (error) {
        resolutionFailures += 1;
        const failureClass = classifyDeepbridResolutionFailure(error);
        resolutionFailureClasses[failureClass] += 1;
        if (error instanceof DeepbridApiError) {
          const apiFailureKind = classifyDeepbridApiFailure(error);
          apiFailureKinds[apiFailureKind] += 1;
          if (apiFailureKind === 'retry_exhausted') {
            retryExhaustionReasons[classifyRetryExhaustionReason(error)] += 1;
          }
        }
        if (error instanceof DeepbridApiError && error.code === 'api_12') {
          api12Skips += 1;
          continue;
        }
        if (error instanceof DeepbridApiError) otherApiFailures += 1;
        logger.debug({ failureClass }, 'Deepbrid content resolution failed');
      } finally {
        activeCandidates -= 1;
        notifyCapacity();
      }
      if (resolvedValues?.length) {
        try {
          await options.onResolved?.(resolvedValues, index);
        } catch (error) {
          if (options.signal?.aborted) throw error;
          // Progress delivery must never discard a candidate that was already
          // verified. The final ordered result remains independent of UI I/O.
          logger.debug(
            { failureClass: classifyDeepbridResolutionFailure(error) },
            'Deepbrid progress notification failed'
          );
        }
      }
    }
  };

  let workerFailed = false;
  let workerFailure: unknown;
  try {
    const workerResults = await Promise.allSettled(
      Array.from({ length: concurrency }, () => worker())
    );
    const rejectedWorker = workerResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (rejectedWorker) {
      workerFailed = true;
      workerFailure = rejectedWorker.reason;
    }
  } finally {
    options.signal?.removeEventListener('abort', notifyCapacity);
    notifyCapacity();
  }
  const resolved = [...resolvedByIndex.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([, values]) => values);
  const limitedResolved =
    options.maxResults > 0 ? resolved.slice(0, options.maxResults) : resolved;
  const deadlineReached =
    remainingRequestBudget(options.deadline, now) <
    DEEPBRID_MIN_REQUEST_BUDGET_MS;
  const aborted = Boolean(options.signal?.aborted);
  const unattempted = Math.max(0, ranked.length - attempted);
  const stopReason: DeepbridResolutionSummary['stopReason'] = aborted
    ? 'aborted'
    : workerFailed
      ? 'failed'
      : deadlineReached
        ? 'deadline'
        : options.maxResults > 0 &&
            resolved.length >= options.maxResults &&
            (unattempted > 0 || resolved.length > limitedResolved.length)
          ? 'max-results'
          : 'complete';
  const handleSummaryFailure = (error: unknown): void => {
    logger.debug(
      { failureClass: classifyDeepbridResolutionFailure(error) },
      'Deepbrid resolution accounting callback failed'
    );
  };
  try {
    const summaryResult = options.onSummary?.({
      candidates: ranked.length,
      attempted,
      contentRequests,
      resolutionFailures,
      resolutionFailureClasses: { ...resolutionFailureClasses },
      apiFailureKinds: { ...apiFailureKinds },
      retryExhaustionReasons: { ...retryExhaustionReasons },
      api12Skips,
      otherApiFailures,
      passwordProtected,
      episodeMatchedFiles,
      returnedFiles: workerFailed ? 0 : limitedResolved.length,
      unattempted,
      deadlineSkipped,
      stopReason,
      deadlineReached,
      aborted,
    });
    void Promise.resolve(summaryResult).catch(handleSummaryFailure);
  } catch (error) {
    handleSummaryFailure(error);
  }
  if (workerFailed) throw workerFailure;
  if (
    options.requireCompleteResolution &&
    stopReason !== 'complete' &&
    stopReason !== 'max-results'
  ) {
    throw new DeepbridResolutionIncompleteError({
      candidates: ranked.length,
      attempted,
      contentRequests,
      resolutionFailures,
      resolutionFailureClasses: { ...resolutionFailureClasses },
      apiFailureKinds: { ...apiFailureKinds },
      retryExhaustionReasons: { ...retryExhaustionReasons },
      api12Skips,
      otherApiFailures,
      passwordProtected,
      episodeMatchedFiles,
      returnedFiles: limitedResolved.length,
      unattempted,
      deadlineSkipped,
      stopReason,
      deadlineReached,
      aborted,
    });
  }
  return limitedResolved;
}

/** Fetch all available Finder pages until the API ends, the deadline expires,
 * cancellation is requested, or the provider repeats a page. */
export async function searchDeepbridFinderPages(
  client: DeepbridFinderClient,
  query: string,
  options: {
    category?: string;
    deadline: number;
    signal?: AbortSignal;
    now?: () => number;
    /** Called for each page's newly discovered results, before the next page is fetched. */
    onPage?: (page: {
      offset: number;
      results: DeepbridFinderResult[];
      rawCount: number;
      invalidCount: number;
    }) => void | Promise<void>;
    onOutcome?: (outcome: DeepbridFinderPaginationOutcome) => void;
  }
): Promise<DeepbridFinderResult[]> {
  const pageSize = 50;
  const results: DeepbridFinderResult[] = [];
  const seenTokens = new Set<string>();
  const now = options.now ?? Date.now;
  let pagesFetched = 0;
  let pageRetries = 0;
  let invalidResultCount = 0;
  let consecutiveRepeatedPages = 0;
  let termination: DeepbridFinderPaginationTermination = 'no-more-results';
  let pageError: unknown;
  for (let offset = 0; !options.signal?.aborted; offset += pageSize) {
    const timeoutMs = remainingRequestBudget(options.deadline, now);
    if (timeoutMs < DEEPBRID_MIN_REQUEST_BUDGET_MS) {
      termination = 'deadline';
      break;
    }
    let page:
      | {
          results: DeepbridFinderResult[];
          rawCount: number;
          invalidCount: number;
        }
      | undefined;
    let pageAttempts = 0;
    while (!page) {
      const attemptBudgetMs = remainingRequestBudget(options.deadline, now);
      if (attemptBudgetMs < DEEPBRID_MIN_REQUEST_BUDGET_MS) {
        termination = options.signal?.aborted ? 'aborted' : 'deadline';
        break;
      }
      try {
        page = await client.searchPage(query, {
          category: options.category,
          offset,
          limit: pageSize,
          timeoutMs: attemptBudgetMs,
          deadlineAtMs: options.deadline,
          signal: options.signal,
        });
        // A successful retry resolves the transient page failure. Do not let
        // the stale error make an otherwise valid empty first page throw.
        pageError = undefined;
      } catch (error) {
        pageError = error;
        if (options.signal?.aborted) {
          termination = 'aborted';
          break;
        }
        // Enforce the attempt cap independently of an error-specific Retry-
        // After value; a provider-supplied zero must not create an unbounded
        // retry loop.
        if (pageAttempts >= DEEPBRID_FINDER_PAGE_RETRY_DELAYS_MS.length) {
          termination = 'page-error';
          break;
        }
        const fallbackRetryDelayMs =
          DEEPBRID_FINDER_PAGE_RETRY_DELAYS_MS[pageAttempts];
        const retryDelayMs =
          error instanceof DeepbridApiError && error.status === 429
            ? Math.max(fallbackRetryDelayMs, error.retryAfterMs ?? 5_000)
            : fallbackRetryDelayMs;
        if (
          retryDelayMs === undefined ||
          !Number.isFinite(retryDelayMs) ||
          retryDelayMs < 0 ||
          !isRetryableDeepbridFinderPageError(error)
        ) {
          termination = 'page-error';
          break;
        }
        if (
          remainingRequestBudget(options.deadline, now) <
          retryDelayMs + DEEPBRID_MIN_REQUEST_BUDGET_MS
        ) {
          termination = 'deadline';
          break;
        }
        try {
          await waitForDeepbridFinderRetry(retryDelayMs, options.signal);
        } catch {
          termination = 'aborted';
          break;
        }
        pageAttempts++;
        pageRetries++;
      }
    }
    if (!page) break;
    pagesFetched++;
    invalidResultCount += page.invalidCount;
    let added = 0;
    const newlyDiscovered: DeepbridFinderResult[] = [];
    for (const result of page.results) {
      if (seenTokens.has(result.token)) continue;
      seenTokens.add(result.token);
      results.push(result);
      newlyDiscovered.push(result);
      added += 1;
    }
    if (newlyDiscovered.length > 0) {
      await options.onPage?.({
        offset,
        results: newlyDiscovered,
        rawCount: page.rawCount,
        invalidCount: page.invalidCount,
      });
    }

    // Finder does not provide a documented total/has-more contract. A short
    // non-empty page is therefore not authoritative EOF: ask for the next
    // offset and stop only when the provider returns an empty page. This costs
    // at most one extra request for the final partial page and avoids hiding
    // valid later rows.
    if (page.rawCount === 0) {
      termination = 'no-more-results';
      break;
    }
    // Malformed rows are not evidence of exhaustion. Keep walking until the
    // request deadline or an empty page, while the deadline remains the hard
    // safety bound.
    if (page.invalidCount === page.rawCount) {
      continue;
    }
    if (added === 0) {
      // A single overlapping page can occur with unstable provider ordering.
      // Allow later offsets to contribute, but stop an endpoint that ignores
      // offsets after repeated duplicate-only pages and report incomplete.
      consecutiveRepeatedPages++;
      if (consecutiveRepeatedPages >= 3) {
        termination = 'repeated-page';
        break;
      }
    } else {
      consecutiveRepeatedPages = 0;
    }
  }
  if (options.signal?.aborted) termination = 'aborted';
  options.onOutcome?.({
    pagesFetched,
    pageRetries,
    resultCount: results.length,
    invalidResultCount,
    termination,
  });
  if (pageError && results.length === 0) throw pageError;
  return results;
}

function isRetryableDeepbridFinderPageError(error: unknown): boolean {
  if (error instanceof DeepbridApiError) {
    if (error.status === 401 || error.status === 403) return false;
    return (
      error.status === 408 ||
      error.status === 425 ||
      error.status === 429 ||
      (error.status !== undefined && error.status >= 500) ||
      error.code === 'cloudflare-response' ||
      error.code === 'invalid-json' ||
      error.code === 'retry-exhausted'
    );
  }
  if (!(error instanceof Error)) return false;
  if (error.name === 'TimeoutError') return true;
  const networkCodes = [
    'ECONNABORTED',
    'ECONNRESET',
    'EAI_AGAIN',
    'ENETUNREACH',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
  ];
  const cause = (error as NodeJS.ErrnoException & { cause?: unknown }).cause;
  const causeCode =
    cause && typeof cause === 'object' && 'code' in cause
      ? String(cause.code)
      : undefined;
  if (
    networkCodes.includes((error as NodeJS.ErrnoException).code ?? '') ||
    networkCodes.includes(causeCode ?? '')
  ) {
    return true;
  }
  // Undici reports some transport failures as `TypeError: fetch failed` with
  // no stable cause code. Other TypeErrors usually indicate a programming or
  // response-shape bug and must not be retried as if they were transient I/O.
  return error.name === 'TypeError' && /^fetch failed$/i.test(error.message);
}

function waitForDeepbridFinderRetry(
  delayMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException('Aborted', 'AbortError')
    );
  }
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export type DeepbridFinderPaginationTermination =
  | 'no-more-results'
  | 'deadline'
  | 'aborted'
  | 'page-error'
  | 'repeated-page'
  | 'invalid-page-limit';

export interface DeepbridFinderPaginationOutcome {
  pagesFetched: number;
  pageRetries: number;
  resultCount: number;
  invalidResultCount: number;
  termination: DeepbridFinderPaginationTermination;
}

export function summarizeDeepbridPagination(
  outcomes: readonly DeepbridFinderPaginationOutcome[]
): {
  pagesFetched: number;
  pageRetries: number;
  invalidResultCount: number;
  incompleteQueries: number;
  terminationCounts: Record<DeepbridFinderPaginationTermination, number>;
} {
  const terminationCounts: Record<DeepbridFinderPaginationTermination, number> =
    {
      'no-more-results': 0,
      deadline: 0,
      aborted: 0,
      'page-error': 0,
      'repeated-page': 0,
      'invalid-page-limit': 0,
    };

  for (const outcome of outcomes) {
    terminationCounts[outcome.termination] += 1;
  }

  return {
    pagesFetched: outcomes.reduce(
      (total, outcome) => total + outcome.pagesFetched,
      0
    ),
    pageRetries: outcomes.reduce(
      (total, outcome) => total + outcome.pageRetries,
      0
    ),
    incompleteQueries:
      terminationCounts.deadline +
      terminationCounts.aborted +
      terminationCounts['page-error'] +
      terminationCounts['repeated-page'] +
      terminationCounts['invalid-page-limit'],
    invalidResultCount: outcomes.reduce(
      (total, outcome) => total + outcome.invalidResultCount,
      0
    ),
    terminationCounts,
  };
}

export function deepbridCoverageStatus(input: {
  failedSearches?: number;
  incompleteQueries?: number;
  resolutionFailures?: number;
  aborted?: boolean;
}): 'partial' | 'complete' {
  return input.aborted ||
    (input.failedSearches ?? 0) > 0 ||
    (input.incompleteQueries ?? 0) > 0 ||
    (input.resolutionFailures ?? 0) > 0
    ? 'partial'
    : 'complete';
}

export class DeepbridUsenetAddon extends BaseDebridAddon<DeepbridUsenetConfig> {
  readonly id = 'deepbrid-usenet';
  readonly name = 'Deepbrid Usenet';
  readonly version = '1.0.0';
  readonly logger = logger;
  // The HTTP builtin routes construct one addon instance per incoming request;
  // this value therefore correlates only that request's nested async work.
  private readonly requestTraceId = randomBytes(8).toString('hex');
  private readonly bothProbeStats = {
    candidates: 0,
    playable: 0,
    rejected: 0,
    errors: 0,
    aborted: 0,
  };
  private bothFinderDataPromise?: Promise<{
    resolved: Awaited<ReturnType<typeof resolveDeepbridFiles>>;
    deadline: number;
    coverage: 'partial' | 'complete';
  }>;
  private bothOnResolved?: (
    streams: Stream[],
    candidateIndex: number
  ) => Promise<void> | void;
  private bothSignal?: AbortSignal;
  private readonly bothProbeCache = new Map<string, Promise<boolean>>();
  private readonly bothProgressiveStreams =
    new ValidatedProgressiveStreamCollector();
  private bothDirectProbeQueue?: ValidatedFinderResolutionQueue<
    Awaited<ReturnType<typeof resolveDeepbridFiles>>[number]
  >;

  constructor(config: DeepbridUsenetConfig, clientIp?: string) {
    super(config, DeepbridUsenetConfigSchema, clientIp);
  }

  private get deepbridApiKey(): string {
    return requireDeepbridApiKey(this.userData);
  }

  override async getStreams(
    type: string,
    id: string,
    signal?: AbortSignal,
    onResolved?: (
      streams: Stream[],
      candidateIndex: number
    ) => Promise<void> | void
  ): Promise<Stream[]> {
    // If in indexer mode, fallback to BaseDebridAddon processing which handles NZBs
    if (this.userData.mode === 'indexer') {
      return super.getStreams(type, id);
    }

    if (this.userData.mode === 'both') {
      // Preserve native Finder playback while the base pipeline sends the
      // same Finder NZBs through the other enabled Usenet services. Both
      // paths share the Finder search/content lookup to avoid duplicate API
      // traffic and duplicate candidate resolution.
      this.bothFinderDataPromise = undefined;
      this.bothProbeCache.clear();
      this.bothProgressiveStreams.clear();
      this.bothDirectProbeQueue = undefined;
      this.bothProbeStats.candidates = 0;
      this.bothProbeStats.playable = 0;
      this.bothProbeStats.rejected = 0;
      this.bothProbeStats.errors = 0;
      this.bothProbeStats.aborted = 0;
      this.bothOnResolved = onResolved;
      this.bothSignal = signal;
      const externalPromise = super.getStreams(type, id);
      const directPromise = this.getBothDirectStreams(type, id, signal);
      const [external, direct] = await Promise.allSettled([
        externalPromise,
        directPromise,
      ]);
      this.closeBothDirectProbeQueue();
      const externalStreams =
        external.status === 'fulfilled' ? external.value : [];
      const finalDirectStreams =
        direct.status === 'fulfilled' ? direct.value : [];
      const directStreams = this.bothProgressiveStreams.mergeFinal(
        finalDirectStreams,
        signal
      );
      const progressiveOnlyCount = Math.max(
        0,
        directStreams.length - finalDirectStreams.length
      );
      this.logger.info(
        {
          requestTraceId: this.requestTraceId,
          type,
          externalBranchStatus: external.status,
          directBranchStatus: direct.status,
          finderExternalServiceResults: externalStreams.filter(
            (stream) => Boolean(stream.url) && !stream.name?.startsWith('[❌]')
          ).length,
          finderExternalServiceErrors: externalStreams.filter((stream) =>
            stream.name?.startsWith('[❌]')
          ).length,
          finderDirectResults: directStreams.filter((stream) =>
            Boolean(stream.url)
          ).length,
          finderProgressiveOnlyResults: progressiveOnlyCount,
          probeCandidates: this.bothProbeStats.candidates,
          probePlayable: this.bothProbeStats.playable,
          probeRejected: this.bothProbeStats.rejected,
          probeErrors: this.bothProbeStats.errors,
          probeAborted: this.bothProbeStats.aborted,
        },
        'Deepbrid Finder both-mode result summary'
      );
      this.bothOnResolved = undefined;
      this.bothSignal = undefined;
      this.bothDirectProbeQueue = undefined;
      this.bothProgressiveStreams.clear();
      if (external.status === 'rejected') {
        this.logger.warn(
          { error: external.reason },
          'Deepbrid Finder external-service resolution failed; retaining direct Finder results'
        );
      }
      if (direct.status === 'rejected') {
        this.logger.warn(
          { error: direct.reason },
          'Deepbrid Finder direct resolution failed; retaining external-service results'
        );
      }
      const incompleteBranch = [external, direct].find(
        (branch) =>
          branch.status === 'rejected' &&
          branch.reason instanceof DeepbridResolutionIncompleteError
      );
      if (incompleteBranch?.status === 'rejected') {
        throw incompleteBranch.reason;
      }
      return [...directStreams, ...externalStreams];
    }

    const deadline =
      Date.now() +
      Math.max(
        DEEPBRID_MIN_REQUEST_BUDGET_MS,
        deepbridResolutionTimeout(this.userData.timeout, Boolean(onResolved)) -
          DEEPBRID_DEADLINE_MARGIN_MS
      );
    const parsedId = IdParser.parse(id, type);
    if (!parsedId || !this.supportedIdTypes.includes(parsedId.type))
      throw new Error(`Unsupported ID: ${id}`);
    this._searchMetadataPromise = this._getSearchMetadata(parsedId, type);
    const metadata = metadataForSearch(await this.getSearchMetadata());
    if (signal?.aborted) return [];
    const media = mediaForSearch(parsedId);
    const queries = buildDeepbridQueries(metadata, media);
    if (!queries.length) return [];

    const client = new DeepbridFinderClient(
      this.deepbridApiKey,
      this.userData.timeout
    );
    if (
      remainingRequestBudget(deadline, Date.now) <
      DEEPBRID_MIN_REQUEST_BUDGET_MS
    )
      return [];
    const paginationOutcomes: DeepbridFinderPaginationOutcome[] = [];
    // In progressive mode, start Finder content lookups as each search page
    // arrives instead of waiting for the slowest query to finish. The resolver
    // below consumes the same promises, so this is useful overlap rather than
    // duplicate API traffic. Keep it request-local and strictly bounded.
    const progressiveContent = new Map<
      string,
      Promise<DeepbridFinderContent>
    >();
    const progressiveSeenTokens = new Set<string>();
    const canPrefetchProgressively =
      Boolean(onResolved) &&
      this.userData.maxResults === 0 &&
      this.userData.maxContentResolves === 0;
    const earlyResolutionQueue = new DeepbridProgressiveResolutionQueue<
      RankedDeepbridResult,
      ResolvedDeepbridFile
    >();
    let resolutionHadFailures = false;
    let earlyCandidateOffset = 0;
    const resolveConcurrency = Math.max(
      1,
      Math.min(
        10,
        onResolved
          ? this.userData.progressiveResolveConcurrency
          : this.userData.resolveConcurrency
      )
    );
    const probeCache = new Map<string, Promise<boolean>>();
    const toStreams = (
      files: ResolvedDeepbridFile[],
      resolutionCoverage: 'progressive' | 'partial' | 'complete' = 'progressive'
    ): Stream[] =>
      files.flatMap(
        ({
          result,
          file,
          archiveExpanded,
          archiveIntegrity,
          confirmed,
          score,
          confidence,
          matchReason,
          containerProbePassed,
        }) => {
          const target = validateDeepbridDownloadUrl(file.link);
          const deepbridSpecScore = scoreDeepbridSpec({
            titleMatchConfirmed: confirmed,
            containerProbePassed,
            result,
            file,
          });
          const details = formatDeepbridSpecEvidence(
            result,
            file,
            deepbridSpecScore,
            containerProbePassed
          );
          const playbackVariants = createDeepbridPlaybackVariants(
            {
              apiKey: this.deepbridApiKey,
              url: target.toString(),
              filename: file.name,
              size: file.size || undefined,
              finderToken: result.token,
              finderArchives: archiveExpanded,
            },
            this.userData.playbackMode
          );
          return playbackVariants.map(
            ({ mode, label, url }) =>
              ({
                name: `[DB⚡] Deepbrid Usenet · ${label}`,
                title: result.title,
                description: [
                  ...details,
                  `📺 ${label} · 🔍 Deepbrid Usenet`,
                ].join('\n'),
                url,
                type: 'usenet',
                idMatched: true,
                age: ageHours(result.date),
                behaviorHints: {
                  notWebReady: false,
                  filename: file.name,
                  videoSize: file.size || result.size || undefined,
                  bingeGroup: `deepbrid-usenet|${file.name.toLowerCase()}`,
                  deepbridPlaybackMode: mode,
                  deepbridSeasonPack:
                    parseNewshostingRelease(result.title).seasonPack === true,
                  deepbridReleaseTitle: result.title,
                  deepbridReleaseSize: result.size || undefined,
                  deepbridSpecScore,
                  deepbridSpecSourceCount: result.sources,
                  deepbridSpecTitleMatch: confirmed,
                  deepbridSpecContainerProbePassed: containerProbePassed,
                  deepbridSpecVersion: 1,
                  deepbridMatchConfidence: confidence,
                  deepbridMatchScore: score,
                  deepbridMatchEvidence: matchReason,
                  deepbridEvidenceVersion: 1,
                  deepbridEvidence: {
                    parsed: true,
                    resolved: true,
                    probed: containerProbePassed,
                    playbackConfirmed: false,
                  },
                  deepbridNzbHash: file.nzbUrl
                    ? hashNzbUrl(file.nzbUrl)
                    : undefined,
                  deepbridArchiveExpanded: archiveExpanded,
                  deepbridArchiveIntegrity: archiveIntegrity,
                  deepbridResolutionCoverage: resolutionCoverage,
                },
              }) satisfies Stream
          );
        }
      );
    const resolveCandidates = (
      batch: RankedDeepbridResult[],
      candidateOffset = 0
    ): Promise<ResolvedDeepbridFile[]> =>
      resolveDeepbridFiles(batch, media, {
        concurrency: resolveConcurrency,
        maxResults: canPrefetchProgressively ? 0 : this.userData.maxResults,
        deadline,
        requireCompleteResolution:
          Boolean(onResolved) && this.userData.maxResults === 0,
        signal,
        getContent: (token, archives, requestOptions) =>
          getFinderContent(token, archives, requestOptions),
        probeFile: (file, requestOptions) => {
          const extension =
            file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
          const cacheKey = deepbridProbeCacheKey(
            this.deepbridApiKey,
            file.link,
            extension
          );
          const cached = probeCache.get(cacheKey);
          if (cached) return cached;
          if (hasSuccessfulDeepbridProbe(cacheKey)) {
            return Promise.resolve(true);
          }
          if (isDeepbridProbeQuarantined(cacheKey)) {
            return Promise.resolve(false);
          }
          const probe = deepbridNetworkLimit(() =>
            runWithinDeepbridRequestBudget(
              deadline,
              Date.now,
              signal,
              (remainingMs) =>
                probeDeepbridVideo(file, this.deepbridApiKey, {
                  ...requestOptions,
                  timeoutMs: Math.min(requestOptions.timeoutMs, remainingMs),
                  signal,
                })
            )
          ).then((playable) => {
            if (playable) rememberSuccessfulDeepbridProbe(cacheKey);
            else if (!signal?.aborted) rememberFailedDeepbridProbe(cacheKey);
            return playable;
          });
          probeCache.set(cacheKey, probe);
          return probe;
        },
        onResolved:
          onResolved && this.userData.maxResults === 0
            ? async (files, candidateIndex) => {
                await onResolved(
                  toStreams(files),
                  candidateOffset + candidateIndex
                );
              }
            : undefined,
        onSummary: (summary) => {
          if (
            summary.resolutionFailures > 0 ||
            summary.stopReason !== 'complete'
          ) {
            resolutionHadFailures = true;
          }
          const accounting = {
            requestTraceId: this.requestTraceId,
            ...summary,
            api: client.getRequestMetrics(),
          };
          if (summary.stopReason === 'complete') {
            this.logger.info(
              accounting,
              'Deepbrid Finder content resolution accounting'
            );
          } else {
            this.logger.warn(
              accounting,
              'Deepbrid Finder content resolution incomplete'
            );
          }
        },
      });
    const getFinderContent = (
      token: string,
      archives: boolean,
      requestOptions: { timeoutMs: number; signal?: AbortSignal }
    ): Promise<DeepbridFinderContent> => {
      const key = `${token}:${archives ? 'archives' : 'files'}`;
      const existing = progressiveContent.get(key);
      if (existing) return existing;
      const request = runQueuedDeepbridRequest<DeepbridFinderContent>(
        deadline,
        Date.now,
        signal,
        deepbridNetworkLimit,
        (remainingMs) =>
          client.getContent(token, archives, {
            ...requestOptions,
            timeoutMs: Math.min(requestOptions.timeoutMs, remainingMs),
            deadlineAtMs: deadline,
            signal,
          })
      );
      progressiveContent.set(key, request);
      void request.catch(() => {
        if (progressiveContent.get(key) === request) {
          progressiveContent.delete(key);
        }
      });
      return request;
    };
    const searched = await Promise.allSettled(
      queries.map((query) =>
        deepbridNetworkLimit(() =>
          searchDeepbridFinderPages(client, query, {
            category: categoryFor(media, metadata.isAnime),
            deadline,
            signal,
            onPage: canPrefetchProgressively
              ? async ({ results }) => {
                  const fresh = results.filter((result) => {
                    if (progressiveSeenTokens.has(result.token)) return false;
                    progressiveSeenTokens.add(result.token);
                    return true;
                  });
                  const pageCandidates = prioritizeDeepbridSeasonPacks(
                    fresh
                      .map((result) => ({
                        result,
                        ...rankResult(result, media, metadata),
                      }))
                      .filter((item) => item.confirmed && item.score > 0)
                      .sort(
                        (a, b) =>
                          b.score - a.score ||
                          b.result.sources - a.result.sources ||
                          b.result.size - a.result.size
                      ),
                    media,
                    0
                  );
                  if (pageCandidates.length > 0) {
                    const candidateOffset = earlyCandidateOffset;
                    earlyCandidateOffset += pageCandidates.length;
                    await earlyResolutionQueue.enqueue(
                      pageCandidates,
                      (batch) => resolveCandidates(batch, candidateOffset),
                      signal
                    );
                  }
                  for (const candidate of pageCandidates) {
                    if (signal?.aborted) break;
                    if (progressiveContent.size >= 128) break;
                    if (
                      remainingRequestBudget(deadline, Date.now) <
                      DEEPBRID_MIN_REQUEST_BUDGET_MS
                    )
                      break;
                    const seasonPack =
                      media.type === 'series' &&
                      media.season !== undefined &&
                      parseNewshostingRelease(candidate.result.title).season ===
                        media.season &&
                      parseNewshostingRelease(candidate.result.title)
                        .seasonPack === true;
                    const timeoutMs = remainingRequestBudget(
                      deadline,
                      Date.now
                    );
                    void getFinderContent(candidate.result.token, seasonPack, {
                      timeoutMs,
                      signal,
                    }).catch(() => {
                      // The final resolver records the failure in its normal
                      // accounting path; prefetch is deliberately best-effort.
                    });
                  }
                }
              : undefined,
            onOutcome: (outcome) => paginationOutcomes.push(outcome),
          })
        )
      )
    );
    const finderResults = searched.flatMap((entry) =>
      entry.status === 'fulfilled' ? entry.value : []
    );
    if (searched.every((entry) => entry.status === 'rejected')) {
      throw searched[0].reason;
    }
    const earlyResolution = canPrefetchProgressively
      ? await earlyResolutionQueue.drain()
      : { resolved: [], failures: [], failedBatchCount: 0 };
    if (earlyResolution.failures.length > 0) {
      this.logger.warn(
        {
          requestTraceId: this.requestTraceId,
          failedBatches: earlyResolution.failedBatchCount,
          failureClasses: earlyResolution.failures.map(
            classifyDeepbridResolutionFailure
          ),
        },
        'Deepbrid progressive resolution retained successful batches with partial failures'
      );
    }
    const earlyResolved = earlyResolution.resolved;
    const seen = new Set<string>();
    const ranked = finderResults
      .filter((item) => !seen.has(item.token) && seen.add(item.token))
      .map((result) => ({ result, ...rankResult(result, media, metadata) }))
      .filter((item) => item.confirmed && item.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.result.sources - a.result.sources ||
          b.result.size - a.result.size
      );
    const candidates = prioritizeDeepbridSeasonPacks(
      ranked,
      media,
      this.userData.maxContentResolves
    );
    const pagination = summarizeDeepbridPagination(paginationOutcomes);
    const failedSearches = searched.filter(
      (entry) => entry.status === 'rejected'
    ).length;
    const partialSearch =
      deepbridCoverageStatus({
        failedSearches,
        incompleteQueries: pagination.incompleteQueries,
      }) === 'partial';

    (partialSearch ? this.logger.warn : this.logger.info)(
      {
        type,
        queryCount: queries.length,
        successfulQueries: searched.filter(
          (entry) => entry.status === 'fulfilled'
        ).length,
        finderResults: finderResults.length,
        confirmedResults: ranked.length,
        contentCandidates: candidates.length,
        seasonPackCandidates: candidates.filter(
          (item) => parseNewshostingRelease(item.result.title).seasonPack
        ).length,
        pagesFetched: pagination.pagesFetched,
        paginationPageRetries: pagination.pageRetries,
        paginationIncompleteQueries: pagination.incompleteQueries,
        paginationTerminations: pagination.terminationCounts,
        status: partialSearch ? 'partial' : 'complete',
      },
      'Deepbrid Finder search completed'
    );

    // Older generated addon configs defaulted to three workers. Keep those
    // configs fast after an upgrade while retaining the hard safety cap.
    const resolved = canPrefetchProgressively
      ? earlyResolved.sort(
          (a, b) =>
            candidates.findIndex(
              (item) => item.result.token === a.result.token
            ) -
            candidates.findIndex((item) => item.result.token === b.result.token)
        )
      : await resolveCandidates(candidates);
    const resolutionCoverage = deepbridCoverageStatus({
      failedSearches,
      incompleteQueries: pagination.incompleteQueries,
      resolutionFailures:
        Number(resolutionHadFailures) + earlyResolution.failedBatchCount,
      aborted: Boolean(signal?.aborted),
    });
    const partialResolution = resolutionCoverage === 'partial';
    const finalSummary = {
      type,
      confirmedResults: ranked.length,
      resolvedFiles: resolved.length,
      searchFailures: failedSearches,
      failedProgressiveBatches: earlyResolution.failedBatchCount,
      status: resolutionCoverage,
      elapsedMs:
        this.userData.timeout -
        DEEPBRID_DEADLINE_MARGIN_MS -
        Math.max(0, deadline - Date.now()),
    };
    if (partialResolution) {
      this.logger.warn(
        finalSummary,
        'Deepbrid Finder resolution finished with partial coverage'
      );
    } else {
      this.logger.info(finalSummary, 'Deepbrid Finder resolution completed');
    }

    return toStreams(resolved, resolutionCoverage);
  }

  private async getBothDirectStreams(
    type: string,
    id: string,
    signal?: AbortSignal
  ): Promise<Stream[]> {
    const parsedId = IdParser.parse(id, type);
    if (!parsedId || !this.supportedIdTypes.includes(parsedId.type))
      throw new Error(`Unsupported ID: ${id}`);
    const { deadline, coverage } = await this.getBothFinderData(parsedId);
    await this.bothDirectProbeQueue?.drain(
      deadline,
      this.bothOnResolved !== undefined
    );
    if (signal?.aborted) return [];
    const finalCoverage = deepbridCoverageStatus({
      failedSearches: Number(coverage === 'partial'),
      resolutionFailures:
        this.bothProbeStats.errors + this.bothProbeStats.aborted,
      aborted: Boolean(signal?.aborted),
    });
    if (finalCoverage === 'partial' && coverage === 'complete') {
      this.logger.warn(
        {
          requestTraceId: this.requestTraceId,
          probeErrors: this.bothProbeStats.errors,
          probeAborted: this.bothProbeStats.aborted,
          status: finalCoverage,
          mode: 'both',
        },
        'Deepbrid both-mode playback probes finished with partial coverage'
      );
    }
    return this.bothProgressiveStreams.mergeFinal([], signal).map((stream) => ({
      ...stream,
      behaviorHints: {
        ...(stream.behaviorHints ?? {}),
        deepbridResolutionCoverage: finalCoverage,
      },
    }));
  }

  private closeBothDirectProbeQueue(): void {
    this.bothDirectProbeQueue?.close();
  }

  private async createBothDirectStreams(
    resolved: Awaited<ReturnType<typeof resolveDeepbridFiles>>,
    deadline: number,
    signal?: AbortSignal
  ): Promise<Stream[]> {
    const probeBatch = await filterDeepbridProbeResults(resolved, {
      concurrency: this.userData.resolveConcurrency,
      signal,
      probe: async (item) => {
        const extension =
          item.file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
        const cacheKey = deepbridProbeCacheKey(
          this.deepbridApiKey,
          item.file.link,
          extension
        );
        if (hasSuccessfulDeepbridProbe(cacheKey)) return true;
        if (isDeepbridProbeQuarantined(cacheKey)) return false;
        let probe = this.bothProbeCache.get(cacheKey);
        if (!probe) {
          probe = deepbridNetworkLimit(() =>
            runWithinDeepbridRequestBudget(
              deadline,
              Date.now,
              signal,
              (remainingMs) =>
                probeDeepbridVideo(item.file, this.deepbridApiKey, {
                  timeoutMs: Math.min(this.userData.timeout, remainingMs),
                  signal,
                })
            )
          ).then((playable) => {
            if (playable) rememberSuccessfulDeepbridProbe(cacheKey);
            else if (!signal?.aborted) rememberFailedDeepbridProbe(cacheKey);
            return playable;
          });
          this.bothProbeCache.set(cacheKey, probe);
        }
        if (!(await probe)) {
          return false;
        }
        return true;
      },
    });
    this.bothProbeStats.candidates += resolved.length;
    this.bothProbeStats.playable += probeBatch.playable.length;
    this.bothProbeStats.rejected += probeBatch.rejected;
    this.bothProbeStats.errors += probeBatch.errors;
    this.bothProbeStats.aborted += probeBatch.aborted;
    if (
      probeBatch.errors ||
      probeBatch.aborted ||
      (resolved.length > 0 && probeBatch.playable.length === 0)
    ) {
      this.logger.warn(
        {
          candidateCount: resolved.length,
          playableCount: probeBatch.playable.length,
          rejectedCount: probeBatch.rejected,
          probeErrors: probeBatch.errors,
          abortedCount: probeBatch.aborted,
        },
        'Deepbrid Finder direct playback probe batch completed with skipped candidates'
      );
    }

    return probeBatch.playable.flatMap((item) => {
      const target = validateDeepbridDownloadUrl(item.file.link);
      const deepbridSpecScore = scoreDeepbridSpec({
        titleMatchConfirmed: item.confirmed,
        containerProbePassed: true,
        result: item.result,
        file: item.file,
      });
      const details = formatDeepbridSpecEvidence(
        item.result,
        item.file,
        deepbridSpecScore,
        true
      );
      const playbackVariants = createDeepbridPlaybackVariants(
        {
          apiKey: this.deepbridApiKey,
          url: target.toString(),
          filename: item.file.name,
          size: item.file.size || undefined,
          finderToken: item.result.token,
          finderArchives: item.archiveExpanded,
        },
        this.userData.playbackMode
      );
      return playbackVariants.map(({ mode, label, url }) => {
        return {
          name: `[DB⚡] Deepbrid Usenet · ${label}`,
          title: item.result.title,
          description: [...details, `📺 ${label} · 🔍 Deepbrid Usenet`].join(
            '\n'
          ),
          url,
          type: 'usenet',
          idMatched: true,
          age: ageHours(item.result.date),
          behaviorHints: {
            notWebReady: false,
            filename: item.file.name,
            videoSize: item.file.size || item.result.size || undefined,
            bingeGroup: `deepbrid-usenet|${item.file.name.toLowerCase()}`,
            deepbridPlaybackMode: mode,
            deepbridSeasonPack:
              parseNewshostingRelease(item.result.title).seasonPack === true,
            deepbridReleaseTitle: item.result.title,
            deepbridReleaseSize: item.result.size || undefined,
            deepbridSpecScore,
            deepbridSpecSourceCount: item.result.sources,
            deepbridSpecTitleMatch: item.confirmed,
            deepbridSpecContainerProbePassed: true,
            deepbridSpecVersion: 1,
            deepbridMatchConfidence: item.confidence,
            deepbridMatchScore: item.score,
            deepbridMatchEvidence: item.matchReason,
            deepbridEvidenceVersion: 1,
            deepbridEvidence: {
              parsed: true,
              resolved: true,
              probed: true,
              playbackConfirmed: false,
            },
            deepbridNzbHash: item.file.nzbUrl
              ? hashNzbUrl(item.file.nzbUrl)
              : undefined,
            // Capability URLs are re-encrypted for each progressive/final
            // result. This keyed opaque identity preserves distinct validated
            // CDN files without exposing their signed source URLs.
            deepbridSourceIdentity: createHmac('sha256', this.deepbridApiKey)
              .update(item.file.link)
              .digest('hex'),
            deepbridArchiveExpanded: item.archiveExpanded,
            deepbridArchiveIntegrity: item.archiveIntegrity,
          },
        } satisfies Stream;
      });
    });
  }

  private getBothFinderData(parsedId: ParsedId): Promise<{
    resolved: Awaited<ReturnType<typeof resolveDeepbridFiles>>;
    deadline: number;
    coverage: 'partial' | 'complete';
  }> {
    if (this.bothFinderDataPromise) return this.bothFinderDataPromise;
    this.bothFinderDataPromise = (async () => {
      const deadline =
        Date.now() +
        Math.max(
          DEEPBRID_MIN_REQUEST_BUDGET_MS,
          deepbridResolutionTimeout(
            this.userData.timeout,
            Boolean(this.bothOnResolved)
          ) - DEEPBRID_DEADLINE_MARGIN_MS
        );
      const metadata = metadataForSearch(await this.getSearchMetadata());
      const media = mediaForSearch(parsedId);
      const queries = buildDeepbridQueries(metadata, media);
      if (!queries.length)
        return { resolved: [], deadline, coverage: 'complete' };
      const progressiveNotifier = this.bothOnResolved;
      const requestSignal = this.bothSignal;
      this.bothDirectProbeQueue = new ValidatedFinderResolutionQueue(
        this.bothProgressiveStreams,
        (files) => this.createBothDirectStreams(files, deadline, requestSignal),
        progressiveNotifier
          ? (streams, candidateIndex) =>
              progressiveNotifier(streams, candidateIndex)
          : undefined,
        (error, candidateIndex) =>
          this.logger.warn(
            {
              candidateIndex,
              failureClass: classifyDeepbridResolutionFailure(error),
            },
            'Deepbrid Finder early direct result task failed'
          ),
        requestSignal
      );
      const client = new DeepbridFinderClient(
        this.deepbridApiKey,
        this.userData.timeout
      );
      const paginationOutcomes: DeepbridFinderPaginationOutcome[] = [];
      const searched = await Promise.allSettled(
        queries.map((query) =>
          deepbridNetworkLimit(() =>
            searchDeepbridFinderPages(client, query, {
              category: categoryFor(media, metadata.isAnime),
              deadline,
              signal: this.bothSignal,
              onOutcome: (outcome) => paginationOutcomes.push(outcome),
            })
          )
        )
      );
      const finderResults = searched.flatMap((entry) =>
        entry.status === 'fulfilled' ? entry.value : []
      );
      if (searched.every((entry) => entry.status === 'rejected')) {
        throw searched[0].reason;
      }
      const failedSearches = searched.filter(
        (entry) => entry.status === 'rejected'
      ).length;
      const seen = new Set<string>();
      const ranked = finderResults
        .filter((item) => !seen.has(item.token) && seen.add(item.token))
        .map((result) => ({ result, ...rankResult(result, media, metadata) }))
        .filter((item) => item.confirmed && item.score > 0)
        .sort(
          (a, b) =>
            b.score - a.score ||
            b.result.sources - a.result.sources ||
            b.result.size - a.result.size
        );
      const candidates = prioritizeDeepbridSeasonPacks(
        ranked,
        media,
        this.userData.maxContentResolves
      );
      const pagination = summarizeDeepbridPagination(paginationOutcomes);
      const partialSearch =
        deepbridCoverageStatus({
          failedSearches,
          incompleteQueries: pagination.incompleteQueries,
        }) === 'partial';
      (partialSearch ? this.logger.warn : this.logger.info)(
        {
          requestTraceId: this.requestTraceId,
          type: parsedId.type,
          queryCount: queries.length,
          finderResults: finderResults.length,
          finderResultsWithNzbUrl: finderResults.filter((result) =>
            Boolean(result.nzbUrl)
          ).length,
          confirmedResults: ranked.length,
          contentCandidates: candidates.length,
          pagesFetched: pagination.pagesFetched,
          paginationPageRetries: pagination.pageRetries,
          paginationIncompleteQueries: pagination.incompleteQueries,
          paginationTerminations: pagination.terminationCounts,
          failedSearches,
          status: partialSearch ? 'partial' : 'complete',
          mode: 'both',
        },
        'Deepbrid Finder both-mode search completed'
      );
      let resolutionHadFailures = false;
      const resolved = await resolveDeepbridFiles(candidates, media, {
        concurrency: Math.max(
          1,
          Math.min(
            10,
            progressiveNotifier
              ? this.userData.progressiveResolveConcurrency
              : this.userData.resolveConcurrency
          )
        ),
        maxResults: this.userData.maxResults,
        deadline,
        requireCompleteResolution:
          Boolean(progressiveNotifier) && this.userData.maxResults === 0,
        signal: this.bothSignal,
        getContent: (token, archives, requestOptions) =>
          runQueuedDeepbridRequest(
            deadline,
            Date.now,
            requestOptions.signal,
            deepbridNetworkLimit,
            (remainingMs) =>
              client.getContent(token, archives, {
                ...requestOptions,
                timeoutMs: Math.min(requestOptions.timeoutMs, remainingMs),
                deadlineAtMs: deadline,
              })
          ),
        // Finder NZBs must reach other services even if their direct media
        // endpoint is unavailable; direct playback is separately probed.
        probeFile: () => Promise.resolve(true),
        probeFileValidatesContainer: false,
        // Probe direct playback as candidates resolve, but don't block the
        // Finder content workers: the external NZB branch must still receive
        // results when direct validation is slow or unavailable.
        onResolved: this.bothDirectProbeQueue.schedule,
        onSummary: (summary) => {
          if (
            summary.resolutionFailures > 0 ||
            summary.stopReason !== 'complete'
          ) {
            resolutionHadFailures = true;
          }
          const accounting = {
            requestTraceId: this.requestTraceId,
            ...summary,
            api: client.getRequestMetrics(),
          };
          if (summary.stopReason === 'complete') {
            this.logger.info(
              accounting,
              'Deepbrid Finder content resolution accounting'
            );
          } else {
            this.logger.warn(
              accounting,
              'Deepbrid Finder content resolution incomplete'
            );
          }
        },
      });
      const coverage = deepbridCoverageStatus({
        failedSearches,
        incompleteQueries: pagination.incompleteQueries,
        resolutionFailures: Number(resolutionHadFailures),
        aborted: Boolean(this.bothSignal?.aborted),
      });
      if (coverage === 'partial') {
        this.logger.warn(
          {
            requestTraceId: this.requestTraceId,
            resolvedFiles: resolved.length,
            failedSearches,
            paginationIncompleteQueries: pagination.incompleteQueries,
            resolutionHadFailures,
            status: coverage,
            mode: 'both',
          },
          'Deepbrid Finder both-mode resolution finished with partial coverage'
        );
      }
      return { resolved, deadline, coverage };
    })();
    return this.bothFinderDataPromise;
  }

  protected async _searchTorrents(_parsedId: ParsedId): Promise<Torrent[]> {
    return [];
  }

  protected async _searchNzbs(parsedId: ParsedId): Promise<NZB[]> {
    if (this.userData.mode === 'both') {
      const { resolved, coverage } = await this.getBothFinderData(parsedId);
      const nzbs = resolved.flatMap(({ result, file }) => {
        if (!file.nzbUrl) return [];
        return [
          {
            type: 'usenet' as const,
            hash: hashNzbUrl(file.nzbUrl),
            title: result.title,
            size: file.size,
            nzb: file.nzbUrl,
            indexer: constants.DEEPBRID_SERVICE,
            confirmed: true,
            age: ageHours(result.date),
          },
        ];
      });
      this.logger.info(
        {
          requestTraceId: this.requestTraceId,
          finderResolvedFiles: resolved.length,
          finderFilesWithNzb: nzbs.length,
          status: coverage,
        },
        'Deepbrid Finder NZBs prepared for external Usenet services'
      );
      return nzbs;
    }
    if (this.userData.mode !== 'indexer') return [];

    const deadline =
      Date.now() +
      Math.max(
        DEEPBRID_MIN_REQUEST_BUDGET_MS,
        this.userData.timeout - DEEPBRID_DEADLINE_MARGIN_MS
      );
    const metadata = metadataForSearch(await this.getSearchMetadata());
    const media = mediaForSearch(parsedId);
    const queries = buildDeepbridQueries(metadata, media);
    if (!queries.length) return [];

    const client = new DeepbridFinderClient(
      this.deepbridApiKey,
      this.userData.timeout
    );
    const searchTimeout = remainingRequestBudget(deadline, Date.now);
    if (searchTimeout < DEEPBRID_MIN_REQUEST_BUDGET_MS) return [];
    const paginationOutcomes: DeepbridFinderPaginationOutcome[] = [];
    const searched = await Promise.allSettled(
      queries.map((query) =>
        deepbridNetworkLimit(() =>
          searchDeepbridFinderPages(client, query, {
            category: categoryFor(media, metadata.isAnime),
            deadline,
            onOutcome: (outcome) => paginationOutcomes.push(outcome),
          })
        )
      )
    );
    const finderResults = searched.flatMap((entry) =>
      entry.status === 'fulfilled' ? entry.value : []
    );
    if (searched.every((entry) => entry.status === 'rejected')) {
      throw searched[0].reason;
    }
    const failedSearches = searched.filter(
      (entry) => entry.status === 'rejected'
    ).length;
    const seen = new Set<string>();
    const ranked = finderResults
      .filter((item) => !seen.has(item.token) && seen.add(item.token))
      .map((result) => ({ result, ...rankResult(result, media, metadata) }))
      .filter((item) => item.confirmed && item.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.result.sources - a.result.sources ||
          b.result.size - a.result.size
      );
    const candidates = prioritizeDeepbridSeasonPacks(
      ranked,
      media,
      this.userData.maxContentResolves
    );
    const pagination = summarizeDeepbridPagination(paginationOutcomes);
    const partialSearch =
      deepbridCoverageStatus({
        failedSearches,
        incompleteQueries: pagination.incompleteQueries,
      }) === 'partial';

    (partialSearch ? this.logger.warn : this.logger.info)(
      {
        type: parsedId.type,
        queryCount: queries.length,
        successfulQueries: searched.filter(
          (entry) => entry.status === 'fulfilled'
        ).length,
        finderResults: finderResults.length,
        confirmedResults: ranked.length,
        contentCandidates: candidates.length,
        pagesFetched: pagination.pagesFetched,
        paginationPageRetries: pagination.pageRetries,
        paginationIncompleteQueries: pagination.incompleteQueries,
        paginationTerminations: pagination.terminationCounts,
        failedSearches,
        status: partialSearch ? 'partial' : 'complete',
      },
      'Deepbrid Finder indexer search completed'
    );

    const resolveConcurrency = Math.max(
      1,
      Math.min(10, this.userData.resolveConcurrency)
    );
    let resolutionHadFailures = false;
    const resolved = await resolveDeepbridFiles(candidates, media, {
      concurrency: resolveConcurrency,
      maxResults: this.userData.maxResults,
      deadline,
      getContent: (token, archives, requestOptions) =>
        runQueuedDeepbridRequest(
          deadline,
          Date.now,
          requestOptions.signal,
          deepbridNetworkLimit,
          (remainingMs) =>
            client.getContent(token, archives, {
              ...requestOptions,
              timeoutMs: Math.min(requestOptions.timeoutMs, remainingMs),
              deadlineAtMs: deadline,
            })
        ),
      // Indexer mode does NOT preflight actual video streams. We just want the NZBs.
      probeFile: () => Promise.resolve(true),
      onSummary: (summary) => {
        if (
          summary.resolutionFailures > 0 ||
          summary.stopReason !== 'complete'
        ) {
          resolutionHadFailures = true;
        }
      },
    });

    const indexedNzbs: NZB[] = [];
    for (const { result, file } of resolved) {
      if (!file.nzbUrl) continue;
      indexedNzbs.push({
        type: 'usenet',
        hash: hashNzbUrl(file.nzbUrl),
        title: result.title,
        size: file.size,
        nzb: file.nzbUrl,
        // This stable service id is also the loop-prevention marker used by
        // processNZBs when Deepbrid is configured as an external resolver.
        indexer: constants.DEEPBRID_SERVICE,
        confirmed: true,
        age: ageHours(result.date),
      });
    }
    const coverage = deepbridCoverageStatus({
      failedSearches,
      incompleteQueries: pagination.incompleteQueries,
      resolutionFailures: Number(resolutionHadFailures),
    });
    if (coverage === 'partial') {
      this.logger.warn(
        {
          requestTraceId: this.requestTraceId,
          resolvedFiles: resolved.length,
          indexedNzbs: indexedNzbs.length,
          failedSearches,
          paginationIncompleteQueries: pagination.incompleteQueries,
          resolutionHadFailures,
          status: coverage,
          mode: 'indexer',
        },
        'Deepbrid Finder indexer resolution finished with partial coverage'
      );
    }
    return indexedNzbs;
  }
}
