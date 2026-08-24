import { z } from 'zod';
import { config as appConfig } from '../../config/index.js';
import {
  decodeSignedPayload,
  decryptString,
  encodeSignedPayload,
  encryptString,
} from '../../utils/index.js';
import {
  isTrustedDeepbridDownloadHost,
  validateDeepbridDownloadUrl,
} from './client.js';

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
});

export type DeepbridPlaybackPayload = z.infer<typeof PlaybackPayloadSchema>;

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
