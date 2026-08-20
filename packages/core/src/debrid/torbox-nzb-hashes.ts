import { createHash } from 'crypto';
import { scanNzb } from '../usenet/nzb/scan.js';
import { isUnsafeRemoteUrl } from '../release-blocklist/url-safety.js';

export interface TorboxNzbHashOptions {
  maxBytes?: number;
  maxFiles?: number;
  maxSegments?: number;
}

const md5 = (value: string | Buffer): string =>
  createHash('md5').update(value).digest('hex').toLowerCase();

export function normaliseTorboxDownloadUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    return url.toString().toLowerCase();
  } catch {
    return undefined;
  }
}

export function cleanTorboxNzbXml(xml: Buffer): Buffer {
  const value =
    '<?xml version="1.0" ?>' +
    xml
      .toString('utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim()
      .replace(/^<\?xml[^?]*\?>\s*/i, '')
      .replace(/\s+poster=("[^"]*"|'[^']*')/gi, '');
  return Buffer.from(value, 'utf8');
}

export async function getTorboxNzbHashes(
  input: { url?: string; xml?: string | Buffer },
  options: TorboxNzbHashOptions = {}
): Promise<string[]> {
  const hashes = new Set<string>();
  if (input.url) {
    hashes.add(md5(input.url));
    const normalised = normaliseTorboxDownloadUrl(input.url);
    if (normalised) hashes.add(md5(normalised));
  }
  if (input.xml === undefined) return [...hashes];

  const xml = Buffer.isBuffer(input.xml)
    ? input.xml
    : Buffer.from(input.xml, 'utf8');
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  if (xml.length > maxBytes)
    throw new Error('NZB exceeds TorBox hash byte limit');
  const prefix = xml.toString('utf8', 0, Math.min(xml.length, 16_384));
  if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(prefix)) {
    throw new Error('NZB DTD/entities are not allowed');
  }

  hashes.add(md5(xml));
  hashes.add(md5(cleanTorboxNzbXml(xml)));
  const parsed = scanNzb(xml);
  const maxFiles = options.maxFiles ?? 5000;
  const maxSegments = options.maxSegments ?? 2_000_000;
  if (parsed.files.length > maxFiles) {
    throw new Error('NZB exceeds TorBox hash file limit');
  }
  let segments = 0;
  for (const file of parsed.files) {
    segments += file.segments.length;
    if (segments > maxSegments) {
      throw new Error('NZB exceeds TorBox hash segment limit');
    }
    const messageId = file.segments[0]?.messageId?.replace(/^<|>$/g, '');
    if (messageId) hashes.add(md5(messageId));
  }
  return [...hashes];
}

async function fetchSafeNzbResponse(
  url: string,
  fetchImpl: typeof fetch
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    if (isUnsafeRemoteUrl(current)) {
      throw new Error('NZB URL refused (unsafe scheme or private address)');
    }
    const response = await fetchImpl(current, {
      headers: { Accept: 'application/x-nzb, application/xml, text/xml' },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) throw new Error('NZB redirect missing location');
      current = new URL(location, current).toString();
      continue;
    }
    return response;
  }
  throw new Error('NZB fetch exceeded redirect limit');
}

export async function fetchTorboxNzbDocument(
  url: string,
  fetchImpl: typeof fetch = fetch,
  options: TorboxNzbHashOptions = {}
): Promise<{ xml: Buffer; hashes: string[] }> {
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  const response = await fetchSafeNzbResponse(url, fetchImpl);
  if (!response.ok || !response.body) {
    throw new Error(`NZB fetch failed with HTTP ${response.status}`);
  }
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > maxBytes)
    throw new Error('NZB exceeds TorBox hash byte limit');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('NZB exceeds TorBox hash byte limit');
    }
    chunks.push(value);
  }
  const xml = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return {
    xml,
    hashes: await getTorboxNzbHashes({ url, xml }, options),
  };
}

export async function fetchTorboxNzbHashes(
  url: string,
  fetchImpl: typeof fetch = fetch,
  options: TorboxNzbHashOptions = {}
): Promise<string[]> {
  return (await fetchTorboxNzbDocument(url, fetchImpl, options)).hashes;
}
