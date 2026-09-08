import {
  Manifest,
  Meta,
  MetaPreview,
  Stream,
  Subtitle,
} from '../../db/index.js';
import { config as appConfig } from '../../config/index.js';
import {
  FloatplaneAuthState,
  FloatplaneClient,
  array,
  first,
  url,
} from './api.js';
import { Buffer } from 'node:buffer';
import { containsAv1 } from './codec.js';

const CHANNEL_CATALOG_PREFIX = 'floatplane-channel-';
const FLOATPLANE_LOGO_PATH = '/assets/floatplane-icon.png';

function floatplaneLogoUrl(): string {
  const base =
    appConfig.bootstrap.baseUrl || appConfig.bootstrap.internalUrl || '';
  return base
    ? `${base.replace(/\/$/, '')}${FLOATPLANE_LOGO_PATH}`
    : FLOATPLANE_LOGO_PATH;
}

function text(value: unknown, fallback = ''): string {
  return String(value ?? fallback);
}
function descriptionOf(item: any, fallback?: string): string | undefined {
  const raw = first(
    item,
    'description',
    'overview',
    'summary',
    'text',
    'body',
    'content',
    'caption'
  );
  const nested =
    raw && typeof raw === 'object' ? first(raw, 'text', 'value') : raw;
  const value = typeof nested === 'string' ? nested : fallback;
  if (!value) return undefined;
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
function durationSeconds(value: unknown): number | undefined {
  if (value && typeof value === 'object')
    return durationSeconds(first(value, 'seconds', 'duration', 'value'));
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
    return value > 100_000 ? value / 1000 : value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const input = value.trim().toLowerCase();
  if (input.includes(':')) {
    const parts = input.split(':').map((part) => Number(part));
    if (parts.every((part) => Number.isFinite(part))) {
      return parts.length === 3
        ? parts[0] * 3600 + parts[1] * 60 + parts[2]
        : parts.length === 2
          ? parts[0] * 60 + parts[1]
          : parts[0];
    }
  }
  const number = numberValue(input);
  if (!number) return undefined;
  if (/ms\b/.test(input)) return number / 1000;
  if (/hour|hr|h\b/.test(input)) return number * 3600;
  if (/minute|min|m\b/.test(input)) return number * 60;
  return number > 100_000 ? number / 1000 : number;
}
function durationLabel(item: any): string | undefined {
  const seconds = durationSeconds(
    first(
      item,
      'duration',
      'durationSeconds',
      'durationMs',
      'runtime',
      'length',
      'mediaDuration'
    )
  );
  if (seconds === undefined) return undefined;
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${String(remaining).padStart(2, '0')}s`;
  return `${remaining}s`;
}
function numberValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return 0;
  const match = value.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}
function variantMediaValue(
  variant: any,
  media: 'video' | 'audio',
  ...keys: string[]
): unknown {
  const direct = first(variant, ...keys);
  if (direct !== undefined && direct !== null) return direct;
  for (const containerKey of ['meta', 'metadata', 'media', 'streams']) {
    const container = first(variant, containerKey);
    const mediaObject = first(container, media, `${media}Track`);
    const nested = first(mediaObject, ...keys);
    if (nested !== undefined && nested !== null) return nested;
  }
  return undefined;
}
function variantHeight(variant: any): number {
  const raw = variantMediaValue(
    variant,
    'video',
    'height',
    'videoHeight',
    'resolution',
    'quality',
    'label'
  );
  const value = text(raw).toLowerCase();
  if (/8k/.test(value)) return 4320;
  if (/4k|2160|uhd/.test(value)) return 2160;
  if (/1440|2k|qhd/.test(value)) return 1440;
  if (/1080|fhd/.test(value)) return 1080;
  if (/720|hd/.test(value)) return 720;
  if (/480|sd/.test(value)) return 480;
  return numberValue(raw);
}
function audioQuality(variant: any): number {
  const bitrate = numberValue(
    variantMediaValue(
      variant,
      'audio',
      'bitrate',
      'bitRate',
      'bandwidth',
      'bitrateKbps'
    )
  );
  const sampleRate = numberValue(
    variantMediaValue(
      variant,
      'audio',
      'sampleRate',
      'samplerate',
      'samplingRate'
    )
  );
  const channels = numberValue(
    variantMediaValue(
      variant,
      'audio',
      'channelCount',
      'channels',
      'channelLayout'
    )
  );
  const codec = text(
    variantMediaValue(variant, 'audio', 'codec', 'audioCodec', 'format')
  ).toLowerCase();
  const codecWeight = /truehd|atmos|dts.?hd|eac3|ac3|opus|flac/.test(codec)
    ? 100
    : /aac|mp3/.test(codec)
      ? 10
      : 0;
  // Bitrate is the primary quality signal. The other fields break ties while
  // keeping the score bounded and deterministic for malformed API values.
  return (
    bitrate * 1_000_000 + sampleRate * 100 + channels * 10_000 + codecWeight
  );
}
function audioDescription(variant: any): string[] {
  const codec = text(
    variantMediaValue(variant, 'audio', 'codec', 'audioCodec', 'format')
  );
  const bitrate = numberValue(
    variantMediaValue(
      variant,
      'audio',
      'bitrate',
      'bitRate',
      'bandwidth',
      'bitrateKbps'
    )
  );
  const channels = numberValue(
    variantMediaValue(
      variant,
      'audio',
      'channelCount',
      'channels',
      'channelLayout'
    )
  );
  return [
    codec && `audio ${codec}`,
    bitrate > 0 && `audio ${Math.round(bitrate)} kbps`,
    channels > 0 && `audio ${channels}ch`,
  ].filter((value): value is string => Boolean(value));
}

function usefulTitle(item: any): string | undefined {
  const value = title(item);
  return value && value !== 'Floatplane content' ? value : undefined;
}

function resolutionLabel(variant: any): string | undefined {
  const height = variantHeight(variant);
  if (height > 0) return `${height}p`;
  const raw = text(
    variantMediaValue(
      variant,
      'video',
      'resolution',
      'quality',
      'label',
      'name'
    )
  ).trim();
  return raw || undefined;
}

function languageLabels(item: any): string[] {
  const audioLanguage = variantMediaValue(item, 'audio', 'language', 'lang');
  const values = [
    first(item, 'language', 'lang', 'audioLanguage', 'audioLang'),
    typeof audioLanguage === 'object'
      ? first(audioLanguage, 'name', 'label', 'code')
      : audioLanguage,
    first(item, 'languages', 'audioLanguages'),
  ];
  return [
    ...new Set(
      values
        .flatMap((value) =>
          Array.isArray(value) ? value : value === undefined ? [] : [value]
        )
        .map((value) =>
          typeof value === 'object'
            ? first(value, 'name', 'label', 'language', 'lang', 'code')
            : value
        )
        .map((value) => text(value).trim())
        .filter(Boolean)
    ),
  ];
}

function subtitleLabels(item: any): string[] {
  const tracks = array(
    first(
      item,
      'textTracks',
      'texttracks',
      'text_tracks',
      'captions',
      'subtitles',
      'tracks'
    )
  );
  return [
    ...new Set(
      tracks
        .map((track) =>
          text(first(track, 'language', 'lang', 'label', 'name', 'code')).trim()
        )
        .filter(Boolean)
    ),
  ];
}

function floatplaneFilename(
  variant: any,
  metadata: any,
  resolution: string | undefined,
  videoCodec: string,
  languages: string[]
): string {
  const parts = [
    usefulTitle(metadata) || usefulTitle(variant) || 'Floatplane',
    resolution,
    videoCodec,
    ...languages,
  ].filter(Boolean);
  return parts
    .join(' ')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .trim();
}

function floatplaneDescription(
  variant: any,
  metadata: any,
  resolution: string | undefined,
  videoCodec: string,
  technicalAudio: string[],
  duration: string | undefined,
  languages: string[],
  subtitles: string[]
): string {
  const titleLine = usefulTitle(metadata) || usefulTitle(variant);
  return [
    titleLine,
    resolution && `🎥 ${resolution}`,
    videoCodec && `🎞️ ${videoCodec}`,
    technicalAudio.length ? `🎧 ${technicalAudio.join(' · ')}` : undefined,
    duration && `⏱️ ${duration}`,
    languages.length ? `🌎 ${languages.join(' · ')}` : undefined,
    subtitles.length ? `📝 ${subtitles.join(' · ')}` : undefined,
    '📺 Direct Floatplane',
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}
function image(item: any): string | undefined {
  const value = first(
    item,
    'thumbnail',
    'thumbnailUrl',
    'poster',
    'posterUrl',
    'image',
    'imageUrl',
    'background',
    'card',
    'icon'
  );
  if (typeof value === 'string') return url(value);
  if (value && typeof value === 'object') {
    const nested = first(value, 'path', 'url', 'src');
    if (nested) return url(nested);
    const children = first(value, 'childImages', 'children');
    const child = array(children)[0];
    if (child) return image(child);
  }
  return undefined;
}
function title(item: any): string {
  const raw = first(
    item,
    'title',
    'name',
    'displayName',
    'headline',
    'subject',
    'videoTitle'
  );
  const nested =
    raw && typeof raw === 'object' ? first(raw, 'text', 'value') : raw;
  return descriptionOf({ description: nested }) || 'Floatplane content';
}
function idOf(item: any): string {
  if (typeof item === 'string') return item;
  return text(first(item, 'id', 'guid', 'contentId', 'postId'));
}
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => idOf(item))
    .filter((item): item is string => Boolean(item));
}
function channelCatalogId(creatorId: string, channelId: string): string {
  return `${CHANNEL_CATALOG_PREFIX}${Buffer.from(
    JSON.stringify([creatorId, channelId])
  ).toString('base64url')}`;
}
function parseChannelCatalogId(
  catalogId: string
): { creatorId: string; channelId: string } | undefined {
  if (!catalogId.startsWith(CHANNEL_CATALOG_PREFIX)) return undefined;
  try {
    const value = JSON.parse(
      Buffer.from(
        catalogId.slice(CHANNEL_CATALOG_PREFIX.length),
        'base64url'
      ).toString('utf8')
    );
    if (
      Array.isArray(value) &&
      typeof value[0] === 'string' &&
      typeof value[1] === 'string'
    )
      return { creatorId: value[0], channelId: value[1] };
  } catch {
    // Treat malformed dynamic catalog ids as an unknown catalog.
  }
  return undefined;
}

export class FloatplaneAddon {
  private readonly api: FloatplaneClient;
  constructor(
    private readonly userData: {
      auth: FloatplaneAuthState;
      includeSubscriptions?: boolean;
      includeChannels?: boolean;
      includeSearch?: boolean;
      includeSubtitles?: boolean;
    }
  ) {
    this.api = new FloatplaneClient(userData.auth);
  }

  static getManifest(): Manifest {
    return {
      id: 'com.aiostreams.floatplane',
      version: '1.0.0',
      name: 'Floatplane',
      logo: floatplaneLogoUrl(),
      description:
        'Floatplane subscriptions, creators, channels, posts, search, artwork, variants, and subtitles.',
      types: ['series', 'movie'],
      catalogs: [
        {
          type: 'series',
          id: 'floatplane-subscriptions',
          name: 'Floatplane Subscriptions',
          extra: [{ name: 'skip' }],
        },
        {
          type: 'series',
          id: 'floatplane-latest',
          name: 'Floatplane Latest',
          extra: [{ name: 'skip' }],
        },
        {
          type: 'series',
          id: 'floatplane-search',
          name: 'Floatplane Search',
          extra: [{ name: 'search', isRequired: true }],
        },
      ],
      resources: [
        { name: 'catalog', types: ['series', 'movie'], idPrefixes: ['fp:'] },
        { name: 'meta', types: ['series', 'movie'], idPrefixes: ['fp:'] },
        { name: 'stream', types: ['series', 'movie'], idPrefixes: ['fp:'] },
        { name: 'subtitles', types: ['series', 'movie'], idPrefixes: ['fp:'] },
      ],
      behaviorHints: {
        configurable: true,
        configurationRequired: true,
        p2p: false,
        adult: false,
      },
    };
  }
  getManifest(): Manifest {
    return FloatplaneAddon.getManifest();
  }

  private preview(item: any, kind = 'post', idOverride?: string): MetaPreview {
    const poster =
      image(item) || image(first(item, 'creator', 'channel', 'owner'));
    const released = first(
      item,
      'publishedAt',
      'createdAt',
      'releaseDate',
      'released'
    );
    return {
      id: idOverride || `fp:${kind}:${idOf(item)}`,
      type: 'series',
      name: title(item),
      poster,
      posterShape: 'landscape',
      background: poster,
      description: descriptionOf(item),
      releaseInfo: released ? text(released).slice(0, 10) : undefined,
      ...(durationLabel(item) ? { runtime: durationLabel(item) } : {}),
    };
  }
  private async creators(): Promise<any[]> {
    const subscriptions = array(await this.api.subscriptions());
    const ids = [
      ...new Set(
        subscriptions
          .map((item) => first(item, 'creator', 'creatorId'))
          .map((value) =>
            value && typeof value === 'object' ? idOf(value) : text(value)
          )
          .filter(Boolean)
      ),
    ];
    const creators = await Promise.all(
      ids.map(async (id) => {
        try {
          return await this.api.creatorInfo(id);
        } catch {
          return null;
        }
      })
    );
    return creators.filter(Boolean) as any[];
  }

  private async channelEntries(): Promise<
    { creator: any; creatorId: string; channel: any; channelId: string }[]
  > {
    const creators = await this.creators();
    const seen = new Set<string>();
    return (
      await Promise.all(
        creators.map(async (creator) => {
          const creatorId = idOf(creator);
          if (!creatorId) return [];
          const channels = array(await this.api.channels(creatorId));
          return channels
            .map((channel) => {
              const channelId = idOf(channel);
              if (!channelId) return null;
              const key = `${creatorId}:${channelId}`;
              if (seen.has(key)) return null;
              seen.add(key);
              return { creator, creatorId, channel, channelId };
            })
            .filter(Boolean) as {
            creator: any;
            creatorId: string;
            channel: any;
            channelId: string;
          }[];
        })
      )
    ).flat();
  }

  async getConfiguredManifest(): Promise<Manifest> {
    const manifest = FloatplaneAddon.getManifest();
    if (this.userData.includeChannels === false) return manifest;
    try {
      const entries = await this.channelEntries();
      manifest.catalogs = [
        ...(manifest.catalogs || []),
        ...entries.map(({ creator, creatorId, channel, channelId }) => ({
          type: 'series',
          id: channelCatalogId(creatorId, channelId),
          name: `Floatplane · ${title(creator)} · ${title(channel)}`,
          extra: [{ name: 'skip' }],
        })),
      ];
    } catch {
      // Keep the core Floatplane catalogs available if channel discovery is
      // temporarily unavailable; the next manifest refresh retries it.
    }
    return manifest;
  }

  async getCatalog(
    _type: string,
    catalogId: string,
    extras?: string
  ): Promise<MetaPreview[]> {
    const params = new URLSearchParams(extras || '');
    const skip = Math.max(0, Number(params.get('skip') || 0));
    if (catalogId === 'floatplane-search')
      return this.userData.includeSearch === false
        ? []
        : array(await this.api.search(params.get('search') || '')).map((x) =>
            this.preview(x)
          );
    const channelCatalog = parseChannelCatalogId(catalogId);
    if (channelCatalog) {
      if (this.userData.includeChannels === false) return [];
      const posts = array(
        await this.api.creatorContent(
          channelCatalog.creatorId,
          channelCatalog.channelId,
          skip,
          20
        )
      );
      return posts.slice(0, 100).map((x) => this.preview(x));
    }
    const creators = await this.creators();
    if (catalogId === 'floatplane-subscriptions')
      return this.userData.includeSubscriptions === false
        ? []
        : creators.map((x) => this.preview(x, 'creator'));
    if (catalogId === 'floatplane-channels') return [];
    const posts = (
      await Promise.all(
        creators.map(async (creator) =>
          array(
            await this.api.creatorContent(idOf(creator), undefined, skip, 20)
          )
        )
      )
    ).flat();
    return posts.slice(0, 100).map((x) => this.preview(x));
  }

  async getMeta(_type: string, itemId: string): Promise<Meta> {
    const parts = itemId.split(':');
    const kind = parts[1];
    const rawId = parts[2] || itemId;
    if (kind === 'creator' || kind === 'channel') {
      const creatorId = kind === 'channel' ? parts[2] : rawId;
      const channelId = kind === 'channel' ? parts[3] : undefined;
      const data =
        kind === 'creator'
          ? await this.api.creatorInfo(rawId)
          : await this.api.channels(creatorId);
      const item =
        kind === 'creator'
          ? data
          : array(data).find((x) => idOf(x) === channelId) || {};
      return { ...this.preview(item, kind), type: 'series', videos: [] };
    }
    const response = await this.api.post(rawId);
    const item = first(response, 'post', 'content', 'data') || response;
    const attachmentIds = stringArray(first(item, 'videoAttachments'));
    const videos = (
      await Promise.all(
        attachmentIds.map(async (videoId, index) => {
          try {
            const video = await this.api.video(videoId);
            const overview = descriptionOf(video) || descriptionOf(item);
            const runtime = durationLabel(video);
            return {
              id: `fp:video:${videoId}`,
              title: title(video) || title(item),
              overview,
              description: overview,
              released:
                first(video, 'releaseDate') || first(item, 'releaseDate'),
              thumbnail: image(video) || image(item),
              available: first(video, 'isAccessible') !== false,
              streams: null,
              ...(runtime ? { runtime } : {}),
              ...(durationSeconds(
                first(video, 'duration', 'durationSeconds', 'durationMs')
              ) !== undefined
                ? {
                    duration: durationSeconds(
                      first(video, 'duration', 'durationSeconds', 'durationMs')
                    ),
                  }
                : {}),
            };
          } catch {
            const overview = descriptionOf(item);
            return {
              id: `fp:video:${videoId || `${rawId}:${index}`}`,
              title: title(item),
              overview,
              description: overview,
              released: first(item, 'releaseDate'),
              thumbnail: image(item),
              available: false,
              streams: null,
            };
          }
        })
      )
    ).filter(Boolean);
    const firstVideo = videos[0] as any;
    const runtime =
      durationLabel(item) ||
      (typeof firstVideo?.runtime === 'string'
        ? firstVideo.runtime
        : undefined);
    const description = descriptionOf(item) || firstVideo?.overview;
    return {
      ...this.preview(item),
      type: 'series',
      description,
      videos,
      ...(runtime ? { runtime } : {}),
    };
  }

  async getStreams(_type: string, itemId: string): Promise<Stream[]> {
    const rawId = itemId.split(':').pop() || itemId;
    const streamsFromDelivery = async (
      response: any,
      outputKind: string,
      metadata?: any
    ): Promise<Stream[]> => {
      const groups = array(first(response, 'groups'));
      const variants = groups.flatMap((group) =>
        array(first(group, 'variants')).map((variant) => ({ variant, group }))
      );
      // Keep the best audio rendition first for each video quality.  Floatplane
      // normally embeds audio in every flat MP4/HLS variant, but some delivery
      // responses contain duplicate resolutions with different audio bitrates.
      // Sorting here lets Stremio's default selection choose the highest-quality
      // audio without hiding the other resolutions from the user.
      const orderedVariants = variants
        .map((entry, index) => ({
          ...entry,
          index,
          height: variantHeight(entry.variant),
          audio: audioQuality(entry.variant),
        }))
        .sort(
          (left, right) =>
            right.height - left.height ||
            right.audio - left.audio ||
            left.index - right.index
        );
      const v3Streams = orderedVariants
        .map(({ variant, group }) => {
          if (
            first(variant, 'hidden') === true ||
            first(variant, 'enabled') === false ||
            containsAv1(variant)
          )
            return null;
          const origins = array(first(variant, 'origins', 'origin'));
          const groupOrigins = array(first(group, 'origins', 'origin'));
          const origin = first(origins[0] || groupOrigins[0], 'url');
          const streamUrl = url(
            first(variant, 'url', 'playbackUrl', 'manifestUrl', 'hls'),
            origin
          );
          if (!streamUrl || /\bav1\b|av01/i.test(streamUrl)) return null;
          const quality = first(
            variant,
            'quality',
            'resolution',
            'label',
            'height'
          );
          const technicalAudio = audioDescription(variant);
          const technicalVideo = text(
            variantMediaValue(variant, 'video', 'codec', 'videoCodec', 'format')
          );
          const resolution = resolutionLabel(variant);
          const languages = [
            ...new Set([
              ...languageLabels(metadata),
              ...languageLabels(variant),
            ]),
          ];
          const subtitles = subtitleLabels(metadata);
          const duration = durationLabel(metadata) || durationLabel(variant);
          const filename = floatplaneFilename(
            variant,
            metadata,
            resolution,
            technicalVideo,
            languages
          );
          const displayQuality = resolution || text(quality).trim();
          return {
            url: streamUrl,
            name: `Floatplane${displayQuality ? ` • ${displayQuality}` : ''}`,
            title: usefulTitle(variant) || usefulTitle(metadata),
            description: floatplaneDescription(
              variant,
              metadata,
              resolution,
              technicalVideo,
              technicalAudio,
              duration,
              languages,
              subtitles
            ),
            behaviorHints: {
              // The generic parser uses this as the canonical filename for
              // resolution/codec/language extraction. Without it Floatplane
              // streams look like anonymous `video avc1` links in custom
              // formatters even though the delivery variant is well known.
              filename,
            },
          } as Stream;
        })
        .filter((x): x is Stream => Boolean(x));
      if (v3Streams.length) {
        // Delivery responses already contain freshly signed CDN URLs. Probing
        // every variant here added 2–5 seconds to every source request and
        // could reject a valid URL when the server could not reach the CDN's
        // watch-key endpoint. Let the client start the direct URL immediately;
        // stream caching is disabled for Floatplane, so every request still
        // receives fresh authorization.
        return v3Streams;
      }

      // Older accounts may only expose the v2 CDN response. Normalize its
      // quality template so those accounts still receive every available level.
      const resource = first(response, 'resource');
      const data = first(resource, 'data');
      const template = first(resource, 'uri');
      const cdn = first(response, 'cdn');
      const params = first(data, 'qualityLevelParams');
      if (typeof template !== 'string' || !cdn || !params) return [];
      const legacyStreams = array(first(data, 'qualityLevels'))
        .map((level) => {
          if (containsAv1(level)) return null;
          const name = text(first(level, 'name'));
          const token = first(params, name, 'token');
          if (!name || !token) return null;
          const path = template
            .replaceAll('{qualityLevels}', name)
            .replaceAll('{qualityLevelParams.token}', text(token));
          const streamUrl = url(path, text(cdn));
          const resolution =
            resolutionLabel(level) ||
            text(first(level, 'label', 'name')).trim();
          const languages = languageLabels(metadata);
          const subtitles = subtitleLabels(metadata);
          const duration = durationLabel(metadata);
          const filename = floatplaneFilename(
            level,
            metadata,
            resolution,
            '',
            languages
          );
          return streamUrl
            ? ({
                url: streamUrl,
                name: `Floatplane${resolution ? ` • ${resolution}` : ''}`,
                title: usefulTitle(metadata),
                description: floatplaneDescription(
                  level,
                  metadata,
                  resolution,
                  '',
                  [],
                  duration,
                  languages,
                  subtitles
                ),
                behaviorHints: { filename },
              } as Stream)
            : null;
        })
        .filter((x): x is Stream => Boolean(x));
      return legacyStreams;
    };

    // Metadata is only used to enrich the display. Keep it bounded and fetch
    // it concurrently with delivery so formatting never makes playback wait
    // on a slow metadata endpoint.
    const metadataPromise = this.api.video(rawId).catch(() => undefined);
    const metadataForDisplay = () =>
      Promise.race([
        metadataPromise,
        // Metadata enriches descriptions and duration, but must never hold a
        // fresh direct playback URL hostage when the metadata endpoint is
        // slow or rate-limited.
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), 350)
        ),
      ]);

    const deliveryFor = async (
      contentId: string,
      outputKind = 'hls.fmp4',
      metadataOverride?: any
    ): Promise<Stream[]> => {
      try {
        const delivery = await this.api.delivery(contentId, outputKind);
        const metadata =
          metadataOverride ??
          (contentId === rawId ? await metadataForDisplay() : undefined);
        return streamsFromDelivery(delivery, outputKind, metadata);
      } catch {
        return [];
      }
    };

    // Older Floatplane posts sometimes accept delivery only for their video
    // attachment id. Resolve that parent in parallel with the first direct
    // delivery request so an attachment-only post does not pay an extra full
    // API round trip before fallback can begin.
    const postPromise = this.api
      .post(rawId)
      .then((response) => first(response, 'post', 'content', 'data') || response)
      .catch(() => undefined);

    // Flat MP4 is the fastest and most broadly compatible Floatplane output.
    // It is returned directly from the fresh delivery response; no server-side
    // proxy or CDN preflight is needed for a signed URL.
    const direct = await deliveryFor(rawId, 'flat');
    if (direct.length) return direct;

    // Alternate transports are compatibility fallbacks only. Run them
    // together so an older account that rejects flat delivery waits for the
    // slowest one transport round trip, not the sum of both.
    const [mpegtsFallback, fmp4Fallback] = await Promise.all([
      deliveryFor(rawId, 'hls.mpegts'),
      deliveryFor(rawId, 'hls.fmp4'),
    ]);
    if (mpegtsFallback.length) return mpegtsFallback;
    if (fmp4Fallback.length) return fmp4Fallback;

    // Attachment-only posts are uncommon, but their old serial fallback was
    // the largest source of long waits. Keep the request fan-out bounded and
    // preserve Floatplane's attachment order when choosing a result.
    const item = await postPromise;
    const attachments = stringArray(
      first(item, 'videoAttachments', 'attachmentOrder')
    ).slice(0, 8);
    if (!attachments.length) return [];

    const attachmentMetadata = item;
    const flatResults = await Promise.all(
      attachments.map((attachmentId) =>
        deliveryFor(attachmentId, 'flat', attachmentMetadata)
      )
    );
    const flatAttachment = flatResults.find((streams) => streams.length);
    if (flatAttachment?.length) return flatAttachment;

    const [mpegtsResults, fmp4Results] = await Promise.all([
      Promise.all(
        attachments.map((attachmentId) =>
          deliveryFor(attachmentId, 'hls.mpegts', attachmentMetadata)
        )
      ),
      Promise.all(
        attachments.map((attachmentId) =>
          deliveryFor(attachmentId, 'hls.fmp4', attachmentMetadata)
        )
      ),
    ]);
    const mpegtsAttachment = mpegtsResults.find((streams) => streams.length);
    if (mpegtsAttachment?.length) return mpegtsAttachment;
    const fmp4Attachment = fmp4Results.find((streams) => streams.length);
    if (fmp4Attachment?.length) return fmp4Attachment;

    // Preserve the normal empty stream response when the post is not a
    // playable parent or its delivery rights have expired.
    return [];
  }
  async getSubtitles(_type: string, itemId: string): Promise<Subtitle[]> {
    if (!this.userData.includeSubtitles) return [];
    const rawId = itemId.split(':').pop() || itemId;
    const ids = [rawId];

    // Stremio can ask for subtitles using the post id even though Floatplane
    // stores text tracks on the individual video attachment. Resolve that
    // parent once and query its bounded attachment list in parallel. Video
    // item ids continue to use the direct, single-request path.
    if (itemId.includes(':post:')) {
      try {
        const response = await this.api.post(rawId);
        const item = first(response, 'post', 'content', 'data') || response;
        ids.push(
          ...stringArray(first(item, 'videoAttachments', 'attachmentOrder')).slice(
            0,
            8
          )
        );
      } catch {
        // Preserve the direct post-id attempt below for accounts that expose
        // tracks on the parent object.
      }
    }

    const trackResponses = await Promise.allSettled(
      [...new Set(ids)].map((id) => this.api.textTracks(id))
    );
    const seen = new Set<string>();
    return trackResponses.flatMap((result) => {
      if (result.status !== 'fulfilled') return [];
      return array(result.value)
        .map((track, index) => {
          const trackUrl = url(first(track, 'url', 'src', 'uri'));
          if (!trackUrl || seen.has(trackUrl)) return null;
          seen.add(trackUrl);
          return {
            id: `fp-sub-${seen.size - 1}-${index}`,
            url: trackUrl,
            lang: text(first(track, 'language', 'lang', 'label'), 'und'),
          };
        })
        .filter((x): x is Subtitle => Boolean(x));
    });
  }
}
