import type { Subtitle, UserData } from '../../db/schemas.js';
import type { AIOStreamsContext } from '../../main/types.js';
import { isUnsafeRemoteUrl } from '../../utils/url-safety.js';

type SubtitleConversionUrlFactory = (payload: {
  apiKey: string;
  subtitleUrl: string;
}) => string;

const OPEN_SUBTITLES_SOURCE_PATTERN = /open[\s._-]*subtitles/i;

function isOpenSubtitlesSource(
  subtitle: Subtitle,
  sourceAddonIdentifier?: string
): boolean {
  if (
    sourceAddonIdentifier &&
    OPEN_SUBTITLES_SOURCE_PATTERN.test(sourceAddonIdentifier)
  ) {
    return true;
  }

  // Addon wrappers do not consistently retain their source identifier on the
  // subtitle object. Respect explicit origin metadata when a provider does.
  const record = subtitle as Subtitle & Record<string, unknown>;
  return ['source', 'provider', 'addon', 'id', 'url'].some((key) => {
    const value = record[key];
    return (
      typeof value === 'string' && OPEN_SUBTITLES_SOURCE_PATTERN.test(value)
    );
  });
}

function canonicalSubtitleFormat(value: string): string | undefined {
  const normalized = value
    .trim()
    .toLowerCase()
    .split(';', 1)[0]
    ?.trim()
    .replace(/^\./, '');
  if (!normalized) return undefined;
  const direct: Record<string, string> = {
    ass: 'ass',
    ssa: 'ssa',
    sub: 'sub',
    srt: 'srt',
    subrip: 'srt',
    vtt: 'vtt',
    webvtt: 'vtt',
  };
  if (direct[normalized]) return direct[normalized];
  const mime =
    /^(?:text|application)\/(?:x-)?(ass|ssa|sub|srt|subrip|vtt|webvtt)$/.exec(
      normalized
    );
  if (!mime) return undefined;
  return direct[mime[1]!];
}

function subtitleFormatMetadata(subtitle: Record<string, unknown>): string[] {
  return [
    'format',
    'type',
    'mimeType',
    'contentType',
    'codec',
    'extension',
  ].flatMap((key) => {
    const value = subtitle[key];
    return typeof value === 'string' && value.trim() ? [value.trim()] : [];
  });
}

function extensionOf(value: string): string | undefined {
  let pathname = value;
  try {
    pathname = new URL(value).pathname;
  } catch {
    pathname = value.split(/[?#]/, 1)[0] ?? value;
  }
  const lastSlash = Math.max(
    pathname.lastIndexOf('/'),
    pathname.lastIndexOf('\\')
  );
  let filename = pathname.slice(lastSlash + 1);
  try {
    const decodedFilename = decodeURIComponent(filename);
    if (!decodedFilename.includes('/') && !decodedFilename.includes('\\')) {
      filename = decodedFilename;
    }
  } catch {
    // Keep the original terminal component; malformed escapes are non-fatal.
  }
  return /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
}

/** Only formats supported by Deepbrid's player-side subtitle converter. */
export function shouldConvertDeepbridSubtitleToWebVtt(
  subtitle: Pick<Subtitle, 'url'> & Record<string, unknown>
): boolean {
  const metadata = subtitleFormatMetadata(subtitle);
  const filenameMetadata = ['filename', 'fileName'].flatMap((key) => {
    const value = subtitle[key];
    return typeof value === 'string' && value.trim() ? [value.trim()] : [];
  });
  const urlExtension = extensionOf(subtitle.url);
  const metadataExtensions = filenameMetadata
    .map(extensionOf)
    .filter((extension): extension is string => Boolean(extension));
  const declaredFormats = metadata
    .map(canonicalSubtitleFormat)
    .filter((format): format is string => Boolean(format));
  const allHints = [
    ...declaredFormats,
    ...(urlExtension ? [urlExtension] : []),
    ...metadataExtensions,
  ];

  // Prefer a known native format when sources provide conflicting hints.
  // In particular, never turn an SRT/VTT URL into a conversion request just
  // because a display name happens to mention another subtitle format.
  if (allHints.some((value) => ['srt', 'vtt'].includes(value))) {
    return false;
  }

  const declaredFormat = declaredFormats.some((format) =>
    ['ass', 'ssa', 'sub'].includes(format)
  );
  const metadataExtension = metadataExtensions.some((extension) =>
    ['ass', 'ssa', 'sub'].includes(extension)
  );
  return (
    ['ass', 'ssa', 'sub'].includes(urlExtension ?? '') ||
    declaredFormat ||
    metadataExtension
  );
}

/**
 * Optionally route compatible subtitles through Deepbrid's player converter.
 * OpenSubtitles sources are intentionally returned byte-for-byte unchanged.
 */
export function applyDeepbridSubtitleConversion(
  ctx: Pick<AIOStreamsContext, 'addons' | 'userData'>,
  subtitles: Subtitle[],
  sourceAddonIdentifier?: string,
  createConversionUrl?: SubtitleConversionUrlFactory
): Subtitle[] {
  const enabled = ctx.addons.some(
    (addon) =>
      addon.enabled &&
      addon.identifier === 'deepbrid-usenet' &&
      addon.preset.options.convertSubtitlesToWebVtt === true
  );
  const service = (ctx.userData as UserData).services?.find(
    (item) =>
      item.id === 'deepbrid' &&
      item.enabled !== false &&
      Boolean(item.credentials.apiKey?.trim())
  );
  const apiKey = service?.credentials.apiKey?.trim();
  if (!enabled || !apiKey || !createConversionUrl) return subtitles;

  return subtitles.map((subtitle) => {
    if (isOpenSubtitlesSource(subtitle, sourceAddonIdentifier)) return subtitle;
    if (!shouldConvertDeepbridSubtitleToWebVtt(subtitle)) return subtitle;
    try {
      const source = new URL(subtitle.url);
      if (
        source.protocol !== 'https:' ||
        source.username ||
        source.password ||
        isUnsafeRemoteUrl(source.toString())
      ) {
        return subtitle;
      }
      return {
        ...subtitle,
        id: `${subtitle.id}-deepbrid-vtt`,
        url: createConversionUrl({
          apiKey,
          subtitleUrl: subtitle.url,
        }),
        format: 'vtt',
      };
    } catch {
      // Invalid/unsafe source URLs remain available in their original form.
      return subtitle;
    }
  });
}
