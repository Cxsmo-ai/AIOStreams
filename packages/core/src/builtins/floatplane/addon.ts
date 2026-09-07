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

function text(value: unknown, fallback = ''): string {
  return String(value ?? fallback);
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
          id: 'floatplane-channels',
          name: 'Floatplane Channels',
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
      description: first(item, 'description', 'overview', 'summary'),
      releaseInfo: released ? text(released).slice(0, 10) : undefined,
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
    const creators = await this.creators();
    if (catalogId === 'floatplane-subscriptions')
      return this.userData.includeSubscriptions === false
        ? []
        : creators.map((x) => this.preview(x, 'creator'));
    if (catalogId === 'floatplane-channels') {
      if (this.userData.includeChannels === false) return [];
      const channels = (
        await Promise.all(
          creators.map(async (creator) => {
            const creatorId = idOf(creator);
            return array(await this.api.channels(creatorId)).map((channel) => ({
              ...channel,
              __floatplaneCreatorId: creatorId,
            }));
          })
        )
      ).flat();
      return channels.map((x) =>
        this.preview(
          x,
          'channel',
          `fp:channel:${x.__floatplaneCreatorId}:${idOf(x)}`
        )
      );
    }
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
            return {
              id: `fp:video:${videoId}`,
              title: title(video) || title(item),
              overview:
                first(video, 'description', 'overview') ||
                first(item, 'text', 'description', 'overview'),
              released:
                first(video, 'releaseDate') || first(item, 'releaseDate'),
              thumbnail: image(video) || image(item),
              available: first(video, 'isAccessible') !== false,
              streams: null,
            };
          } catch {
            return {
              id: `fp:video:${videoId || `${rawId}:${index}`}`,
              title: title(item),
              overview: first(item, 'text', 'description', 'overview'),
              released: first(item, 'releaseDate'),
              thumbnail: image(item),
              available: false,
              streams: null,
            };
          }
        })
      )
    ).filter(Boolean);
    return { ...this.preview(item), type: 'series', videos };
  }

  async getStreams(_type: string, itemId: string): Promise<Stream[]> {
    const rawId = itemId.split(':').pop() || itemId;
    const response = await this.api.delivery(rawId);
    const groups = array(first(response, 'groups'));
    const variants = groups.flatMap((group) =>
      array(first(group, 'variants')).map((variant) => ({ variant, group }))
    );
    const v3Streams = variants
      .map(({ variant, group }) => {
        if (
          first(variant, 'hidden') === true ||
          first(variant, 'enabled') === false
        )
          return null;
        const origins = array(first(variant, 'origins', 'origin'));
        const groupOrigins = array(first(group, 'origins', 'origin'));
        const origin = first(origins[0] || groupOrigins[0], 'url');
        const streamUrl = url(
          first(variant, 'url', 'playbackUrl', 'manifestUrl', 'hls'),
          origin
        );
        if (!streamUrl) return null;
        const quality = first(
          variant,
          'quality',
          'resolution',
          'label',
          'height'
        );
        return {
          url: streamUrl,
          name: `Floatplane${quality ? ` • ${quality}` : ''}`,
          title: title(variant),
          description: first(variant, 'codec', 'bitrate', 'type'),
        } as Stream;
      })
      .filter((x): x is Stream => Boolean(x));
    if (v3Streams.length) return v3Streams;

    // Older accounts may only expose the v2 CDN response. Normalize its
    // quality template so those accounts still receive every available level.
    const resource = first(response, 'resource');
    const data = first(resource, 'data');
    const template = first(resource, 'uri');
    const cdn = first(response, 'cdn');
    const params = first(data, 'qualityLevelParams');
    if (typeof template !== 'string' || !cdn || !params) return [];
    return array(first(data, 'qualityLevels'))
      .map((level) => {
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
