import {
  Stremio,
  Meta,
  MetaPreview,
  MetaVideo,
  Extras,
  Manifest,
} from '../../lib/stremio';
import {
  canEncodeStremioId,
  encodeStremioId,
  tryDecodeStremioLocalId,
} from '../../lib/stremio-id';

class Provider implements CustomSource {
  private readonly MANIFEST_KEY = 'aiostreams.manifest';
  private readonly LOOKUP_KEY = 'aiostreams.meta.lookup';
  private readonly PAGE_SIZE_KEY = 'aiostreams.catalog.pagesize';

  manifestUrl = '{{manifestUrl}}';
  catalogId = '{{catalogId}}';
  catalogType = '{{catalogType}}';

  getSettings(): Settings {
    return {
      supportsAnime: true,
      supportsManga: false,
    };
  }

  async listAnime(
    search: string,
    page: number,
    perPage: number
  ): Promise<ListResponse<$app.AL_BaseAnime>> {
    const stremio = this.getStremio();
    const manifest = await this.getManifest();
    const catalog = manifest.catalogs?.find(
      (c) => c.id === this.catalogId && c.type === this.catalogType
    );
    if (!catalog) return { media: [], page, total: 0, totalPages: 0 };

    const trimmedSearch = search?.trim() ?? '';
    const searchExtra = catalog.extra?.find((e) => e.name === 'search');

    if (!searchExtra && trimmedSearch)
      return { media: [], page, total: 0, totalPages: 0 };
    if (searchExtra?.isRequired && !trimmedSearch)
      return { media: [], page, total: 0, totalPages: 0 };

    const supportsSkip = catalog.extra?.some((e) => e.name === 'skip');

    const cacheKey = `stremio_catalog_${this.catalogType}_${this.catalogId}_${trimmedSearch}`;

    // $store may return a proxy/serialized object where array.push() doesn't mutate
    // the stored reference. Copy everything into plain local variables first.
    const storeData = $store.getOrSet(cacheKey, () => ({
      items: [] as Meta[],
      seenIds: [] as string[],
      lastSkip: 0,
      reachedEnd: false,
    }));
    const items: Meta[] = Array.isArray(storeData.items)
      ? [...(storeData.items as Meta[])]
      : [];
    const seenIds: Set<string> = new Set(
      Array.isArray(storeData.seenIds) ? (storeData.seenIds as string[]) : []
    );
    let lastSkip: number =
      typeof storeData.lastSkip === 'number' ? storeData.lastSkip : 0;
    let reachedEnd: boolean = !!storeData.reachedEnd;

    const startIdx = (page - 1) * perPage;
    const endIdx = startIdx + perPage;
    console.log(
      `Requesting page ${page} (items ${startIdx} to ${endIdx}) for search "${trimmedSearch}"`
    );

    const MAX_NO_PROGRESS = 10;
    let noProgressCount = 0;

    // Fetch more items if we don't have enough to fulfill the page,
    // and we haven't reached the end of the catalog yet.
    while (!reachedEnd && items.length < endIdx) {
      const extras: Record<string, string | number> = {};
      if (trimmedSearch) extras.search = trimmedSearch;
      if (lastSkip > 0) extras.skip = lastSkip;

      try {
        console.log(
          `Fetching from Stremio with extras: ${JSON.stringify(extras)} (current cache size: ${items.length})`
        );
        const response = await stremio.getCatalog(
          this.catalogType,
          this.catalogId,
          extras
        );
        const batch = response.metas ?? [];

        console.log(`Received ${batch.length} items from Stremio`);

        if (batch.length === 0) {
          reachedEnd = true;
        } else {
          const newItems = batch.filter((m) => m.id && !seenIds.has(m.id));
          if (newItems.length === 0) {
            noProgressCount++;
            console.log(
              `All ${batch.length} items were duplicates (no-progress streak: ${noProgressCount}/${MAX_NO_PROGRESS})`
            );
            if (noProgressCount >= MAX_NO_PROGRESS) {
              console.log(
                'Too many consecutive duplicate batches, stopping fetch'
              );
              reachedEnd = true;
            }
          } else {
            noProgressCount = 0;
            for (const m of newItems) seenIds.add(m.id);
            items.push(...newItems);
            console.log(
              `Added ${newItems.length} new items (${batch.length - newItems.length} duplicates skipped)`
            );
          }
          lastSkip += batch.length;

          // If the addon doesn't support skipping, we can only fetch the first batch
          if (!supportsSkip) reachedEnd = true;
        }
      } catch {
        reachedEnd = true;
        break;
      }

      // Save updated state back to the store for subsequent page requests
      $store.set(cacheKey, {
        items,
        seenIds: Array.from(seenIds),
        lastSkip,
        reachedEnd,
      });
    }

    // Extract exactly the slice Seanime requested
    console.log(
      `Cache has ${items.length} items, returning slice ${startIdx} to ${endIdx}`
    );
    const slice = items.slice(startIdx, endIdx);
    console.log(`Slice contains ${slice.length} items`);
    const media: $app.AL_BaseAnime[] = [];

    for (const meta of slice) {
      const entry = this.metaToBaseAnime(meta);
      if (entry) media.push(entry);
    }

    // Determine pagination state for Seanime
    const hasMore = !reachedEnd || items.length > endIdx;
    console.log(
      `Has more: ${hasMore}, reachedEnd: ${reachedEnd}, cache size: ${items.length}, requested endIdx: ${endIdx}`
    );
    const total = items.length + (hasMore ? perPage : 0);
    const totalPages = hasMore ? page + 1 : page;

    console.log(
      `Returning page ${page} with ${media.length} items, total ${total}, totalPages ${totalPages}`
    );
    console.log('Full media list for this page:', media);

    return { media, page, total, totalPages };
  }

  async getAnime(ids: number[]): Promise<$app.AL_BaseAnime[]> {
    const results = await Promise.all(
      ids.map((id) => this.fetchMeta(id).catch(() => null))
    );
    const out: $app.AL_BaseAnime[] = [];
    for (const meta of results) {
      if (!meta) continue;
      const base = this.metaToBaseAnime(meta);
      if (base) out.push(base);
    }
    return out;
  }

  async getAnimeWithRelations(id: number): Promise<$app.AL_CompleteAnime> {
    const meta = await this.fetchMeta(id);
    if (!meta) throw new Error(`No meta for id ${id}`);
    const base = this.metaToBaseAnime(meta);
    if (!base) throw new Error(`Could not convert meta for id ${id}`);
    return { ...base, relations: { edges: [] } };
  }

  async getAnimeDetails(
    _id: number
  ): Promise<$app.AL_AnimeDetailsById_Media | null> {
    return null;
  }

  async getAnimeMetadata(
    id: number
  ): Promise<$app.Metadata_AnimeMetadata | null> {
    const meta = await this.fetchMeta(id);
    if (!meta) return null;
    return this.metaToAnimeMetadata(meta);
  }

  async getManga(_ids: number[]): Promise<$app.AL_BaseManga[]> {
    return [];
  }

  async getMangaDetails(
    _id: number
  ): Promise<$app.AL_MangaDetailsById_Media | null> {
    return null;
  }

  async listManga(
    _search: string,
    page: number,
    _perPage: number
  ): Promise<ListResponse<$app.AL_BaseManga>> {
    return { media: [], page, total: 0, totalPages: 1 };
  }

  // ---- helpers ---------------------------------------------------------

  private getStremio(): Stremio {
    return new Stremio(this.manifestUrl);
  }

  private async getManifest(): Promise<Manifest> {
    const cached = $store.get(this.MANIFEST_KEY) as Manifest | undefined;
    if (cached) return cached;
    const manifest = await this.getStremio().getManifest();
    $store.set(this.MANIFEST_KEY, manifest);
    return manifest;
  }

  // For known Stremio ID formats (imdb, kitsu, mal, …) we use the deterministic
  // stremio-id encoding so the ID survives across $store resets. For everything
  // else we fall back to a FNV-1a hash stored in $store.
  private stremioIdToLocalId(type: string, id: string): number {
    if (canEncodeStremioId(id)) return encodeStremioId(id, type);
    const hash = this.hashStremioKey(type, id);
    this.storeLookupEntry(hash, type, id);
    return hash;
  }

  private async fetchMeta(localId: number): Promise<Meta | null> {
    const decoded = tryDecodeStremioLocalId(localId);
    let type: string;
    let id: string;
    if (decoded !== null) {
      type = decoded.metaType;
      id = decoded.stremioId;
    } else {
      const entry = this.resolveLookup(localId);
      if (!entry) return null;
      type = entry.type;
      id = entry.id;
    }
    try {
      const response = await this.getStremio().getMeta(type, id);
      return response?.meta ?? null;
    } catch {
      return null;
    }
  }

  private hashStremioKey(type: string, id: string): number {
    const key = `${type}\0${id}`;
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i) & 0xff;
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
  }

  private getLookup(): Record<string, { type: string; id: string }> {
    return (
      ($store.get(this.LOOKUP_KEY) as
        | Record<string, { type: string; id: string }>
        | undefined) ?? {}
    );
  }

  private storeLookupEntry(hash: number, type: string, id: string): void {
    const lookup = this.getLookup();
    lookup[String(hash)] = { type, id };
    $store.set(this.LOOKUP_KEY, lookup);
  }

  private resolveLookup(localId: number): { type: string; id: string } | null {
    return this.getLookup()[String(localId)] ?? null;
  }

  private metaToBaseAnime(meta: MetaPreview | Meta): $app.AL_BaseAnime | null {
    if (!meta.id) return null;
    const localId = this.stremioIdToLocalId(meta.type, meta.id);

    const type = meta.type;
    const title = meta.name ?? meta.id;
    const description = meta.description ?? '';
    const poster = meta.poster ?? '';
    const banner =
      ('background' in meta ? (meta as Meta).background : null) ?? poster;
    const year = this.parseYear(meta.releaseInfo);
    const rating = this.parseImdbRating(meta.imdbRating);
    const { mains, specials: _specials } = this.classifyVideos(meta);
    // Only expose main episodes in the count - seanime's discrepancy-based
    // specials display is not reliable for custom sources (specials appear as
    // "Episode 0" or in reversed order). Specials metadata is still built in
    // metaToAnimeMetadata and mapped in buildEpisodeMappings for future use.
    const totalEpisodes = mains.length;
    const isSingleMovie = totalEpisodes === 0 && type === 'movie';

    const metaDetails = {
      id: meta.id,
      imdb_id: meta.imdb_id,
      type: meta.type,
      episodes: this.buildEpisodeMappings(meta),
    };
    const encodedMetaDetails = CryptoJS.enc.Base64.stringify(
      CryptoJS.enc.Utf8.parse(JSON.stringify(metaDetails))
    );

    return {
      id: localId,
      siteUrl: encodedMetaDetails,
      title: {
        userPreferred: title ?? meta.id,
        english: title ?? meta.id,
        romaji: title ?? meta.id,
        native: title ?? meta.id,
      },
      coverImage: {
        large: poster,
        medium: poster,
        extraLarge: poster,
        color: '',
      },
      bannerImage: banner,
      description,
      genres: meta.genres ?? [],
      meanScore: rating,
      synonyms: [],
      status: 'FINISHED',
      episodes: isSingleMovie ? 1 : totalEpisodes || undefined,
      type: 'ANIME',
      format: isSingleMovie ? 'MOVIE' : 'TV',
      seasonYear: year,
      isAdult: false,
      startDate: {
        year,
        month: undefined,
        day: undefined,
      },
    } as $app.AL_BaseAnime;
  }

  private metaToAnimeMetadata(meta: Meta): $app.Metadata_AnimeMetadata {
    const title = meta.name ?? meta.id;
    const mappings = this.buildMappings(meta.id);
    const { mains, specials } = this.classifyVideos(meta);

    if (mains.length === 0 && specials.length === 0) {
      return {
        titles: { en: title ?? '' },
        episodes: { '1': this.buildMovieEpisode(meta, title ?? meta.id) },
        episodeCount: 1,
        specialCount: 0,
        mappings,
      };
    }

    const episodes: Record<string, $app.Metadata_EpisodeMetadata> = {};
    mains.forEach((v, idx) => {
      const absolute = idx + 1;
      episodes[String(absolute)] = this.buildEpisode(v, absolute);
    });
    specials.forEach((v, idx) => {
      const key = `S${idx + 1}`;
      episodes[key] = this.buildEpisode(v, idx + 1, { key, isSpecial: true });
    });

    return {
      titles: { en: title ?? '' },
      episodes,
      episodeCount: mains.length,
      specialCount: specials.length,
      mappings,
    };
  }

  private buildEpisode(
    video: MetaVideo,
    absolute: number,
    opts: { key?: string; isSpecial?: boolean } = {}
  ): $app.Metadata_EpisodeMetadata {
    const parseDuration = (runtime: unknown): number | undefined => {
      if (runtime === undefined) return undefined;
      if (typeof runtime === 'number') return runtime;
      if (typeof runtime === 'string') {
        const match = runtime.match(/(?:(\d+)h)?\s*(?:(\d+)m)?/);
        if (match) {
          const hours = parseInt(match[1] ?? '0');
          const minutes = parseInt(match[2] ?? '0');
          return hours * 60 + minutes;
        }
      }
      return undefined;
    };
    const image = video.thumbnail ?? '';
    const title =
      video.title ?? video.name ?? `Episode ${video.episode ?? absolute}`;
    const overview = video.overview ?? '';
    const runtime = parseDuration(video.runtime);
    return {
      anidbId: 0,
      tvdbId: 0,
      anidbEid: 0,
      title,
      image,
      airDate: video.released ?? '',
      length: runtime ?? 0,
      summary: overview,
      overview,
      episodeNumber: absolute,
      episode: String(absolute),
      seasonNumber: opts.isSpecial ? 0 : (video.season ?? 1),
      absoluteEpisodeNumber: absolute,
      hasImage: !!image,
    } as $app.Metadata_EpisodeMetadata;
  }

  private buildMovieEpisode(
    meta: Meta,
    title: string
  ): $app.Metadata_EpisodeMetadata {
    const image = meta.background ?? meta.poster ?? '';
    const description = meta.description ?? '';
    const released =
      typeof (meta as Record<string, unknown>).released === 'string'
        ? ((meta as Record<string, unknown>).released as string)
        : '';
    return {
      anidbId: 0,
      tvdbId: 0,
      anidbEid: 0,
      title,
      image,
      airDate: released,
      length: 0,
      summary: description,
      overview: description,
      episodeNumber: 1,
      episode: '1',
      seasonNumber: 1,
      absoluteEpisodeNumber: 1,
      hasImage: !!image,
    };
  }

  private buildMappings(stremioId: string): $app.Metadata_AnimeMappings {
    const mappings: $app.Metadata_AnimeMappings = {};
    if (!stremioId) return mappings;
    const num = (prefix: string) => {
      const n = parseInt(stremioId.slice(prefix.length));
      return isNaN(n) ? undefined : n;
    };
    if (/^tt\d+$/.test(stremioId)) {
      mappings.imdbId = stremioId;
    } else if (stremioId.startsWith('kitsu:')) {
      mappings.kitsuId = num('kitsu:');
    } else if (stremioId.startsWith('mal:')) {
      mappings.malId = num('mal:');
    } else if (stremioId.startsWith('anilist:')) {
      mappings.anilistId = num('anilist:');
    } else if (stremioId.startsWith('tmdb:')) {
      mappings.themoviedbId = stremioId.slice('tmdb:'.length);
    } else if (stremioId.startsWith('tvdb:')) {
      mappings.thetvdbId = num('tvdb:');
    } else if (stremioId.startsWith('anidb:')) {
      mappings.anidbId = num('anidb:');
    }
    return mappings;
  }

  // Classify a meta's videos into mains and specials regardless of meta type.
  // A video is a special when its season is 0; everything else is a main. If
  // season/episode are present we sort by them, so the resulting absolute
  // numbering 1..N (mains) and 1..M (specials) stays stable across calls.
  private classifyVideos(meta: MetaPreview | Meta): {
    mains: MetaVideo[];
    specials: MetaVideo[];
  } {
    const videos = (meta as Meta).videos;
    if (!videos?.length) return { mains: [], specials: [] };
    const withId = videos.filter((v) => !!v.id);
    const sortByEp = (a: MetaVideo, b: MetaVideo) => {
      const sa = a.season ?? 1;
      const sb = b.season ?? 1;
      if (sa !== sb) return sa - sb;
      return (a.episode ?? 0) - (b.episode ?? 0);
    };
    const mains = withId.filter((v) => (v.season ?? 1) !== 0).sort(sortByEp);
    const specials = withId
      .filter((v) => v.season === 0)
      .sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));
    return { mains, specials };
  }

  // Maps the AniDB-style episode key Seanime uses ("1", "2", …, "S1", "S2", …)
  // to the original Stremio video id, so plugins can forward the exact id back
  // to the addon when fetching streams. Keys mirror metaToAnimeMetadata so the
  // plugin can look up by either episode.aniDBEpisode or episode.episodeNumber.
  private buildEpisodeMappings(
    meta: MetaPreview | Meta
  ): Record<string, string> {
    const { mains, specials } = this.classifyVideos(meta);
    const mapping: Record<string, string> = {};
    mains.forEach((v, idx) => {
      mapping[String(idx + 1)] = v.id;
    });
    specials.forEach((v, idx) => {
      mapping[`S${idx + 1}`] = v.id;
    });
    return mapping;
  }

  private parseImdbRating(rating: string | number | null | undefined): number {
    if (rating === undefined || rating === null) return 0;
    const n = typeof rating === 'number' ? rating : parseFloat(rating);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 10);
  }

  private parseYear(
    info: string | number | null | undefined
  ): number | undefined {
    if (info === undefined || info === null) return undefined;
    const match = String(info).match(/\d{4}/);
    return match ? Number(match[0]) : undefined;
  }
}

(globalThis as { Provider?: typeof Provider }).Provider = Provider;
