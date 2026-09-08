import {
  Manifest,
  Meta,
  MetaPreview,
  Stream,
  Subtitle,
} from '../../db/index.js';
import {
  FloatplaneAuthState,
  FloatplaneClient,
  array,
  first,
  url,
} from './api.js';
import { Buffer } from 'node:buffer';
import {
  containsAv1,
  filterPlayableFloatplaneMedia,
  filterPlayableFloatplanePlaylists,
} from './codec.js';

const CHANNEL_CATALOG_PREFIX = 'floatplane-channel-';

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
    'caption'
  );
  const nested = raw && typeof raw === 'object' ? first(raw, 'text', 'value') : raw;
  const value = typeof nested === 'string' ? nested : fallback;
  if (!value) return undefined;
  return value
    .replace(/<[^>]+>/g, ' ')
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
    variantMediaValue(variant, 'audio', 'sampleRate', 'samplerate', 'samplingRate')
  );
  const channels = numberValue(
    variantMediaValue(variant, 'audio', 'channelCount', 'channels', 'channelLayout')
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
  return bitrate * 1_000_000 + sampleRate * 100 + channels * 10_000 + codecWeight;
}
function audioDescription(variant: any): string[] {
  const codec = text(
    variantMediaValue(variant, 'audio', 'codec', 'audioCodec', 'format')
  );
  const bitrate = numberValue(
    variantMediaValue(variant, 'audio', 'bitrate', 'bitRate', 'bandwidth', 'bitrateKbps')
  );
  const channels = numberValue(
    variantMediaValue(variant, 'audio', 'channelCount', 'channels', 'channelLayout')
  );
  return [
    codec && `audio ${codec}`,
    bitrate > 0 && `audio ${Math.round(bitrate)} kbps`,
    channels > 0 && `audio ${channels}ch`,
  ].filter((value): value is string => Boolean(value));
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
  return text(
    first(item, 'title', 'name', 'displayName'),
    'Floatplane content'
  );
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
      logo: 'https://floatplane.com/favicon.ico',
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
              ...(durationSeconds(first(video, 'duration', 'durationSeconds', 'durationMs')) !== undefined
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
      (typeof firstVideo?.runtime === 'string' ? firstVideo.runtime : undefined);
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
      outputKind: string
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
          return {
            url: streamUrl,
            name: `Floatplane${quality ? ` • ${quality}` : ''}`,
            title: title(variant),
            description:
              [
                technicalVideo && `video ${technicalVideo}`,
                ...technicalAudio,
              ].join(' • ') ||
              first(variant, 'codec', 'bitrate', 'type'),
          } as Stream;
        })
        .filter((x): x is Stream => Boolean(x));
      if (v3Streams.length)
        return outputKind === 'flat'
          ? filterPlayableFloatplaneMedia(v3Streams)
          : filterPlayableFloatplanePlaylists(v3Streams);

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
          return streamUrl
            ? ({
                url: streamUrl,
                name: `Floatplane${first(level, 'label') ? ` • ${first(level, 'label')}` : ''}`,
                title: text(first(level, 'label'), name),
              } as Stream)
            : null;
        })
        .filter((x): x is Stream => Boolean(x));
      return filterPlayableFloatplanePlaylists(legacyStreams);
    };

    const deliveryFor = async (
      contentId: string,
      outputKind = 'hls.fmp4'
    ): Promise<Stream[]> => {
      try {
        return streamsFromDelivery(
          await this.api.delivery(contentId, outputKind),
          outputKind
        );
      } catch {
        return [];
      }
    };

    // Flat MP4 is the fastest and most broadly compatible Floatplane output.
    // It is still ranged-probed before exposure, so moving it first does not
    // trade away signed-link validation or the direct-CDN playback contract.
    const direct = await deliveryFor(rawId, 'flat');
    if (direct.length) return direct;

    // fMP4 is efficient but some clients cannot access Floatplane's
    // authenticated watchKey endpoint. MPEG-TS carries the same direct CDN
    // delivery without that key exchange, so use it as a compatibility
    // fallback before trying fMP4 and parent-post attachment ids.
    const transportFallback = await deliveryFor(rawId, 'hls.mpegts');
    if (transportFallback.length) return transportFallback;

    const fmp4Fallback = await deliveryFor(rawId, 'hls.fmp4');
    if (fmp4Fallback.length) return fmp4Fallback;

    // Floatplane also exposes a signed direct-media representation. It is the
    // last-resort path for clients that cannot obtain the HLS watch key.
    // Stremio clients differ on whether they request the post id or the
    // attachment id. Resolve the parent post so both request shapes play.
    try {
      const response = await this.api.post(rawId);
      const item = first(response, 'post', 'content', 'data') || response;
      const attachments = stringArray(
        first(item, 'videoAttachments', 'attachmentOrder')
      );
      for (const attachmentId of attachments) {
        const streams =
          (await deliveryFor(attachmentId, 'flat'))
            .concat(await deliveryFor(attachmentId, 'hls.mpegts'))
            .concat(await deliveryFor(attachmentId, 'hls.fmp4'));
        if (streams.length) return streams;
      }
    } catch {
      // Preserve the normal empty stream response when the post is not a
      // playable parent or has expired delivery rights.
    }
    return [];
  }
  async getSubtitles(_type: string, itemId: string): Promise<Subtitle[]> {
    if (!this.userData.includeSubtitles) return [];
    const rawId = itemId.split(':').pop() || itemId;
    const response = await this.api.textTracks(rawId);
    return array(response)
      .map((track, index) => {
        const trackUrl = url(first(track, 'url', 'src', 'uri'));
        return trackUrl
          ? {
              id: `fp-sub-${index}`,
              url: trackUrl,
              lang: text(first(track, 'language', 'lang', 'label'), 'und'),
            }
          : null;
      })
      .filter((x): x is Subtitle => Boolean(x));
  }
}
