import { Addon, Option, Stream, UserData } from '../db/index.js';
import { Preset, baseOptions } from './preset.js';
import { withInternalTimeoutMargin } from './timeout.js';
import {
  Env,
  appConfig,
  RESOURCES,
  ServiceId,
  constants,
  createLogger,
} from '../utils/index.js';
import { StremThruPreset } from './stremthru.js';
import { BuiltinAddonPreset } from './builtin.js';
import { HarbrrAddon } from '../builtins/index.js';

export class HarbrrPreset extends BuiltinAddonPreset {
  static override get METADATA() {
    const supportedResources = [constants.STREAM_RESOURCE];
    const supportedServices: ServiceId[] = [
      ...StremThruPreset.supportedServices,
      constants.NZBDAV_SERVICE,
      constants.ALTMOUNT_SERVICE,
      constants.STREMIO_NNTP_SERVICE,
      constants.STREMTHRU_NEWZ_SERVICE,
      constants.AIOSTREAMS_SERVICE,
      constants.DEEPBRID_SERVICE,
    ];
    let hasPreconfigured = false;
    let defaultTimeout = 7000;
    let searchTimeout = 30000;
    let internalUrl = 'http://localhost:3000';
    let userAgent = 'AIOStreams';
    try {
      hasPreconfigured = Boolean(appConfig.builtins.harbrr?.url && appConfig.builtins.harbrr?.apiKey);
      defaultTimeout = appConfig.presets?.defaultTimeout ?? 7000;
      searchTimeout = appConfig.builtins.harbrr?.searchTimeout ?? 30000;
      internalUrl = appConfig.bootstrap?.internalUrl ?? 'http://localhost:3000';
      userAgent = appConfig.http?.defaultUserAgent ?? 'AIOStreams';
    } catch {
      hasPreconfigured = false;
    }
    const options: Option[] = [
      ...(hasPreconfigured
        ? [
            {
              id: 'notRequiredNote',
              name: '',
              description:
                'This instance has a preconfigured Harbrr instance. You do not need to set the Harbrr URL and API Key below.',
              type: 'alert',
              intent: 'info',
              showInSimpleMode: false,
            } as const,
          ]
        : []),
      {
        id: 'name',
        name: 'Name',
        description: 'What to call this addon',
        type: 'string',
        required: true,
        default: 'Harbrr',
      },
      {
        id: 'timeout',
        name: 'Timeout (ms)',
        description: 'The timeout for this addon',
        type: 'number',
        default: defaultTimeout,
        constraints: {
          min: appConfig.userLimits.timeouts.minTimeout,
          max: appConfig.userLimits.timeouts.maxTimeout,
          forceInUi: false,
        },
      },
      {
        id: 'harbrrUrl',
        name: 'Harbrr URL',
        description: 'The URL of the Harbrr instance',
        type: 'url',
        required:
          !hasPreconfigured,
        showInSimpleMode:
          hasPreconfigured
            ? false
            : undefined,
      },
      {
        id: 'harbrrApiKey',
        name: 'Harbrr API Key',
        description: 'The API key for the Harbrr instance',
        type: 'password',
        required:
          !hasPreconfigured,
        showInSimpleMode:
          hasPreconfigured
            ? false
            : undefined,
      },
      ...(HarbrrAddon.preconfiguredIndexers
        ? [
            {
              id: 'indexers',
              name: 'Indexers',
              description:
                'If using the preconfigured instance, select the indexers to use here.',
              type: 'multi-select',
              options: HarbrrAddon.preconfiguredIndexers.map((indexer) => ({
                label: indexer.name,
                value: indexer.slug,
              })),
              default: HarbrrAddon.preconfiguredIndexers.map(
                (indexer) => indexer.slug
              ),
            } as const,
          ]
        : [
            {
              id: 'indexers',
              name: 'Indexers',
              description:
                'Optionally define a comma separated list of indexers (slugs or names) to use.',
              type: 'string',
              default: '',
            } as const,
          ]),
      {
        id: 'sources',
        name: 'Sources',
        description:
          'The sources to use when fetching from Harbrr. If not specified, both torrent and usenet indexers will be used, if available.',
        type: 'multi-select',
        required: false,
        showInSimpleMode: false,
        options: [
          {
            label: 'Torrent',
            value: 'torrent',
          },
          {
            label: 'Usenet',
            value: 'usenet',
          },
        ],
      },
      {
        id: 'mediaTypes',
        name: 'Media Types',
        description:
          'Limits this addon to the selected media types for streams. For example, selecting "Movie" means this addon will only be used for movie streams (if the addon supports them). Leave empty to allow all.',
        type: 'multi-select',
        required: false,
        showInSimpleMode: false,
        default: [],
        options: [
          {
            label: 'Movie',
            value: 'movie',
          },
          {
            label: 'Series',
            value: 'series',
          },
          {
            label: 'Anime',
            value: 'anime',
          },
        ],
      },
      {
        id: 'services',
        name: 'Services',
        description:
          'Optionally override the services that are used. If not specified, then the services that are enabled and supported will be used.',
        type: 'multi-select',
        required: false,
        showInSimpleMode: false,
        options: supportedServices.map((service) => ({
          value: service,
          label: constants.SERVICE_DETAILS[service].name,
        })),
        default: undefined,
        emptyIsUndefined: true,
      },
      {
        id: 'useMultipleInstances',
        name: 'Use Multiple Instances',
        description:
          'Harbrr supports multiple services in one instance of the addon - which is used by default. If this is enabled, then the addon will be created for each service.',
        type: 'boolean',
        default: false,
        showInSimpleMode: false,
      },
    ];

    return {
      ID: 'harbrr',
      NAME: 'Harbrr',
      LOGO: 'https://raw.githubusercontent.com/autobrr/harbrr/refs/heads/main/web/public/favicon.ico',
      URL: [`${internalUrl}/builtins/harbrr`],
      TIMEOUT: defaultTimeout,
      USER_AGENT: userAgent,
      SUPPORTED_SERVICES: supportedServices,
      DESCRIPTION:
        'An addon to get torrent and usenet results from a Harbrr instance via services.',
      OPTIONS: options,
      SUPPORTED_STREAM_TYPES: [
        constants.DEBRID_STREAM_TYPE,
        constants.USENET_STREAM_TYPE,
      ],
      SUPPORTED_RESOURCES: supportedResources,
      BUILTIN: true,
    };
  }

  static async generateAddons(
    userData: UserData,
    options: Record<string, any>
  ): Promise<Addon[]> {
    const usableServices = this.getUsableServices(
      userData,
      options.services,
      options.name
    );
    if (!usableServices || usableServices.length === 0) {
      throw new Error(
        `${this.METADATA.NAME} requires at least one usable service, but none were found. Please enable at least one of the following services: ${this.METADATA.SUPPORTED_SERVICES.join(
          ', '
        )}`
      );
    }
    if (options.useMultipleInstances) {
      return usableServices.map((service) =>
        this.generateAddon(userData, options, [service.id])
      );
    }
    return [
      this.generateAddon(
        userData,
        options,
        usableServices.map((service) => service.id)
      ),
    ];
  }

  private static generateAddon(
    userData: UserData,
    options: Record<string, any>,
    services: ServiceId[]
  ): Addon {
    return {
      name: options.name || this.METADATA.NAME,
      manifestUrl: this.generateManifestUrl(userData, services, options),
      enabled: true,
      displayIdentifier: services
        .map((id) => constants.SERVICE_DETAILS[id].shortName)
        .join(' | '),
      identifier:
        services.length > 1
          ? 'multi'
          : constants.SERVICE_DETAILS[services[0]].shortName,
      library: options.libraryAddon ?? false,
      resources: options.resources || undefined,
      mediaTypes: options.mediaTypes || [],
      timeout: withInternalTimeoutMargin(
        options.timeout,
        (appConfig.builtins?.harbrr?.searchTimeout ?? 30000)
      ),
      preset: {
        id: '',
        type: this.METADATA.ID,
        options: options,
      },
      formatPassthrough:
        options.formatPassthrough ?? options.streamPassthrough ?? false,
      resultPassthrough: options.resultPassthrough ?? false,
      headers: {
        'User-Agent': this.METADATA.USER_AGENT,
      },
    };
  }

  protected static generateManifestUrl(
    userData: UserData,
    services: ServiceId[],
    options: Record<string, any>
  ) {
    let harbrrUrl = undefined;
    let harbrrApiKey = undefined;
    let indexers: string[] | undefined;

    if (options.harbrrUrl || options.harbrrApiKey) {
      harbrrUrl = options.harbrrUrl;
      harbrrApiKey = options.harbrrApiKey;
      if (options.indexers && typeof options.indexers === 'string') {
        indexers = `${options.indexers}`.split(',');
      }
    } else {
      harbrrUrl = appConfig.builtins.harbrr.url;
      harbrrApiKey = appConfig.builtins.harbrr.apiKey;
      indexers = Array.isArray(options.indexers) ? options.indexers : undefined;
    }

    if (!harbrrUrl || !harbrrApiKey) {
      throw new Error('Harbrr URL and API Key are required');
    }

    const config = {
      ...this.getBaseConfig(userData, services),
      url: harbrrUrl,
      apiKey: harbrrApiKey,
      indexers: indexers || [],
      sources: options.sources || [],
    };

    const configString = this.base64EncodeJSON(config, 'urlSafe');
    return `${this.DEFAULT_URL}/${configString}/manifest.json`;
  }
}
