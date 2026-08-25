import { Addon, Option, UserData } from '../db/index.js';
import { appConfig, constants, encryptString } from '../utils/index.js';
import { BuiltinAddonPreset } from './builtin.js';

export class KuratoPreset extends BuiltinAddonPreset {
  static override get METADATA() {
    const supportedResources = [
      constants.CATALOG_RESOURCE,
      constants.META_RESOURCE,
    ];
    const options: Option[] = [
      {
        id: 'name',
        name: 'Name',
        description: 'What to call this Kurato catalog and search addon.',
        type: 'string',
        required: true,
        default: 'Kurato',
      },
      {
        id: 'timeout',
        name: 'Timeout (ms)',
        description: 'Maximum time allowed for one Kurato catalog request.',
        type: 'number',
        required: true,
        default: Math.min(20_000, appConfig.presets.defaultTimeout),
        constraints: {
          min: appConfig.userLimits.timeouts.minTimeout,
          max: appConfig.userLimits.timeouts.maxTimeout,
          forceInUi: false,
        },
      },
      {
        id: 'pageSize',
        name: 'Results per page',
        description: 'Number of personalized or search results requested per page.',
        type: 'number',
        required: false,
        default: 50,
        constraints: { min: 1, max: 100, forceInUi: false },
      },
      {
        id: 'includeWatchlist',
        name: 'Include Kurato Watchlist catalogs',
        description: 'Adds separate movie and series catalogs sourced from your Kurato watchlist.',
        type: 'boolean',
        required: false,
        default: true,
      },
      {
        id: 'mediaTypes',
        name: 'Media Types',
        description: 'Leave empty to include both movies and series.',
        type: 'multi-select',
        required: false,
        showInSimpleMode: false,
        default: [],
        options: [
          { label: 'Movie', value: 'movie' },
          { label: 'Series', value: 'series' },
        ],
      },
    ];

    return {
      ID: 'kurato',
      NAME: 'Kurato',
      LOGO: 'https://kurato.com/favicon.ico',
      URL: [`${appConfig.bootstrap.internalUrl}/builtins/kurato`],
      TIMEOUT: Math.min(20_000, appConfig.presets.defaultTimeout),
      USER_AGENT: appConfig.http.defaultUserAgent,
      SUPPORTED_SERVICES: [constants.KURATO_SERVICE],
      DESCRIPTION:
        'Personalized Kurato recommendations, watchlist catalogs, and authenticated search. Configure the Kurato account once under Services.',
      OPTIONS: options,
      SUPPORTED_STREAM_TYPES: [],
      SUPPORTED_RESOURCES: supportedResources,
      BUILTIN: true,
    };
  }

  static async generateAddons(
    userData: UserData,
    options: Record<string, any>
  ): Promise<Addon[]> {
    const service = userData.services?.find(
      (candidate) => candidate.id === constants.KURATO_SERVICE
    );
    const email = service?.credentials?.email?.trim();
    const password = service?.credentials?.password;
    if (!service || service.enabled === false || !email || !password) {
      throw new Error(
        'Kurato requires an enabled Kurato service with your account email and password. Configure it once under Services > Kurato.'
      );
    }

    const privateConfig = {
      email,
      password,
      pageSize: options.pageSize ?? 50,
      includeWatchlist: options.includeWatchlist !== false,
    };
    const encrypted = encryptString(JSON.stringify(privateConfig));
    if (!encrypted.success || !encrypted.data) {
      throw new Error('Failed to encrypt the Kurato configuration.');
    }

    return [
      {
        name: options.name || this.METADATA.NAME,
        manifestUrl: `${this.DEFAULT_URL}/${encrypted.data}/manifest.json`,
        identifier: 'kurato',
        displayIdentifier: 'KU',
        enabled: true,
        resources: options.resources || this.METADATA.SUPPORTED_RESOURCES,
        mediaTypes: options.mediaTypes || [],
        timeout: options.timeout || this.METADATA.TIMEOUT,
        preset: { id: '', type: this.METADATA.ID, options },
        headers: { 'User-Agent': this.METADATA.USER_AGENT },
      },
    ];
  }
}
