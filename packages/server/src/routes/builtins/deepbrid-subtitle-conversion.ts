import type { RequestOptions } from '@aiostreams/core';
import type { Response } from 'undici';

const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;

type ResponseLike = Response;

export type Requester = (
  url: string,
  options: RequestOptions
) => Promise<ResponseLike>;

export type DeepbridSubtitleConversionDependencies = {
  request: Requester;
  isUnsafeRemoteUrl: (url: string) => boolean;
  readBodyCapped: (response: ResponseLike, maxBytes: number) => Promise<Buffer>;
  playerBase: string;
  userAgent: string;
};

export function validateRemoteSubtitleUrl(
  value: string,
  isUnsafeRemoteUrl: DeepbridSubtitleConversionDependencies['isUnsafeRemoteUrl']
): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    isUnsafeRemoteUrl(url.toString())
  ) {
    throw new Error('Unsafe subtitle source URL.');
  }
  return url;
}

async function fetchRemoteSubtitle(
  url: string,
  dependencies: DeepbridSubtitleConversionDependencies
): Promise<ResponseLike> {
  let target = validateRemoteSubtitleUrl(url, dependencies.isUnsafeRemoteUrl);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await dependencies.request(target.toString(), {
      method: 'GET',
      timeout: 20_000,
      headers: {
        Accept: 'text/plain, text/*;q=0.9, */*;q=0.5',
        'Accept-Encoding': 'identity',
        'User-Agent': dependencies.userAgent,
      },
      rawOptions: { redirect: 'manual' },
    });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (!location || redirects === 3) {
      throw new Error('Subtitle source redirect limit exceeded.');
    }
    target = validateRemoteSubtitleUrl(
      new URL(location, target).toString(),
      dependencies.isUnsafeRemoteUrl
    );
  }
  throw new Error('Subtitle source redirect limit exceeded.');
}

function parseWebVttResponse(body: string): string {
  const parsed = JSON.parse(body) as { vtt?: unknown };
  if (
    typeof parsed.vtt !== 'string' ||
    Buffer.byteLength(parsed.vtt, 'utf8') > MAX_SUBTITLE_BYTES ||
    !/^\uFEFF?WEBVTT(?:\s|$)/.test(parsed.vtt)
  ) {
    throw new Error('Deepbrid player returned an invalid WebVTT response.');
  }
  return parsed.vtt;
}

/** Fetch and convert one subtitle, with bounded data and no credential forwarding on redirects. */
export async function convertDeepbridSubtitle(
  apiKey: string,
  subtitleUrl: string,
  dependencies: DeepbridSubtitleConversionDependencies
): Promise<string> {
  const source = await fetchRemoteSubtitle(subtitleUrl, dependencies);
  if (!source.ok || !source.body) {
    await source.body?.cancel().catch(() => {});
    throw new Error('Subtitle source could not be fetched.');
  }
  const sourceText = (
    await dependencies.readBodyCapped(source, MAX_SUBTITLE_BYTES)
  ).toString('utf8');

  const converted = await dependencies.request(
    `${dependencies.playerBase}/web/sub/convert`,
    {
      method: 'POST',
      timeout: 30_000,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'text/plain; charset=utf-8',
        'User-Agent': dependencies.userAgent,
        Referer: 'https://www.deepbrid.com/',
      },
      body: sourceText,
      rawOptions: { redirect: 'manual' },
    }
  );
  if (converted.status >= 300 && converted.status < 400) {
    await converted.body?.cancel().catch(() => {});
    throw new Error('Deepbrid player converter redirect was rejected.');
  }
  if (!converted.ok || !converted.body) {
    await converted.body?.cancel().catch(() => {});
    throw new Error('Deepbrid player could not convert this subtitle.');
  }
  const responseText = (
    await dependencies.readBodyCapped(converted, MAX_SUBTITLE_BYTES)
  ).toString('utf8');
  return parseWebVttResponse(responseText);
}
