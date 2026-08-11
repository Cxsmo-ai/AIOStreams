import type { UserData } from '../db/schemas.js';
import type { TorboxPlaybackQuality } from './torbox-client.js';

export interface TorboxRouteConfig {
  quality: TorboxPlaybackQuality;
  audioLanguage: string;
  subtitleLanguage: string;
  appendFilename: boolean;
  torrentCacheAndPlay?: boolean;
  usenetCacheAndPlay?: boolean;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

export function getTorboxRouteConfig(
  userData: Pick<UserData, 'services'>
): TorboxRouteConfig {
  const credentials =
    userData.services?.find((service) => service.id === 'torbox')
      ?.credentials ?? {};
  const quality = String(credentials.playbackQuality ?? 'native');
  return {
    quality: ['native', '1080p', '720p'].includes(quality)
      ? (quality as TorboxPlaybackQuality)
      : 'native',
    audioLanguage: credentials.audioLanguage || 'auto',
    subtitleLanguage: credentials.subtitleLanguage || 'off',
    appendFilename: parseBoolean(credentials.appendFilename) === true,
    torrentCacheAndPlay: parseBoolean(credentials.torrentCacheAndPlay),
    usenetCacheAndPlay: parseBoolean(credentials.usenetCacheAndPlay),
  };
}
