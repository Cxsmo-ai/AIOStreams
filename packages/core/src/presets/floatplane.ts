import { Addon, Option, PresetMetadata, UserData } from '../db/index.js';
import { appConfig, constants } from '../utils/index.js';
import { baseOptions, Preset } from './preset.js';

export class FloatplanePreset extends Preset {
  static override get METADATA(): PresetMetadata {
    const resources = [
      constants.CATALOG_RESOURCE,
      constants.META_RESOURCE,
      constants.STREAM_RESOURCE,
      constants.SUBTITLES_RESOURCE,
    ];
    const options: Option[] = [
      {
        id: 'auth',
        name: 'Authorise Floatplane',
        description:
          'Link Floatplane with the official device-code flow. Credentials stay encrypted in this AIOStreams instance.',
        type: 'oauth',
        required: true,
        oauth: {
          authorisationUrl: `${appConfig.bootstrap.baseUrl}/api/v1/floatplane/link/start`,
          oauthResultField: {
            name: 'Floatplane Link Reference',
            description:
              'Paste the opaque reference shown after you complete the Floatplane device link.',
          },
        },
      },
      {
        id: 'includeSubscriptions',
        name: 'Subscription Catalog',
        description: 'Show creators included in your Floatplane subscriptions.',
        type: 'boolean',
        default: true,
      },
      {
        id: 'includeChannels',
        name: 'Channel Catalog',
        description: 'Show creator channels and subchannels.',
        type: 'boolean',
        default: true,
      },
      {
        id: 'includeSearch',
        name: 'Search Catalog',
        description: 'Enable Floatplane content search.',
        type: 'boolean',
        default: true,
      },
      {
        id: 'includeSubtitles',
        name: 'Subtitles',
        description: 'Expose subtitle/text tracks returned by Floatplane.',
        type: 'boolean',
        default: true,
      },
      ...baseOptions(
        'Floatplane',
        resources,
        appConfig.presets.defaultTimeout
      ).filter((option) => option.id !== 'url'),
    ];
    return {
      ID: 'floatplane',
      NAME: 'Floatplane',
      DESCRIPTION:
        'Official Floatplane device-link integration with subscriptions, channels, search, metadata, artwork, quality variants, and subtitles.',
      LOGO: 'https://floatplane.com/favicon.ico',
      URL: [`${appConfig.bootstrap.internalUrl}/builtins/floatplane`],
      TIMEOUT: appConfig.presets.defaultTimeout,
      USER_AGENT: appConfig.http.defaultUserAgent,
      SUPPORTED_RESOURCES: resources,
      SUPPORTED_STREAM_TYPES: [constants.HTTP_STREAM_TYPE],
      SUPPORTED_SERVICES: [],
      OPTIONS: options,
      BUILTIN: true,
    };
  }
  static async generateAddons(
    _userData: UserData,
    options: Record<string, any>
  ): Promise<Addon[]> {
    return [this.generateAddon(options)];
  }
  private static generateAddon(options: Record<string, any>): Addon {
    if (!options.auth)
      throw new Error(
        'Floatplane requires a link reference. Open Authorise Floatplane and complete device linking first.'
      );
    const config = this.base64EncodeJSON(
      {
        authRef: options.auth,
        includeSubscriptions: options.includeSubscriptions !== false,
        includeChannels: options.includeChannels !== false,
        includeSearch: options.includeSearch !== false,
        includeSubtitles: options.includeSubtitles !== false,
      },
      'urlSafe'
    );
    return {
      name: options.name || this.METADATA.NAME,
      manifestUrl: `${this.DEFAULT_URL}/${config}/manifest.json`,
      enabled: true,
      resources: options.resources || this.METADATA.SUPPORTED_RESOURCES,
      timeout: options.timeout || this.METADATA.TIMEOUT,
      preset: { id: '', type: this.METADATA.ID, options },
      headers: { 'User-Agent': this.METADATA.USER_AGENT },
    };
  }
}
