import type { ParsedStream, UserData } from '../db/schemas.js';
import { languageToCode } from '../utils/languages.js';
import { getTorboxRouteConfig } from './torbox-config.js';

export interface TorboxPresentation {
  service: 'TB';
  mode: 'native' | 'stream';
  target: 'native' | '1080p' | '720p';
  cacheState: 'cached' | 'uncached' | 'unknown';
  cacheAndPlay: boolean;
  audio: string;
  subtitle: string;
  nativeFallback: boolean;
}

export function decorateTorboxStreams(
  streams: ParsedStream[],
  userData: UserData
): ParsedStream[] {
  const route = getTorboxRouteConfig(userData);
  const globalCacheAndPlay = userData.cacheAndPlay;
  return streams.map((stream) => {
    if (stream.service?.id !== 'torbox') return stream;
    const type = stream.type === 'usenet' ? 'usenet' : 'torrent';
    const accountEnabled =
      type === 'torrent' ? route.torrentCacheAndPlay : route.usenetCacheAndPlay;
    const inheritedCacheAndPlay =
      globalCacheAndPlay?.enabled === true &&
      globalCacheAndPlay.streamTypes?.includes(type) === true;
    const cacheAndPlay = accountEnabled ?? inheritedCacheAndPlay;
    const quality = route.quality;
    stream.torbox = {
      service: 'TB',
      mode: quality === 'native' ? 'native' : 'stream',
      target: quality,
      cacheState:
        stream.service.cached === true
          ? 'cached'
          : stream.service.cached === false
            ? 'uncached'
            : 'unknown',
      cacheAndPlay,
      audio: route.audioLanguage,
      subtitle: route.subtitleLanguage,
      nativeFallback:
        quality !== 'native' &&
        (route.audioLanguage.toLowerCase() !== 'auto' ||
          !['auto', 'off'].includes(route.subtitleLanguage.toLowerCase())),
    };
    return stream;
  });
}

function preferenceCode(value: string): string {
  const lower = value.toLowerCase();
  if (lower === 'auto') return 'AUTO';
  if (lower === 'off') return 'OFF';
  return languageToCode(value) ?? value.toUpperCase();
}

export function torboxPresentationLines(
  presentation: TorboxPresentation
): string[] {
  let header: string;
  const target =
    presentation.target === 'native'
      ? 'NATIVE'
      : `${presentation.target.toUpperCase()} MAX`;
  if (presentation.cacheState === 'cached') {
    header =
      presentation.mode === 'native'
        ? '⚡ TB · NATIVE'
        : `⚡ TB · STREAM · ${target}`;
  } else if (
    presentation.cacheState === 'uncached' &&
    presentation.cacheAndPlay
  ) {
    header = `⬇ TB · CACHE & PLAY ${
      presentation.mode === 'native' ? '·' : '→'
    } ${target}`;
  } else if (presentation.cacheState === 'uncached') {
    header = `⬇ TB · DOWNLOAD · ${target}`;
  } else {
    header = `TB · ${presentation.mode === 'native' ? 'NATIVE' : `STREAM · ${target}`}`;
  }

  if (presentation.mode === 'native') return [header];
  const tracks = `🔊 ${preferenceCode(presentation.audio)} · 💬 ${preferenceCode(
    presentation.subtitle
  )}`;
  return [
    header,
    `${tracks}${
      presentation.nativeFallback ? ' · ↩ NATIVE IF TRACKS MISSING' : ''
    }`,
  ];
}

export function applyTorboxPresentation(
  stream: ParsedStream,
  formatted: { name: string; description?: string }
): { name: string; description: string } {
  if (!stream.torbox) {
    return { name: formatted.name, description: formatted.description ?? '' };
  }
  const lines = torboxPresentationLines(stream.torbox);
  const existing = formatted.description ?? '';
  const description = existing.startsWith(lines[0])
    ? existing
    : [...lines, existing].filter(Boolean).join('\n');
  const isTorrentClawUnarr =
    stream.addon?.preset?.type === 'torrentclaw' &&
    stream.type === 'usenet' &&
    /unarr/i.test(stream.indexer ?? '');
  return {
    name: isTorrentClawUnarr
      ? formatted.name.replace(/\bAIO\b/g, 'TB')
      : formatted.name,
    description,
  };
}
