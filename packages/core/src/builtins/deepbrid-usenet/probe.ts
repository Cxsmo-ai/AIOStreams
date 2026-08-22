import { makeRequest } from '../../utils/index.js';
import {
  DeepbridFinderFile,
  isDeepbridHost,
  isTrustedDeepbridDownloadHost,
  validateDeepbridDownloadUrl,
} from './client.js';

function looksLikeVideoBytes(filename: string, bytes: Uint8Array): boolean {
  const extension = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (!extension || bytes.length < 4) return false;
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...bytes.slice(start, start + length));
  switch (extension) {
    case 'mkv':
    case 'webm':
      return (
        bytes[0] === 0x1a &&
        bytes[1] === 0x45 &&
        bytes[2] === 0xdf &&
        bytes[3] === 0xa3
      );
    case 'mp4':
    case 'm4v':
    case 'mov':
      return ascii(4, 4) === 'ftyp' || ascii(4, 4) === 'moov';
    case 'avi':
      return ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'AVI ';
    case 'flv':
      return ascii(0, 3) === 'FLV';
    case 'wmv':
      return (
        bytes[0] === 0x30 &&
        bytes[1] === 0x26 &&
        bytes[2] === 0xb2 &&
        bytes[3] === 0x75
      );
    case 'mpg':
    case 'mpeg':
      return (
        bytes[0] === 0 &&
        bytes[1] === 0 &&
        bytes[2] === 1 &&
        (bytes[3] === 0xba || bytes[3] === 0xb3)
      );
    case 'ts':
    case 'm2ts':
      return bytes[0] === 0x47 || bytes[4] === 0x47;
    default:
      return false;
  }
}

/**
 * Require a real ranged video container before accepting a resolved Deepbrid
 * URL. Deepbrid can return small generated error videos with otherwise valid
 * HTTP metadata, so status and extension checks alone are insufficient.
 */
export async function probeDeepbridVideo(
  file: DeepbridFinderFile,
  apiKey: string,
  options: { timeoutMs: number; signal?: AbortSignal }
): Promise<boolean> {
  let target = validateDeepbridDownloadUrl(file.link);
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!isTrustedDeepbridDownloadHost(target.hostname)) return false;
    const headers: Record<string, string> = {
      Accept: '*/*',
      'Accept-Encoding': 'identity',
      Range: 'bytes=0-63',
    };
    if (isDeepbridHost(target.hostname)) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    let response: Response;
    try {
      response = await makeRequest(target.toString(), {
        timeout: options.timeoutMs,
        signal: options.signal,
        headers,
        rawOptions: { redirect: 'manual' },
      });
    } catch {
      return false;
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) return false;
      try {
        target = validateDeepbridDownloadUrl(
          new URL(location, target).toString()
        );
      } catch {
        return false;
      }
      continue;
    }
    const contentRange = response.headers.get('content-range') || '';
    if (
      response.status !== 206 ||
      !/^bytes\s+0-\d+\/(?:\d+|\*)$/i.test(contentRange) ||
      !response.body
    ) {
      await response.body?.cancel().catch(() => {});
      return false;
    }
    const contentType = (
      response.headers.get('content-type') || ''
    ).toLowerCase();
    if (/json|html|text\//.test(contentType)) {
      await response.body.cancel().catch(() => {});
      return false;
    }
    const reader = response.body.getReader();
    try {
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (length < 16) {
        const chunk = await reader.read();
        if (chunk.done || !chunk.value) break;
        chunks.push(chunk.value);
        length += chunk.value.length;
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return looksLikeVideoBytes(file.name, bytes);
    } catch {
      return false;
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  return false;
}
