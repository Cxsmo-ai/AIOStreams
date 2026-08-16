import { Addon, Option, ParsedStream, Stream, UserData } from '../db/index.js';
import { config as appConfig } from '../config/index.js';
import { constants, encryptString } from '../utils/index.js';
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
    // Direct Finder streams have their own secure playback URL and no service
    // wrapper. Indexer-mode streams are produced by BaseDebridAddon and must
    // keep the selected AIOStreams/Deepbrid service for playback and labels.
    if (this.isDirectFinderStream(stream)) return undefined;
    if (/^\[DB\s+⚡\]/.test(stream.name || '')) {
      return { id: constants.DEEPBRID_SERVICE, cached: true };
    }
    return super.getService(stream, currentParsedStream);
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
          'Direct mode resolves Finder results through Deepbrid. Indexer mode exposes Finder NZBs to your selected Usenet services and disables Deepbrid direct resolution.',
        type: 'select',
        default: 'direct',
        options: [
          { label: 'Direct Resolve', value: 'direct' },
          { label: 'Indexer Only', value: 'indexer' },
        ],
      },
      {
        id: 'resolveExternalIndexers',
        name: 'Resolve External Indexers with Deepbrid',
        description:
          'Enable the Deepbrid service for NZBs in this addon pipeline. For other indexer addons, also select Deepbrid under that addon’s Usenet services. Finder NZBs are never submitted back to Deepbrid.',
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
          'Maximum resolved Deepbrid video streams returned per title.',
        type: 'number',
        default: 20,
        constraints: { min: 1, max: 50, forceInUi: false },
      },
      {
        id: 'maxContentResolves',
        name: 'Maximum Content Resolves',
        description:
          'Maximum matched Finder releases whose file lists AIOStreams resolves. Lower values reduce API traffic.',
        type: 'number',
        default: 15,
        showInSimpleMode: false,
        constraints: { min: 1, max: 30, forceInUi: false },
      },
      {
        id: 'resolveConcurrency',
        name: 'Resolve Concurrency',
        description: 'How many Deepbrid content requests may run at once.',
        type: 'number',
        default: 5,
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
    const serviceIds =
      userData.services
        ?.filter((s) => s.enabled !== false)
        .map((s) => s.id)
        .filter(
          (id) =>
            id !== constants.DEEPBRID_SERVICE ||
            resolveExternalIndexers
        ) || [];
    const formatting = (options.formatting ||
      {}) as DeepbridUsenetFormattingOptions;
    const config = DeepbridUsenetConfigSchema.parse({
      services: serviceIds,
      tmdbApiKey: userData.tmdbApiKey,
      tmdbReadAccessToken: userData.tmdbAccessToken,
      tvdbApiKey: userData.tvdbApiKey,
      apiKey,
      mode,
      resolveExternalIndexers,
      maxResults: options.maxResults ?? 20,
      maxContentResolves: options.maxContentResolves ?? 15,
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
