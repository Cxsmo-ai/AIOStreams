import { Addon, Option, UserData } from '../db/index.js';
import { Preset, baseOptions } from './preset.js';
import { constants, SUBTITLES_RESOURCE } from '../utils/index.js';
import { config as appConfig } from '../config/index.js';

export class DeepbridOpenSubtitlesPreset extends Preset {
  static override get METADATA() {
    const supportedResources = [SUBTITLES_RESOURCE];

    const languages = [
      { label: 'English', value: 'en' },
      { label: 'Spanish', value: 'es' },
      { label: 'French', value: 'fr' },
      { label: 'German', value: 'de' },
      { label: 'Italian', value: 'it' },
      { label: 'Portuguese', value: 'pt' },
      { label: 'Portuguese (BR)', value: 'pt-br' },
      { label: 'Russian', value: 'ru' },
      { label: 'Arabic', value: 'ar' },
      { label: 'Chinese', value: 'zh' },
      { label: 'Japanese', value: 'ja' },
      { label: 'Korean', value: 'ko' },
      { label: 'Hindi', value: 'hi' },
      { label: 'Turkish', value: 'tr' },
      { label: 'Polish', value: 'pl' },
      { label: 'Dutch', value: 'nl' },
      { label: 'Greek', value: 'el' },
      { label: 'Hebrew', value: 'he' },
      { label: 'Swedish', value: 'sv' },
      { label: 'Norwegian', value: 'no' },
      { label: 'Danish', value: 'da' },
      { label: 'Finnish', value: 'fi' },
      { label: 'Vietnamese', value: 'vi' },
      { label: 'Indonesian', value: 'id' },
      { label: 'Thai', value: 'th' },
      { label: 'Czech', value: 'cs' },
      { label: 'Hungarian', value: 'hu' },
      { label: 'Romanian', value: 'ro' },
      { label: 'Ukrainian', value: 'uk' },
    ];

    const options: Option[] = [
      ...baseOptions(
        'Deepbrid OpenSubtitles',
        supportedResources,
        appConfig.presets.defaultTimeout
      ),
      {
        id: 'languages',
        type: 'multi-select',
        name: 'Languages',
        description: 'Select preferred subtitle languages',
        options: languages,
        required: true,
        default: ['en'],
        constraints: {
          min: 1,
          max: 10,
        },
      },
      {
        id: 'hearingImpaired',
        type: 'select',
        name: 'Hearing Impairment',
        description: 'Filter hearing impaired (HI) subtitles',
        options: [
          { label: 'Include', value: 'include' },
          { label: 'Exclude', value: 'exclude' },
          { label: 'Only', value: 'only' },
        ],
        default: 'include',
        required: true,
      },
      {
        id: 'maxSubtitles',
        type: 'number',
        name: 'Max Subtitles per Query',
        description: 'Maximum number of subtitles to return per language (1-20)',
        default: 10,
        required: true,
        constraints: {
          min: 1,
          max: 20,
        },
      },
    ];

    return {
      ID: 'deepbrid-opensubtitles',
      NAME: 'Deepbrid OpenSubtitles',
      LOGO: 'https://i.ibb.co/yN39ZPV/opensubtitles-plus-256x256.png',
      URL: [`${appConfig.bootstrap.internalUrl}/builtins/deepbrid-subtitles`],
      TIMEOUT: appConfig.presets.defaultTimeout,
      USER_AGENT: appConfig.http.defaultUserAgent,
      SUPPORTED_SERVICES: [],
      DESCRIPTION:
        'High-speed universal subtitles powered by Deepbrid OpenSubtitles web resolver with direct WebVTT streaming.',
      OPTIONS: options,
      SUPPORTED_STREAM_TYPES: [],
      SUPPORTED_RESOURCES: supportedResources,
      CATEGORY: constants.PresetCategory.SUBTITLES,
      BUILTIN: true,
    };
  }

  static async generateAddons(
    userData: UserData,
    options: Record<string, any>
  ): Promise<Addon[]> {
    return [this.generateAddon(userData, options)];
  }

  private static generateAddon(
    userData: UserData,
    options: Record<string, any>
  ): Addon {
    return {
      name: options.name || this.METADATA.NAME,
      manifestUrl: this.generateManifestUrl(options),
      enabled: true,
      library: false,
      resources: options.resources || this.METADATA.SUPPORTED_RESOURCES,
      timeout: options.timeout || this.METADATA.TIMEOUT,
      preset: {
        id: '',
        type: this.METADATA.ID,
        options: options,
      },
      headers: {
        'User-Agent': this.METADATA.USER_AGENT,
      },
    };
  }

  private static generateManifestUrl(options: Record<string, any>): string {
    const host = (options.url || this.DEFAULT_URL).replace(/\/+$/, '');
    const langs = Array.isArray(options.languages) ? options.languages.join(',') : (options.languages || 'en');
    const hi = options.hearingImpaired || 'include';
    const max = options.maxSubtitles || 10;

    const config = Buffer.from(JSON.stringify({
      languages: langs,
      hearingImpaired: hi,
      maxSubtitles: max,
    })).toString('base64url');

    return `${host}/${config}/manifest.json`;
  }
}
