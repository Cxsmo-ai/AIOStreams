import { Addon, Option, UserData } from '../db/index.js';
import { CacheKeyRequestOptions, Preset, baseOptions } from './preset.js';
import { config as appConfig } from '../config/index.js';
import { constants } from '../utils/index.js';

/**
 * Exposes the official public Cinemeta catalogs through AIOStreams so users
 * can add them to the same merged catalog setup as every other source.
 * Cinemeta's endpoint is public and does not require user credentials.
 */
export class CinemetaCatalogsPreset extends Preset {
  static override get METADATA() {
    const supportedResources = [
      constants.CATALOG_RESOURCE,
      constants.META_RESOURCE,
      constants.ADDON_CATALOG_RESOURCE,
    ];
    const options: Option[] = [
      ...baseOptions(
        'Cinemeta Catalogs',
        supportedResources,
        appConfig.presets.cinemetaCatalogs.defaultTimeout ??
          appConfig.presets.defaultTimeout
      ),
    ];

    return {
      ID: 'cinemeta-catalogs',
      NAME: 'Cinemeta Catalogs',
      // v3 exposes no logo asset; the official legacy Cinemeta host still
      // serves the same maintained addon artwork.
      LOGO: 'https://cinemeta.strem.io/logo.png',
      URL: appConfig.presets.cinemetaCatalogs.url,
      TIMEOUT:
        appConfig.presets.cinemetaCatalogs.defaultTimeout ??
        appConfig.presets.defaultTimeout,
      USER_AGENT:
        appConfig.presets.cinemetaCatalogs.defaultUserAgent ??
        appConfig.http.defaultUserAgent,
      SUPPORTED_SERVICES: [],
      DESCRIPTION:
        'Official Cinemeta movie and series catalogs with no user API key.',
      OPTIONS: options,
      SUPPORTED_STREAM_TYPES: [],
      SUPPORTED_RESOURCES: supportedResources,
      CATEGORY: constants.PresetCategory.META_CATALOGS,
    };
  }

  static async generateAddons(
    _userData: UserData,
    options: Record<string, any>
  ): Promise<Addon[]> {
    const configuredUrl = String(options.url || this.DEFAULT_URL).replace(
      /\/$/,
      ''
    );
    const manifestUrl = configuredUrl.endsWith('/manifest.json')
      ? configuredUrl
      : `${configuredUrl}/manifest.json`;

    return [
      {
        name: options.name || this.METADATA.NAME,
        manifestUrl,
        enabled: true,
        library: false,
        resources: options.resources || this.METADATA.SUPPORTED_RESOURCES,
        timeout: options.timeout || this.METADATA.TIMEOUT,
        preset: {
          id: '',
          type: this.METADATA.ID,
          options,
        },
        headers: {
          'User-Agent': this.METADATA.USER_AGENT,
        },
      },
    ];
  }

  static override getCacheKey(
    options: CacheKeyRequestOptions
  ): string | undefined {
    const { resource, type, id, options: presetOptions, extras } = options;
    try {
      const url = new URL(presetOptions.url || this.DEFAULT_URL);
      if (url.pathname.endsWith('/manifest.json')) return undefined;
      if (url.origin !== new URL(this.DEFAULT_URL).origin) return undefined;
    } catch {
      return undefined;
    }

    return `${this.METADATA.ID}-${resource}-${type}-${id}-${extras || ''}`;
  }
}
