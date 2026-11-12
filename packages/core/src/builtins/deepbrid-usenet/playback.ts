import { z } from 'zod';
import { config as appConfig } from '../../config/index.js';
import {
  decodeSignedPayload,
  decryptString,
  encodeSignedPayload,
  encryptString,
} from '../../utils/index.js';
import { isUnsafeRemoteUrl } from '../../utils/url-safety.js';
import {
  isTrustedDeepbridDownloadHost,
  validateDeepbridDownloadUrl,
} from './client.js';
import {
  buildDeepbridPlaybackVariants,
  deepbridPlaybackModes,
  type DeepbridPlaybackMode,
  type DeepbridPlaybackVariant,
} from './playbackVariants.js';

export { deepbridPlaybackModes } from './playbackVariants.js';
export type {
  DeepbridPlaybackMode,
  DeepbridPlaybackVariant,
} from './playbackVariants.js';

const CapabilityEnvelopeSchema = z.object({
  v: z.literal(1),
  e: z.string().min(32).max(16_384),
  exp: z.number().int().positive(),
});

const PlaybackPayloadSchema = z.object({
  apiKey: z.string().min(16).max(512),
  url: z.url(),
  filename: z.string().min(1).max(512),
  size: z.number().nonnegative().optional(),
  // Optional Finder identity enables a single on-demand refresh only after an
  // expired direct link is rejected. Existing capabilities remain compatible.
  finderToken: z.string().min(1).max(512).optional(),
  finderArchives: z.boolean().optional(),
  // Independent of Finder routing (`direct` / `indexer` / `both`). Missing
  // values in existing v1 capabilities remain the original direct path.
  mode: z.enum(['direct', 'remux', 'hls', 'hls-asset']).optional(),
});

export type DeepbridPlaybackPayload = z.infer<typeof PlaybackPayloadSchema>;

const SubtitleConversionPayloadSchema = z.object({
  apiKey: z.string().min(16).max(512),
  subtitleUrl: z.url(),
});

export type DeepbridSubtitleConversionPayload = z.infer<
  typeof SubtitleConversionPayloadSchema
>;

function validateSubtitleConversionUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    isUnsafeRemoteUrl(url.toString())
  ) {
    throw new Error('Deepbrid subtitle conversion requires a safe HTTPS URL.');
  }
  return url;
}

export function createDeepbridPlaybackToken(
  payload: DeepbridPlaybackPayload
): string {
  const validated = PlaybackPayloadSchema.parse(payload);
  const target = validateDeepbridDownloadUrl(validated.url);
  if (!isTrustedDeepbridDownloadHost(target.hostname)) {
    throw new Error('Untrusted Deepbrid playback host.');
  }
  const encrypted = encryptString(JSON.stringify(validated));
  if (!encrypted.success || !encrypted.data) {
    throw new Error('Failed to encrypt Deepbrid playback capability.');
  }
  return encodeSignedPayload({
    v: 1,
    e: encrypted.data,
    exp: Math.floor(Date.now() / 1_000) + 12 * 60 * 60,
  });
}

export function decodeDeepbridPlaybackToken(
  token: string
): DeepbridPlaybackPayload {
  const envelope = CapabilityEnvelopeSchema.parse(decodeSignedPayload(token));
  if (envelope.exp < Math.floor(Date.now() / 1_000)) {
    throw new Error('Deepbrid playback capability expired.');
  }
  const decrypted = decryptString(envelope.e);
  if (!decrypted.success || !decrypted.data) {
    throw new Error('Invalid Deepbrid playback capability.');
  }
  const payload = PlaybackPayloadSchema.parse(JSON.parse(decrypted.data));
  const target = validateDeepbridDownloadUrl(payload.url);
  if (!isTrustedDeepbridDownloadHost(target.hostname)) {
    throw new Error('Untrusted Deepbrid playback host.');
  }
  return payload;
}

/**
 * Keep every Deepbrid download behind AIOStreams' authenticated Range proxy.
 * Deepbrid API-hosted links require a Bearer header that media clients cannot
 * attach to a 307 target themselves.
 */
export function createDeepbridPlaybackUrl(
  payload: DeepbridPlaybackPayload
): string {
  const base = appConfig.bootstrap.baseUrl.replace(/\/+$/, '');
  return `${base}/builtins/deepbrid-usenet/play/${createDeepbridPlaybackToken(
    payload
  )}/${encodeURIComponent(payload.filename)}`;
}

/**
 * Deepbrid's Android player archive identifies these media endpoints. They
 * remain opt-in because the contract is not in Deepbrid's public API docs.
 */
export const DEEPBRID_PLAYER_BASE = 'https://streaming-2.myfast.link:8443';

/** Build the actual player-facing choices from the configured delivery mode. */
export function createDeepbridPlaybackVariants(
  payload: Omit<DeepbridPlaybackPayload, 'mode'>,
  selectedMode: DeepbridPlaybackMode | 'all' | undefined
): DeepbridPlaybackVariant[] {
  return buildDeepbridPlaybackVariants(
    payload,
    selectedMode,
    createDeepbridPlaybackUrl
  );
}

export function deepbridPlayerEndpoint(
  payload: DeepbridPlaybackPayload,
  playerBase = DEEPBRID_PLAYER_BASE
): URL {
  const mode = payload.mode ?? 'direct';
  const base = new URL(playerBase);
  if (mode === 'direct') {
    return validateDeepbridDownloadUrl(payload.url);
  }
  if (mode === 'hls-asset') {
    const target = validateDeepbridDownloadUrl(payload.url);
    return target;
  }
  const endpoint = new URL(
    mode === 'remux' ? '/cast_remux' : '/cast_hls',
    base
  );
  endpoint.searchParams.set('url', payload.url);
  endpoint.searchParams.set('audio', '0');
  endpoint.searchParams.set(mode === 'remux' ? 'start' : 't', '0');
  return endpoint;
}

export function createDeepbridSubtitleConversionToken(
  payload: DeepbridSubtitleConversionPayload
): string {
  const validated = SubtitleConversionPayloadSchema.parse(payload);
  validateSubtitleConversionUrl(validated.subtitleUrl);
  const encrypted = encryptString(JSON.stringify(validated));
  if (!encrypted.success || !encrypted.data) {
    throw new Error('Failed to encrypt Deepbrid subtitle capability.');
  }
  return encodeSignedPayload({
    v: 1,
    e: encrypted.data,
    exp: Math.floor(Date.now() / 1_000) + 12 * 60 * 60,
  });
}

export function decodeDeepbridSubtitleConversionToken(
  token: string
): DeepbridSubtitleConversionPayload {
  const envelope = CapabilityEnvelopeSchema.parse(decodeSignedPayload(token));
  if (envelope.exp < Math.floor(Date.now() / 1_000)) {
    throw new Error('Deepbrid subtitle capability expired.');
  }
  const decrypted = decryptString(envelope.e);
  if (!decrypted.success || !decrypted.data) {
    throw new Error('Invalid Deepbrid subtitle capability.');
  }
  const payload = SubtitleConversionPayloadSchema.parse(
    JSON.parse(decrypted.data)
  );
  validateSubtitleConversionUrl(payload.subtitleUrl);
  return payload;
}

export function createDeepbridSubtitleConversionUrl(
  payload: DeepbridSubtitleConversionPayload
): string {
  const base = appConfig.bootstrap.baseUrl.replace(/\/+$/, '');
  return `${base}/builtins/deepbrid-usenet/subtitle/convert/${createDeepbridSubtitleConversionToken(
    payload
  )}.vtt`;
}
