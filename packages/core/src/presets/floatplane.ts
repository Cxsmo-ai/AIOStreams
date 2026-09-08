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
      // The old public favicon URL is not a stable image endpoint. The
      // frontend serves this bundled icon locally so the marketplace never
      // shows a broken-image placeholder when Floatplane is selected.
      LOGO: '/assets/floatplane-icon.png',
      URL: [`${appConfig.bootstrap.internalUrl}/builtins/floatplane`],
      TIMEOUT: appConfig.presets.defaultTimeout,
      USER_AGENT: appConfig.http.defaultUserAgent,
      SUPPORTED_RESOURCES: resources,
      // Floatplane delivers VOD as signed HLS playlists. The parser exposes
      // those as `live` internally, so advertise both forms to keep the
      // stream-type pipeline from treating them as an unsupported addon.
      SUPPORTED_STREAM_TYPES: [
        constants.HTTP_STREAM_TYPE,
        constants.LIVE_STREAM_TYPE,
      ],
      SUPPORTED_SERVICES: [constants.FLOATPLANE_SERVICE],
      OPTIONS: options,
      BUILTIN: true,
    };
  }
  static async generateAddons(
    userData: UserData,
    options: Record<string, any>
  ): Promise<Addon[]> {
    const service = this.getUsableServices(
      userData,
      options.services,
      options.name
    )?.[0];
    // Keep existing Floatplane addon URLs working while users migrate to the
    // Services page. New configurations use the per-user service credential.
    const authRef = options.auth ?? service?.credentials?.authRef;
    return [this.generateAddon({ ...options, authRef })];
  }
  private static generateAddon(options: Record<string, any>): Addon {
    if (!options.authRef)
      throw new Error(
        'Floatplane requires a linked Floatplane service. Open Services → Floatplane and complete the official device link first.'
      );
    const config = this.base64EncodeJSON(
      {
        authRef: options.authRef,
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
      // Let the user's configured formatter add the same source metadata,
      // cache markers, resolution, audio, subtitle, and playback hints used
      // by every other addon. Floatplane's technical variant details remain
      // in the parsed stream description for the formatter to consume.
      formatPassthrough: options.formatPassthrough === true,
    };
  }
}
