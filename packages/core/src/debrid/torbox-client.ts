import { normaliseLanguage } from '../utils/languages.js';

export const TORBOX_API_BASE_URL = 'https://api.torbox.app';

export type TorboxPlaybackQuality = 'native' | '1080p' | '720p';
export type TorboxMediaType = 'torrent' | 'usenet' | 'webdownload';
export type TorboxCredentialSource = 'legacy' | 'device_code';

export interface TorboxPlaybackPreferences {
  quality: TorboxPlaybackQuality;
  audioLanguage: 'auto' | string;
  subtitleLanguage: 'off' | 'auto' | string;
  appendFilename: boolean;
}

export interface TorboxCredentialPayload extends TorboxPlaybackPreferences {
  token: string;
  credentialSource: TorboxCredentialSource;
  torrentCacheAndPlay?: boolean;
  usenetCacheAndPlay?: boolean;
}

export const DEFAULT_TORBOX_PLAYBACK_PREFERENCES: TorboxPlaybackPreferences = {
  quality: 'native',
  audioLanguage: 'auto',
  subtitleLanguage: 'off',
  appendFilename: false,
};

export function parseTorboxCredential(
  credential: string
): TorboxCredentialPayload {
  try {
    const parsed = JSON.parse(credential) as Partial<TorboxCredentialPayload>;
    if (parsed && typeof parsed.token === 'string' && parsed.token.trim()) {
      return {
        ...DEFAULT_TORBOX_PLAYBACK_PREFERENCES,
        ...parsed,
        token: parsed.token,
        credentialSource:
          parsed.credentialSource === 'device_code' ? 'device_code' : 'legacy',
        quality: ['native', '1080p', '720p'].includes(parsed.quality ?? '')
          ? (parsed.quality as TorboxPlaybackQuality)
          : 'native',
        audioLanguage:
          typeof parsed.audioLanguage === 'string' && parsed.audioLanguage
            ? parsed.audioLanguage
            : 'auto',
        subtitleLanguage:
          typeof parsed.subtitleLanguage === 'string' && parsed.subtitleLanguage
            ? parsed.subtitleLanguage
            : 'off',
        appendFilename: parsed.appendFilename === true,
      };
    }
  } catch {
    // Legacy credentials are plain API tokens.
  }

  return {
    token: credential,
    credentialSource: 'legacy',
    ...DEFAULT_TORBOX_PLAYBACK_PREFERENCES,
  };
}

export function serializeTorboxCredential(
  payload: TorboxCredentialPayload
): string {
  return JSON.stringify(payload);
}

export interface TorboxUserSettings {
  stremio_wait_for_download_torrent?: boolean;
  stremio_wait_for_download_usenet?: boolean;
  append_filename_to_links?: boolean;
  cdn_selection?: string | null;
  web_player_always_transcode?: boolean;
  web_player_audio_preferred_language?: string | null;
  web_player_subtitle_preferred_language?: string | null;
  [key: string]: unknown;
}

export interface TorboxDeviceStartData {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  friendlyVerificationUrl?: string;
  intervalMs: number;
  expiresAt: number;
}

export interface TorboxStreamTrack {
  index?: number;
  codec?: string;
  codec_type?: string;
  default?: boolean;
  channels?: number;
  channel_layout?: string;
  language?: string;
  language_full?: string;
  title?: string;
  [key: string]: unknown;
}

export interface TorboxStreamData {
  hls_url?: string;
  metadata?: {
    audios?: TorboxStreamTrack[];
    subtitles?: TorboxStreamTrack[];
    video?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type TorboxNativeFallbackReason =
  | 'preferred-audio-missing'
  | 'preferred-subtitle-missing'
  | 'subtitle-format-unsupported'
  | 'stream-api-failure'
  | 'invalid-track-selection'
  | 'plan-restriction';

export interface TorboxPlaybackRequest extends TorboxPlaybackPreferences {
  type: TorboxMediaType;
  itemId: string | number;
  fileId: string | number;
  token: string;
}

export interface TorboxPlaybackResult {
  url: string;
  mode: 'native' | 'stream';
  target: 'native' | '1080p' | '720p';
  fallbackReason?: TorboxNativeFallbackReason;
  chosenAudioIndex?: number;
  chosenSubtitleIndex?: number | null;
  streamData?: TorboxStreamData;
}

interface TorboxEnvelope<T> {
  success?: boolean;
  error?: string | null;
  detail?: string | null;
  data?: T;
}

export class TorboxHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly detail?: string
  ) {
    super(message);
    this.name = 'TorboxHttpError';
  }
}

type FetchLike = typeof fetch;

function booleanParam(value: boolean): string {
  return value ? 'true' : 'false';
}

function valueAt(obj: unknown, ...keys: string[]): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  const record = obj as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const TEXT_SUBTITLE_CODECS = new Set([
  'ass',
  'ssa',
  'srt',
  'subrip',
  'text',
  'mov_text',
  'webvtt',
  'vtt',
]);

export function isTextSubtitleTrack(track: TorboxStreamTrack): boolean {
  const codec = String(track.codec ?? '').toLowerCase();
  if (TEXT_SUBTITLE_CODECS.has(codec)) return true;
  if (/\b(pgs|hdmv|dvd_subtitle|vobsub|xsub)\b/i.test(codec)) return false;
  return /\b(srt|subrip|ass|ssa|webvtt|vtt|text)\b/i.test(
    `${track.codec ?? ''} ${track.codec_type ?? ''} ${track.title ?? ''}`
  );
}

export function normaliseTorboxTrackLanguage(
  track: TorboxStreamTrack
): string | undefined {
  return (
    normaliseLanguage(track.language_full) ?? normaliseLanguage(track.language)
  );
}

export function chooseTorboxAudioTrack(
  tracks: TorboxStreamTrack[],
  preference: string
): number | undefined {
  if (!tracks.length) return undefined;
  if (preference.toLowerCase() === 'auto') {
    const defaultIndex = tracks.findIndex((track) => track.default === true);
    return defaultIndex >= 0 ? defaultIndex : 0;
  }

  const wanted = normaliseLanguage(preference);
  if (!wanted) return undefined;
  const matches = tracks
    .map((track, relativeIndex) => ({ track, relativeIndex }))
    .filter(({ track }) => normaliseTorboxTrackLanguage(track) === wanted)
    .sort((a, b) => {
      const defaultDelta =
        Number(b.track.default === true) - Number(a.track.default === true);
      if (defaultDelta) return defaultDelta;
      const channelDelta =
        Number(b.track.channels ?? 0) - Number(a.track.channels ?? 0);
      return channelDelta || a.relativeIndex - b.relativeIndex;
    });
  return matches[0]?.relativeIndex;
}

export function chooseTorboxSubtitleTrack(
  tracks: TorboxStreamTrack[],
  preference: string
): number | null | undefined {
  if (preference.toLowerCase() === 'off') return null;
  const textTracks = tracks
    .map((track, relativeIndex) => ({ track, relativeIndex }))
    .filter(({ track }) => isTextSubtitleTrack(track));
  if (preference.toLowerCase() === 'auto') {
    const defaultTrack = textTracks.find(({ track }) => track.default === true);
    return defaultTrack?.relativeIndex ?? null;
  }

  const wanted = normaliseLanguage(preference);
  if (!wanted) return undefined;
  return textTracks.find(
    ({ track }) => normaliseTorboxTrackLanguage(track) === wanted
  )?.relativeIndex;
}

export class TorboxClient {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl: string = TORBOX_API_BASE_URL
  ) {}

  private async request<T>(
    path: string,
    options: {
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
      token?: string;
      query?: Record<string, string | number | boolean | null | undefined>;
      body?: unknown;
      form?: URLSearchParams | FormData;
      allowFailureEnvelope?: boolean;
    } = {}
  ): Promise<{ response: Response; envelope: TorboxEnvelope<T> }> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers = new Headers();
    if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
    let body: string | URLSearchParams | FormData | undefined;
    if (options.form) {
      body = options.form;
      if (options.form instanceof URLSearchParams) {
        headers.set('Content-Type', 'application/x-www-form-urlencoded');
      }
    } else if (options.body !== undefined) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(options.body);
    }

    const response = await this.fetchImpl(url, {
      method: options.method ?? 'GET',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    let envelope: TorboxEnvelope<T> = {};
    try {
      envelope = (await response.json()) as TorboxEnvelope<T>;
    } catch {
      if (!response.ok) {
        throw new TorboxHttpError(
          `TorBox request failed with HTTP ${response.status}`,
          response.status
        );
      }
    }

    if (
      !options.allowFailureEnvelope &&
      (!response.ok || envelope.success === false)
    ) {
      throw new TorboxHttpError(
        envelope.detail || envelope.error || `TorBox request failed`,
        response.status,
        envelope.error ?? undefined,
        envelope.detail ?? undefined
      );
    }
    return { response, envelope };
  }

  async startDeviceAuthorization(
    app = 'AIOStreams'
  ): Promise<TorboxDeviceStartData> {
    const { envelope } = await this.request<Record<string, unknown>>(
      '/v1/api/user/auth/device/start',
      { query: { app } }
    );
    const data = asRecord(envelope.data);
    const deviceCode = valueAt(data, 'device_code', 'deviceCode');
    const userCode = valueAt(data, 'code', 'user_code', 'userCode');
    const verificationUrl = valueAt(
      data,
      'verification_url',
      'verificationUrl'
    );
    const friendly = valueAt(
      data,
      'friendly_verification_url',
      'friendlyVerificationUrl'
    );
    const expiresRaw = valueAt(data, 'expires_at', 'expiresAt');
    const intervalRaw = Number(valueAt(data, 'interval') ?? 5);
    const expiresAt =
      typeof expiresRaw === 'number'
        ? expiresRaw < 10_000_000_000
          ? expiresRaw * 1000
          : expiresRaw
        : Date.parse(String(expiresRaw ?? ''));

    if (
      typeof deviceCode !== 'string' ||
      typeof userCode !== 'string' ||
      typeof verificationUrl !== 'string' ||
      !Number.isFinite(expiresAt)
    ) {
      throw new TorboxHttpError(
        'TorBox returned an invalid device-flow response',
        502
      );
    }
    return {
      deviceCode,
      userCode,
      verificationUrl,
      friendlyVerificationUrl:
        typeof friendly === 'string' ? friendly : undefined,
      intervalMs: Math.max(1000, intervalRaw * 1000),
      expiresAt,
    };
  }

  async pollDeviceAuthorization(
    deviceCode: string
  ): Promise<{ status: 'waiting' } | { status: 'authorized'; token: string }> {
    const { envelope } = await this.request<Record<string, unknown>>(
      '/v1/api/user/auth/device/token',
      {
        method: 'POST',
        body: { device_code: deviceCode },
        allowFailureEnvelope: true,
      }
    );
    if (envelope.success !== true) return { status: 'waiting' };
    const token = valueAt(
      envelope.data,
      'access_token',
      'accessToken',
      'token'
    );
    if (typeof token !== 'string' || !token) {
      throw new TorboxHttpError(
        'TorBox authorized without returning a token',
        502
      );
    }
    return { status: 'authorized', token };
  }

  async getUserSettings(token: string): Promise<{
    user: Record<string, unknown>;
    settings: TorboxUserSettings;
  }> {
    const { envelope } = await this.request<Record<string, unknown>>(
      '/v1/api/user/me',
      { token, query: { settings: true } }
    );
    const user = asRecord(envelope.data) ?? {};
    const settings =
      (asRecord(valueAt(user, 'settings')) as TorboxUserSettings | undefined) ??
      {};
    return { user, settings };
  }

  async editSettings(
    token: string,
    patch: Partial<TorboxUserSettings>
  ): Promise<void> {
    await this.request('/v1/api/user/settings/editsettings', {
      method: 'PUT',
      token,
      body: patch,
    });
  }

  buildRequestDlPermalink(request: TorboxPlaybackRequest): string {
    const endpoint =
      request.type === 'torrent'
        ? '/v1/api/torrents/requestdl'
        : request.type === 'usenet'
          ? '/v1/api/usenet/requestdl'
          : '/v1/api/webdl/requestdl';
    const idParam =
      request.type === 'torrent'
        ? 'torrent_id'
        : request.type === 'usenet'
          ? 'usenet_id'
          : 'web_id';
    const url = new URL(endpoint, this.baseUrl);
    url.searchParams.set('token', request.token);
    url.searchParams.set(idParam, String(request.itemId));
    url.searchParams.set('file_id', String(request.fileId));
    url.searchParams.set('zip_link', 'false');
    url.searchParams.set('redirect', 'true');
    url.searchParams.set('append_name', booleanParam(request.appendFilename));
    return url.toString();
  }

  async createStream(
    token: string,
    params: {
      id: string | number;
      fileId: string | number;
      type: TorboxMediaType;
      audioIndex: number;
      subtitleIndex: number | null;
      resolutionIndex: number | null;
    }
  ): Promise<TorboxStreamData> {
    const { envelope } = await this.request<TorboxStreamData>(
      '/v1/api/stream/createstream',
      {
        token,
        query: {
          id: params.id,
          file_id: params.fileId,
          type: params.type,
          chosen_audio_index: params.audioIndex,
          chosen_subtitle_index:
            params.subtitleIndex === null ? 'null' : params.subtitleIndex,
          chosen_resolution_index:
            params.resolutionIndex === null ? 'null' : params.resolutionIndex,
          scrobbling_enabled: false,
        },
      }
    );
    const data = envelope.data;
    if (!data || typeof data !== 'object') {
      throw new TorboxHttpError('TorBox returned invalid stream data', 502);
    }
    return data;
  }

  async resolvePlayback(
    request: TorboxPlaybackRequest
  ): Promise<TorboxPlaybackResult> {
    const native = (
      reason?: TorboxNativeFallbackReason
    ): TorboxPlaybackResult => ({
      url: this.buildRequestDlPermalink(request),
      mode: 'native',
      target: 'native',
      fallbackReason: reason,
    });
    if (request.quality === 'native') return native();

    try {
      const preflight = await this.createStream(request.token, {
        id: request.itemId,
        fileId: request.fileId,
        type: request.type,
        audioIndex: 0,
        subtitleIndex: null,
        resolutionIndex: null,
      });
      const audios = preflight.metadata?.audios ?? [];
      const subtitles = preflight.metadata?.subtitles ?? [];
      const audioIndex = chooseTorboxAudioTrack(audios, request.audioLanguage);
      if (audioIndex === undefined) return native('preferred-audio-missing');
      const subtitleIndex = chooseTorboxSubtitleTrack(
        subtitles,
        request.subtitleLanguage
      );
      if (subtitleIndex === undefined) {
        const wanted = normaliseLanguage(request.subtitleLanguage);
        const imageOnlyMatch = wanted
          ? subtitles.some(
              (track) =>
                normaliseTorboxTrackLanguage(track) === wanted &&
                !isTextSubtitleTrack(track)
            )
          : false;
        return native(
          imageOnlyMatch
            ? 'subtitle-format-unsupported'
            : 'preferred-subtitle-missing'
        );
      }
      const resolutionIndex = request.quality === '1080p' ? 5 : 4;
      const finalStream = await this.createStream(request.token, {
        id: request.itemId,
        fileId: request.fileId,
        type: request.type,
        audioIndex,
        subtitleIndex,
        resolutionIndex,
      });
      if (!finalStream.hls_url) return native('stream-api-failure');
      return {
        url: finalStream.hls_url,
        mode: 'stream',
        target: request.quality,
        chosenAudioIndex: audioIndex,
        chosenSubtitleIndex: subtitleIndex,
        streamData: finalStream,
      };
    } catch (error) {
      if (
        error instanceof TorboxHttpError &&
        error.code === 'PLAN_RESTRICTED_FEATURE'
      ) {
        return native('plan-restriction');
      }
      return native('stream-api-failure');
    }
  }

  async createUsenetDownloadFromFile(
    token: string,
    file: Buffer,
    name: string,
    addOnlyIfCached: boolean
  ): Promise<{ id: string | number; hash?: string; authId?: string | number }> {
    const form = new FormData();
    form.set(
      'file',
      new Blob([Uint8Array.from(file)], { type: 'application/x-nzb' }),
      name.toLowerCase().endsWith('.nzb') ? name : name + '.nzb'
    );
    form.set('name', name);
    form.set('add_only_if_cached', booleanParam(addOnlyIfCached));
    form.set('as_queued', 'false');
    form.set('post_processing', '-1');
    const { envelope } = await this.request<Record<string, unknown>>(
      '/v1/api/usenet/createusenetdownload',
      { method: 'POST', token, form }
    );
    const data = asRecord(envelope.data);
    const id = valueAt(data, 'usenetdownload_id', 'usenetdownloadId');
    if (typeof id !== 'string' && typeof id !== 'number') {
      throw new TorboxHttpError(
        'TorBox created an NZB without returning usenetdownload_id',
        502
      );
    }
    const hash = valueAt(data, 'hash');
    const authId = valueAt(data, 'auth_id', 'authId');
    return {
      id,
      hash: typeof hash === 'string' ? hash : undefined,
      authId:
        typeof authId === 'string' || typeof authId === 'number'
          ? authId
          : undefined,
    };
  }

  async checkWebDownloadCache(
    token: string,
    hashes: string[]
  ): Promise<unknown> {
    const { envelope } = await this.request<unknown>(
      '/v1/api/webdl/checkcached',
      {
        method: 'POST',
        token,
        body: { hashes },
      }
    );
    return envelope.data;
  }

  async createWebDownload(
    token: string,
    link: string,
    addOnlyIfCached: boolean
  ): Promise<unknown> {
    const form = new URLSearchParams({
      link,
      add_only_if_cached: booleanParam(addOnlyIfCached),
    });
    const { envelope } = await this.request<unknown>(
      '/v1/api/webdl/createwebdownload',
      { method: 'POST', token, form }
    );
    return envelope.data;
  }

  async listWebDownloads(
    token: string,
    id?: string | number
  ): Promise<unknown> {
    const { envelope } = await this.request<unknown>('/v1/api/webdl/mylist', {
      token,
      query: { id, bypass_cache: true },
    });
    return envelope.data;
  }
}
