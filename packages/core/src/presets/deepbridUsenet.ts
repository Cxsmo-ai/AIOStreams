import { Addon, Option, ParsedStream, Stream, UserData } from '../db/index.js';
import { config as appConfig } from '../config/index.js';
import { constants, encryptString } from '../utils/index.js';
import type { ServiceId } from '../utils/constants.js';
import { DeepbridUsenetConfigSchema } from '../builtins/deepbrid-usenet/index.js';
import { BuiltinAddonPreset, BuiltinStreamParser } from './builtin.js';
import { withInternalTimeoutMargin } from './timeout.js';

type DeepbridUsenetFormattingOptions = {
  useAioFormatter?: boolean;
};

export const DEEPBRID_USENET_FORMATTING_OPTION: Option = {
  id: 'formatting',
  name: 'Formatting Compatibility',
  description:
    'Choose whether Deepbrid Usenet results use your normal AIOStreams formatting.',
  type: 'subsection',
  subsectionIntent: 'pill',
  subOptions: [
    {
      id: 'useAioFormatter',
      name: 'Use AIOStreams Formatter',
      description:
        'Apply your normal AIOStreams formatter to playable Deepbrid Usenet sources.',
      type: 'boolean',
      default: true,
    },
  ],
};

export function deepbridUsenetFormatPassthrough(
  options: DeepbridUsenetFormattingOptions | undefined
): boolean {
  return options?.useAioFormatter === false;
}

export class DeepbridUsenetStreamParser extends BuiltinStreamParser {
  private isDirectFinderStream(stream: Stream): boolean {
    // Direct Finder streams are emitted by DeepbridUsenetAddon itself as
    // [DB⚡]/[DB] entries. Service-routed indexer-mode streams use the normal
    // BuiltinAddonPreset [DB ⚡] shape and must retain their service metadata.
    return /^\[DB(?:⚡|\])/.test(stream.name || '');
  }

  protected override getIndexer(
    stream?: Stream,
    currentParsedStream?: ParsedStream
  ): string | undefined {
    return !stream || this.isDirectFinderStream(stream)
      ? 'Deepbrid Usenet'
      : super.getIndexer(stream, currentParsedStream!);
  }

  protected override getService(
    stream: Stream,
    currentParsedStream: ParsedStream
  ): ParsedStream['service'] | undefined {
    // Finder streams already have a secure, playable Deepbrid URL; this marks
    // their resolved state for sorting/display without invoking another resolver.
    if (this.isDirectFinderStream(stream)) {
      return { id: constants.DEEPBRID_SERVICE, cached: true };
    }
    if (/^\[DB\s+⚡\]/.test(stream.name || '')) {
      return { id: constants.DEEPBRID_SERVICE, cached: true };
    }
    return super.getService(stream, currentParsedStream);
  }

  protected override getExtras(
    stream: Stream,
    currentParsedStream: ParsedStream
  ): ParsedStream['extra'] {
    const hints = stream.behaviorHints as
      | (Record<string, unknown> & {
          deepbridSpecScore?: unknown;
          deepbridSpecSourceCount?: unknown;
          deepbridSpecTitleMatch?: unknown;
          deepbridSpecContainerProbePassed?: unknown;
          deepbridSpecVersion?: unknown;
          deepbridMatchConfidence?: unknown;
          deepbridMatchScore?: unknown;
          deepbridMatchEvidence?: unknown;
          deepbridEvidenceVersion?: unknown;
          deepbridEvidence?: unknown;
        })
      | undefined;
    const baseExtras = super.getExtras(stream, currentParsedStream);
    const inheritedSuffix = Array.isArray(baseExtras?.formattingSuffix)
      ? baseExtras.formattingSuffix.filter(
          (value): value is string => typeof value === 'string'
        )
      : [];
    const rawScore = hints?.deepbridSpecScore;
    if (
      hints?.deepbridSpecVersion !== 1 ||
      typeof rawScore !== 'number' ||
      !Number.isFinite(rawScore) ||
      rawScore < 0 ||
      rawScore > 100
    ) {
      return baseExtras;
    }

    const score = Math.round(rawScore);
    const rawSourceCount = Number(hints?.deepbridSpecSourceCount);
    const sourceCount = Number.isFinite(rawSourceCount)
      ? Math.max(0, Math.floor(rawSourceCount))
      : undefined;
    const evidence: string[] = [];
    if (hints?.deepbridSpecTitleMatch === true) evidence.push('title match');
    if (hints?.deepbridSpecContainerProbePassed === true)
      evidence.push('range/container probe passed');
    if (sourceCount !== undefined && sourceCount > 0)
      evidence.push(`Finder sources: ${sourceCount}`);

    const rawMatchScore = Number(hints?.deepbridMatchScore);
    const matchScore = Number.isFinite(rawMatchScore)
      ? Math.max(0, Math.min(10_000, Math.round(rawMatchScore)))
      : undefined;
    const confidence =
      hints?.deepbridMatchConfidence === 'high' ||
      hints?.deepbridMatchConfidence === 'medium' ||
      hints?.deepbridMatchConfidence === 'low'
        ? hints.deepbridMatchConfidence
        : undefined;
    const rawEvidence =
      hints?.deepbridEvidence && typeof hints.deepbridEvidence === 'object'
        ? (hints.deepbridEvidence as Record<string, unknown>)
        : undefined;
    const pipelineEvidence =
      hints?.deepbridEvidenceVersion === 1 && rawEvidence
        ? {
            parsed: rawEvidence.parsed === true,
            resolved: rawEvidence.resolved === true,
            probed: rawEvidence.probed === true,
            playbackConfirmed: rawEvidence.playbackConfirmed === true,
          }
        : undefined;
    const matchReason =
      typeof hints?.deepbridMatchEvidence === 'string'
        ? hints.deepbridMatchEvidence.slice(0, 240)
        : undefined;

    return {
      ...(baseExtras || {}),
      deepbridSpec: {
        score,
        sourceCount,
        titleMatch: hints?.deepbridSpecTitleMatch === true,
        containerProbePassed: hints?.deepbridSpecContainerProbePassed === true,
        technicalEvidence: 'filename-inferred',
        scoreVersion: hints?.deepbridSpecVersion === 1 ? 1 : undefined,
        rating: 'aiostreams-estimate',
      },
      deepbridMatch:
        confidence || matchScore !== undefined || matchReason
          ? { confidence, score: matchScore, reason: matchReason }
          : undefined,
      deepbridEvidence: pipelineEvidence,
      formattingSuffix: [
        ...inheritedSuffix,
        `✦ DeepSpec ${score}/100 · AIOStreams estimate`,
        evidence.length ? `🔎 ${evidence.join(' · ')}` : undefined,
        confidence
          ? `🎯 Filename/title match estimate: ${confidence}`
          : undefined,
        pipelineEvidence
          ? `✅ Parsed${pipelineEvidence.resolved ? ' · Resolved' : ''}${pipelineEvidence.probed ? ' · Probed' : ''}${pipelineEvidence.playbackConfirmed ? ' · Playback confirmed' : ' · Playback unverified'}`
          : undefined,
      ].filter((value): value is string => Boolean(value)),
    };
  }
}

export class DeepbridUsenetPreset extends BuiltinAddonPreset {
  static override getParser() {
    return DeepbridUsenetStreamParser;
  }

  static override get METADATA() {
    const options: Option[] = [
      {
        id: 'name',
        name: 'Name',
        description: 'What to call this addon.',
        type: 'string',
        required: true,
        default: 'Deepbrid Usenet',
      },
      {
        id: 'deepbridService',
        name: 'Deepbrid Service Credential',
        description:
          'This addon uses the API key configured once under Services > Deepbrid.',
        type: 'alert',
        intent: 'info',
        required: false,
      },
      {
        id: 'mode',
        name: 'Deepbrid Mode',
        description:
          'Direct keeps playable Deepbrid Finder results. Indexer passes Finder NZB files through selected Usenet services when the Finder API provides NZB URLs. Both keeps Finder playback and enables that optional handoff; other configured indexer addons continue through their own service routing.',
        type: 'select',
        default: 'direct',
        options: [
          { label: 'Direct Resolve', value: 'direct' },
          { label: 'Indexer Only', value: 'indexer' },
          { label: 'Both (Finder + External Usenet)', value: 'both' },
        ],
      },
      {
        id: 'playbackMode',
        name: 'Deepbrid Player Delivery',
        description:
          'Choose the player transport independently from Finder routing. Native uses the existing authenticated byte-range proxy; Remux and HLS use Deepbrid player endpoints. All exposes three labeled choices per Finder result.',
        type: 'select',
        default: 'direct',
        options: [
          { label: 'Native / Direct', value: 'direct' },
          { label: 'Remux', value: 'remux' },
          { label: 'HLS', value: 'hls' },
          { label: 'Show all three', value: 'all' },
        ],
      },
      {
        id: 'convertSubtitlesToWebVtt',
        name: 'Convert Deepbrid Player Subtitles to WebVTT',
        description:
          'Optional Deepbrid player conversion for ASS/SSA/SUB tracks from other subtitle addons. OpenSubtitles and Deepbrid OpenSubtitles are not changed; SRT and WebVTT remain as-is.',
        type: 'boolean',
        default: false,
      },
      {
        id: 'resolveExternalIndexers',
        name: 'Resolve External Indexers with Deepbrid',
        description:
          'Enable Deepbrid for NZBs supplied to this addon pipeline. For other indexer addons, select Deepbrid under each addon’s Usenet services. Finder results are direct playable files; the current Finder API does not provide an NZB URL to send to another service.',
        type: 'boolean',
        default: false,
      },
      {
        id: 'timeout',
        name: 'Timeout (ms)',
        description: 'Total timeout for Deepbrid Finder API operations.',
        type: 'number',
        default: 30_000,
        constraints: {
          min: appConfig.userLimits.timeouts.minTimeout,
          max: Math.min(120_000, appConfig.userLimits.timeouts.maxTimeout),
          forceInUi: false,
        },
      },
      {
        id: 'maxResults',
        name: 'Maximum Results',
        description:
          'Maximum resolved Deepbrid streams per title; set to 0 for unlimited.',
        type: 'number',
        default: 0,
        constraints: { min: 0, max: 50, forceInUi: false },
      },
      {
        id: 'maxContentResolves',
        name: 'Maximum Content Resolves',
        description:
          'Maximum matched Finder releases to resolve; 0 is unlimited. API deadlines and concurrency remain bounded.',
        type: 'number',
        default: 0,
        showInSimpleMode: false,
        constraints: { min: 0, max: 30, forceInUi: false },
      },
      {
        id: 'resolveConcurrency',
        name: 'Resolve Concurrency',
        description:
          'How many Deepbrid content requests may run at once for standard requests.',
        type: 'number',
        default: 5,
        showInSimpleMode: false,
        constraints: { min: 1, max: 10, forceInUi: false },
      },
      {
        id: 'progressiveResolveConcurrency',
        name: 'Progressive Resolve Concurrency',
        description:
          'How many Finder content requests progressive requests may run at once. Higher values can resolve more candidates before the progressive deadline; the global Deepbrid network limit still caps active requests at 10.',
        type: 'number',
        default: 10,
        showInSimpleMode: false,
        constraints: { min: 1, max: 10, forceInUi: false },
      },
      DEEPBRID_USENET_FORMATTING_OPTION,
      {
        id: 'mediaTypes',
        name: 'Media Types',
        description: 'Leave empty for movies, series, and anime.',
        type: 'multi-select',
        required: false,
        showInSimpleMode: false,
        default: [],
        options: [
          { label: 'Movie', value: 'movie' },
          { label: 'Series', value: 'series' },
          { label: 'Anime', value: 'anime' },
        ],
      },
      {
        id: 'pinPosition',
        name: 'Pin Position',
        description:
          'Optionally pin Deepbrid Usenet results in the final list.',
        type: 'select',
        required: false,
        showInSimpleMode: false,
        options: [
          { label: 'None', value: undefined },
          { label: 'Top', value: 'top' },
          { label: 'Bottom', value: 'bottom' },
        ],
      },
      {
        id: 'resultPassthrough',
        name: 'Always Keep Results',
        description:
          'Prevent Deepbrid Usenet results from being removed by final filtering, deduplication, or result limits.',
        type: 'boolean',
        required: false,
        default: false,
        showInSimpleMode: false,
      },
    ];

    return {
      ID: 'deepbrid-usenet',
      NAME: 'Deepbrid Usenet',
      LOGO: '',
      URL: [`${appConfig.bootstrap.internalUrl}/builtins/deepbrid-usenet`],
      TIMEOUT: appConfig.presets.defaultTimeout,
      USER_AGENT: appConfig.http.defaultUserAgent,
      SUPPORTED_SERVICES: [
        constants.AIOSTREAMS_SERVICE,
        constants.STREMIO_NNTP_SERVICE,
        constants.ALTMOUNT_SERVICE,
        constants.NZBDAV_SERVICE,
        constants.TORBOX_SERVICE,
        constants.STREMTHRU_NEWZ_SERVICE,
        constants.EASYNEWS_SERVICE,
        constants.DEEPBRID_SERVICE,
      ],
      DESCRIPTION:
        'Search Deepbrid Usenet Finder and securely stream resolved video files through AIOStreams with HTTP Range support.',
      OPTIONS: options,
      SUPPORTED_STREAM_TYPES: [constants.USENET_STREAM_TYPE],
      SUPPORTED_RESOURCES: [constants.STREAM_RESOURCE],
      BUILTIN: true,
    };
  }

  static async generateAddons(
    userData: UserData,
    options: Record<string, any>
  ): Promise<Addon[]> {
    const mode = options.mode ?? 'direct';
    const resolveExternalIndexers = options.resolveExternalIndexers === true;
    const deepbridService = userData.services?.find(
      (service) =>
        service.id === constants.DEEPBRID_SERVICE && service.enabled !== false
    );
    const apiKey = deepbridService?.credentials?.apiKey?.trim();
    if (!apiKey) {
      throw new Error(
        'Configure the Deepbrid API key once under Services > Deepbrid before installing Deepbrid Usenet.'
      );
    }
    const serviceIds = deepbridUsenetServiceIds(
      userData.services ?? [],
      resolveExternalIndexers
    );
    const formatting = (options.formatting ||
      {}) as DeepbridUsenetFormattingOptions;
    const config = DeepbridUsenetConfigSchema.parse({
      ...this.getBaseConfig(userData, serviceIds),
      apiKey,
      mode,
      playbackMode: options.playbackMode ?? 'direct',
      convertSubtitlesToWebVtt: options.convertSubtitlesToWebVtt === true,
      resolveExternalIndexers,
      maxResults: options.maxResults ?? 0,
      maxContentResolves: options.maxContentResolves ?? 0,
      resolveConcurrency: options.resolveConcurrency ?? 5,
      timeout: options.timeout ?? 30_000,
    });
    const encrypted = encryptString(JSON.stringify(config));
    if (!encrypted.success || !encrypted.data) {
      throw new Error('Failed to encrypt the Deepbrid Usenet configuration.');
    }
    return [
      {
        name: options.name || this.METADATA.NAME,
        manifestUrl: `${this.DEFAULT_URL}/${encrypted.data}/manifest.json`,
        identifier: 'deepbrid-usenet',
        displayIdentifier: 'DB',
        enabled: true,
        resources: options.resources || undefined,
        mediaTypes: options.mediaTypes || [],
        timeout: withInternalTimeoutMargin(options.timeout, config.timeout),
        preset: { id: '', type: this.METADATA.ID, options },
        formatPassthrough: deepbridUsenetFormatPassthrough(formatting),
        resultPassthrough: options.resultPassthrough ?? false,
        pinPosition: options.pinPosition || undefined,
        headers: { 'User-Agent': this.METADATA.USER_AGENT },
      },
    ];
  }
}

/** Keep Deepbrid available for unrelated external NZBs only when explicitly
 * enabled; Finder NZBs are already Deepbrid-owned and must not be resubmitted. */
export function deepbridUsenetServiceIds(
  services: Array<{ id: ServiceId; enabled?: boolean }>,
  resolveExternalIndexers: boolean
): ServiceId[] {
  return services
    .filter((service) => service.enabled !== false)
    .map((service) => service.id)
    .filter(
      (id) => id !== constants.DEEPBRID_SERVICE || resolveExternalIndexers
    );
}
