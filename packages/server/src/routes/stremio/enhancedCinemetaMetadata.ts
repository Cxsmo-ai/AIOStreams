import {
  getTorrentClawSeasonMetadata,
  getTorrentClawServiceConfig,
  type Meta,
  type TorrentClawSeason,
  type UserData,
} from '@aiostreams/core';

const SUPPORTED_CINEMETA_RESOURCES = new Set([
  'catalog',
  'meta',
  'addon_catalog',
]);

export function filterEnhancedCinemetaResources(
  resources: unknown[]
): unknown[] {
  return resources.filter((resource) => {
    const name =
      typeof resource === 'string'
        ? resource
        : resource && typeof resource === 'object' && 'name' in resource
          ? resource.name
          : undefined;
    return typeof name === 'string' && SUPPORTED_CINEMETA_RESOURCES.has(name);
  });
}

export function mergeTorrentClawEpisodeMetadata(
  meta: Meta,
  seasons: TorrentClawSeason[] | undefined
): Meta {
  if (!seasons?.length) return meta;

  const episodeByNumber = new Map(
    seasons.flatMap((season) =>
      (season.episodes || []).map(
        (episode) => [`${season.season}:${episode.episode}`, episode] as const
      )
    )
  );
  const videos = meta.videos?.map((video) => {
    const episode =
      video.season != null && video.episode != null
        ? episodeByNumber.get(`${video.season}:${video.episode}`)
        : undefined;
    if (!episode) return video;
    return {
      ...video,
      title: video.title || episode.name || undefined,
      overview: video.overview || episode.overview || undefined,
      released: video.released || episode.airDate || undefined,
      thumbnail: video.thumbnail || episode.stillUrl || undefined,
      runtime: (video as Record<string, unknown>).runtime ?? episode.runtime,
      imdbRating:
        (video as Record<string, unknown>).imdbRating ?? episode.voteAverage,
    };
  });

  return {
    ...meta,
    ...(videos ? { videos } : {}),
    // Passthrough metadata carries season counts/posters for clients that can
    // consume them without changing Cinemeta IDs or its existing episode list.
    seasons: seasons.map(({ season, episodeCount, posterUrl }) => ({
      season,
      episodeCount,
      ...(posterUrl ? { posterUrl } : {}),
    })),
  } as Meta;
}

/** Enrich Cinemeta using the TorrentClaw service credential saved on this profile. */
export async function enrichEnhancedCinemetaMeta(
  meta: Meta,
  type: string,
  id: string,
  userData: UserData,
  fetchSeasons: typeof getTorrentClawSeasonMetadata = getTorrentClawSeasonMetadata
): Promise<Meta> {
  if (type !== 'series') return meta;

  const service = getTorrentClawServiceConfig(userData);
  if (!service?.apiKey) return meta;

  try {
    const seasons = await fetchSeasons({
      id,
      apiKey: service.apiKey,
      timeout: 2_500,
    });
    return mergeTorrentClawEpisodeMetadata(meta, seasons);
  } catch {
    // Enhanced metadata is additive; upstream Cinemeta remains usable if
    // TorrentClaw auth or its optional episode endpoint is unavailable.
    return meta;
  }
}
