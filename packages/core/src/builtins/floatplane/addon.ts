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
  return url(
    first(
      item,
      'thumbnail',
      'thumbnailUrl',
      'poster',
      'posterUrl',
      'image',
      'imageUrl',
      'background'
    )
  );
}
function title(item: any): string {
  return text(
    first(item, 'title', 'name', 'displayName'),
    'Floatplane content'
  );
}
function idOf(item: any): string {
  return text(first(item, 'id', 'guid', 'contentId', 'postId'));
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

  private preview(item: any, kind = 'post'): MetaPreview {
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
      id: `fp:${kind}:${idOf(item)}`,
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
    return array(await this.api.subscriptions());
  }

  async getCatalog(
    _type: string,
    catalogId: string,
    extras?: string
  ): Promise<MetaPreview[]> {
    const params = new URLSearchParams(extras || '');
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
          creators.map(async (creator) =>
            array(await this.api.channels(idOf(creator)))
          )
        )
      ).flat();
      return channels.map((x) => this.preview(x, 'channel'));
    }
    const posts = (
      await Promise.all(
        creators.map(async (creator) =>
          array(await this.api.creatorContent(idOf(creator)))
        )
      )
    ).flat();
    const skip = Math.max(0, Number(params.get('skip') || 0));
    return posts.slice(skip, skip + 100).map((x) => this.preview(x));
  }

  async getMeta(_type: string, itemId: string): Promise<Meta> {
    const [, kind, rawId] = itemId.split(':');
    if (kind === 'creator' || kind === 'channel') {
      const data =
        kind === 'creator'
          ? await this.api.discover()
          : await this.api.channels(rawId);
      const item = array(data).find((x) => idOf(x) === rawId) || {};
      return { ...this.preview(item, kind), type: 'series', videos: [] };
    }
    const response = await this.api.post(rawId);
    const item = first(response, 'post', 'content', 'data') || response;
    const videos = array(
      first(item, 'videos', 'video', 'attachments', 'media')
    ).map((video, index) => ({
      id: `fp:video:${text(first(video, 'id', 'guid', 'contentId'), `${rawId}:${index}`)}`,
      title: title(video),
      overview: first(video, 'description', 'overview'),
      released: first(video, 'publishedAt', 'createdAt', 'releaseDate'),
      thumbnail: image(video),
      available: true,
      streams: null,
    }));
    return { ...this.preview(item), type: 'series', videos };
  }

  async getStreams(_type: string, itemId: string): Promise<Stream[]> {
    const rawId = itemId.split(':').pop() || itemId;
    const response = await this.api.delivery(rawId);
    return array(response)
      .map((variant) => {
        const streamUrl = url(
          first(variant, 'url', 'playbackUrl', 'manifestUrl', 'hls')
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
