import { NextFunction, Request, Response, Router } from 'express';
import { pipeline } from 'node:stream/promises';
import {
  DEEPBRID_FINDER_USER_AGENT,
  decodeDeepbridSubtitleConversionToken,
  DEEPBRID_PLAYER_BASE,
  DeepbridUsenetAddon,
  createDeepbridPlaybackUrl,
  createDeepbridPlaybackToken,
  decodeDeepbridPlaybackToken,
  deepbridPlayerEndpoint,
  decryptString,
  makeRequest,
  isUnsafeRemoteUrl,
  readBodyCapped,
  isDeepbridHost,
  isTrustedDeepbridDownloadHost,
  validateDeepbridDownloadUrl,
  createLogger,
} from '@aiostreams/core';
import {
  observeProgressiveResponse,
  waitForProgressiveDrain,
} from '../stremio/progressiveStreamLifecycle.js';
import { getDeepbridProgressiveDiagnostic } from './deepbrid-progressive-diagnostic.js';
import {
  DEEPBRID_HLS_HEADERS_TO_REMOVE,
  isDeepbridHlsPlaylistResponse,
  isDeepbridRedirectStatus,
  rewriteDeepbridHlsPlaylist,
  shouldForwardDeepbridConditionalHeaders,
  shouldForwardDeepbridRange,
} from './deepbrid-playback.js';
import { convertDeepbridSubtitle } from './deepbrid-subtitle-conversion.js';

const router: Router = Router();
const logger = createLogger('server:deepbrid-usenet');

function config(encoded: string): unknown {
  const decrypted = decryptString(encoded);
  if (!decrypted.success || !decrypted.data) {
    throw new Error('Invalid encrypted Deepbrid Usenet configuration.');
  }
  return JSON.parse(decrypted.data);
}

router.get(
  '/:encodedConfig/manifest.json',
  async (
    req: Request<{ encodedConfig: string }>,
    res: Response,
    next: NextFunction
  ) => {
    try {
      res.set('Cache-Control', 'private, no-store');
      res.json(
        new DeepbridUsenetAddon(
          config(req.params.encodedConfig) as any,
          req.userIp
        ).getManifest()
      );
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/:encodedConfig/stream/:type/:id.json',
  async (
    req: Request<{ encodedConfig: string; type: string; id: string }>,
    res: Response,
    next: NextFunction
  ) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    res.once('close', abort);
    try {
      const addon = new DeepbridUsenetAddon(
        config(req.params.encodedConfig) as any,
        req.userIp
      );
      res.set('Cache-Control', 'private, no-store');
      res.json({
        streams: await addon.getStreams(
          req.params.type,
          req.params.id,
          controller.signal
        ),
      });
    } catch (error) {
      next(error);
    } finally {
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
    }
  }
);

/**
 * Internal-only progressive transport used by AIOStreams' own Wrapper. The
 * outer Nuvio endpoint remains the sole owner of its terminal completion event.
 */
router.get(
  '/:encodedConfig/stream-progressive/:type/:id.ndjson',
  async (
    req: Request<{ encodedConfig: string; type: string; id: string }>,
    res: Response,
    next: NextFunction
  ) => {
    const controller = new AbortController();
    const abortRequest = () => {
      if (controller.signal.aborted) return;
      logger.warn(
        { abortSource: 'request-aborted' },
        'Deepbrid progressive request cancelled by downstream client'
      );
      controller.abort(new DOMException('request-aborted', 'AbortError'));
    };
    req.once('aborted', abortRequest);

    let closed = false;
    const lifecycle = observeProgressiveResponse(res, (abortSource) => {
      closed = true;
      if (controller.signal.aborted) return;
      logger.warn(
        { abortSource },
        'Deepbrid progressive response closed before completion'
      );
      controller.abort(new DOMException(abortSource, 'AbortError'));
    });

    const writeEvent = async (event: unknown): Promise<void> => {
      if (
        closed ||
        controller.signal.aborted ||
        res.destroyed ||
        res.writableEnded
      )
        return;
      if (res.write(`${JSON.stringify(event)}\n`)) return;
      await waitForProgressiveDrain(res);
      if (
        closed ||
        controller.signal.aborted ||
        lifecycle.isDisconnected() ||
        res.destroyed ||
        res.writableEnded
      ) {
        throw new DOMException(
          'Progressive request disconnected',
          'AbortError'
        );
      }
    };

    try {
      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      const addon = new DeepbridUsenetAddon(
        config(req.params.encodedConfig) as any,
        req.userIp
      );
      const streams = await addon.getStreams(
        req.params.type,
        req.params.id,
        controller.signal,
        async (batch, candidateIndex) => {
          await writeEvent({ event: 'batch', candidateIndex, streams: batch });
        }
      );

      if (!closed && !controller.signal.aborted) {
        await writeEvent({ event: 'complete', streams });
        if (!res.writableEnded) res.end();
      }
    } catch (error) {
      if (closed || controller.signal.aborted || res.destroyed) return;
      if (!res.headersSent) {
        next(error);
      } else {
        logger.warn(
          getDeepbridProgressiveDiagnostic(error),
          'Deepbrid progressive stream ended before completion'
        );
        // A premature EOF is deliberately not a successful completion frame;
        // the Wrapper will reject the response and avoid caching partial data.
        res.destroy();
      }
    } finally {
      req.removeListener('aborted', abortRequest);
      lifecycle.dispose();
    }
  }
);

const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
] as const;

const MAX_HLS_PLAYLIST_BYTES = 2 * 1024 * 1024;
const DEEPBRID_PLAYER_HOST = new URL(DEEPBRID_PLAYER_BASE).hostname;

router.get(
  '/subtitle/convert/:token.vtt',
  async (req: Request<{ token: string }>, res: Response) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const { apiKey, subtitleUrl } = decodeDeepbridSubtitleConversionToken(
        req.params.token
      );
      const vtt = await convertDeepbridSubtitle(apiKey, subtitleUrl, {
        request: makeRequest,
        isUnsafeRemoteUrl,
        readBodyCapped,
        playerBase: DEEPBRID_PLAYER_BASE,
        userAgent: DEEPBRID_FINDER_USER_AGENT,
      });
      res.status(200).set('Content-Type', 'text/vtt; charset=utf-8').send(vtt);
    } catch {
      // The signed URL contains encrypted credentials and user-supplied URLs;
      // never put request URLs, upstream bodies, or exception text in logs.
      if (!res.headersSent) res.status(502).end();
    }
  }
);

async function readBoundedText(
  body: ReadableStream<Uint8Array>,
  maximumBytes: number
): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel('HLS playlist exceeds the configured size limit');
        throw new Error('Deepbrid HLS playlist exceeds the safe size limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function createHlsAssetUrl(
  value: string,
  playlistUrl: string,
  payload: ReturnType<typeof decodeDeepbridPlaybackToken>
): string {
  const asset = validateDeepbridDownloadUrl(
    new URL(value, playlistUrl).toString()
  );
  if (!isTrustedDeepbridDownloadHost(asset.hostname)) {
    throw new Error('Deepbrid HLS playlist references an untrusted host.');
  }
  return createDeepbridPlaybackUrl({
    ...payload,
    url: asset.toString(),
    mode: 'hls-asset',
    filename: asset.pathname.split('/').pop() || 'hls-asset',
  });
}

async function handleDeepbridPlayback(
  req: Request<{ token: string; filename?: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  const controller = new AbortController();
  const onClose = () => controller.abort();
  res.once('close', onClose);
  try {
    const payload = decodeDeepbridPlaybackToken(req.params.token);
    const playbackMode = payload.mode ?? 'direct';
    let target = deepbridPlayerEndpoint(payload);
    if (!isTrustedDeepbridDownloadHost(target.hostname)) {
      throw new Error('Deepbrid playback proxy rejected an untrusted host.');
    }
    let upstream: Awaited<ReturnType<typeof makeRequest>> | undefined;
    let redirects = 0;
    let suppressRangeAfterPlaylistMime = false;
    const forwardConditionalHeaders =
      shouldForwardDeepbridConditionalHeaders(playbackMode);
    for (let attempt = 0; attempt < 5; attempt++) {
      const headers: Record<string, string> = {
        Accept: '*/*',
        'Accept-Encoding': 'identity',
        'User-Agent': DEEPBRID_FINDER_USER_AGENT,
      };
      if (
        target.hostname === DEEPBRID_PLAYER_HOST ||
        isDeepbridHost(target.hostname)
      ) {
        headers.Authorization = `Bearer ${payload.apiKey}`;
      }
      if (target.hostname === DEEPBRID_PLAYER_HOST) {
        headers.Referer = 'https://www.deepbrid.com/';
      }
      headers.Accept = req.get('accept') || '*/*';
      const forwardRange = shouldForwardDeepbridRange(
        playbackMode,
        target.pathname
      );
      if (
        forwardRange &&
        !suppressRangeAfterPlaylistMime &&
        typeof req.headers.range === 'string'
      )
        headers.Range = req.headers.range;
      if (
        forwardRange &&
        !suppressRangeAfterPlaylistMime &&
        typeof req.headers['if-range'] === 'string'
      )
        headers['If-Range'] = req.headers['if-range'];
      if (
        forwardConditionalHeaders &&
        typeof req.headers['if-none-match'] === 'string'
      )
        headers['If-None-Match'] = req.headers['if-none-match'];
      if (
        forwardConditionalHeaders &&
        typeof req.headers['if-modified-since'] === 'string'
      )
        headers['If-Modified-Since'] = req.headers['if-modified-since'];

      upstream = await makeRequest(target.toString(), {
        method: req.method,
        timeout: 120_000,
        signal: controller.signal,
        headers,
        rawOptions: { redirect: 'manual' },
      });
      if (isDeepbridRedirectStatus(upstream.status)) {
        const location = upstream.headers.get('location');
        await upstream.body?.cancel().catch(() => {});
        if (!location || redirects >= 3) {
          res.status(502).end();
          return;
        }
        const redirected = validateDeepbridDownloadUrl(
          new URL(location, target).toString()
        );
        if (!isTrustedDeepbridDownloadHost(redirected.hostname)) {
          res.status(502).end();
          return;
        }
        redirects++;
        target = redirected;
        continue;
      }
      const contentType = upstream.headers.get('content-type') || '';
      if (
        playbackMode === 'hls-asset' &&
        typeof req.headers.range === 'string' &&
        !suppressRangeAfterPlaylistMime &&
        !shouldForwardDeepbridRange(playbackMode, target.pathname, contentType)
      ) {
        // An extensionless asset can still be a manifest. Retry it whole once
        // after its MIME type identifies it as HLS, never rewrite a 206 body.
        await upstream.body?.cancel().catch(() => {});
        suppressRangeAfterPlaylistMime = true;
        continue;
      }
      break;
    }
    if (!upstream || isDeepbridRedirectStatus(upstream.status)) {
      await upstream?.body?.cancel().catch(() => {});
      res.status(502).end();
      return;
    }
    const contentType = upstream.headers.get('content-type') || '';
    const isPlaylist = isDeepbridHlsPlaylistResponse(
      playbackMode,
      target.pathname,
      contentType
    );
    if (isPlaylist && upstream.status === 304) {
      await upstream.body?.cancel().catch(() => {});
      res.status(502).end();
      return;
    }
    if (!upstream.ok && upstream.status !== 304) {
      await upstream.body?.cancel().catch(() => {});
      res.status(upstream.status || 502).end();
      return;
    }
    res.status(isPlaylist ? 200 : upstream.status);
    res.set('Cache-Control', 'private, no-store');
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      if (isPlaylist && (name === 'etag' || name === 'last-modified')) continue;
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    if (!res.getHeader('Accept-Ranges')) res.removeHeader('Accept-Ranges');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(
        playbackMode === 'hls' ? 'index.m3u8' : payload.filename
      )}"`
    );
    if (isPlaylist) {
      res.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      for (const header of DEEPBRID_HLS_HEADERS_TO_REMOVE) {
        res.removeHeader(header);
      }
    }
    if (isPlaylist && upstream.body && req.method !== 'HEAD') {
      const playlist = await readBoundedText(
        upstream.body,
        MAX_HLS_PLAYLIST_BYTES
      );
      let rewritten: string;
      try {
        rewritten = rewriteDeepbridHlsPlaylist(
          playlist,
          target.toString(),
          (assetUrl) => createHlsAssetUrl(assetUrl, target.toString(), payload)
        );
      } catch {
        res.status(502).end();
        return;
      }
      res.send(rewritten);
      return;
    }
    if (!upstream.body || upstream.status === 304) {
      res.end();
      return;
    }
    if (req.method === 'HEAD') {
      await upstream.body.cancel().catch(() => {});
      res.end();
      return;
    }
    await pipeline(upstream.body, res);
  } catch (error) {
    if (controller.signal.aborted) return;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    next(error);
  } finally {
    res.removeListener('close', onClose);
  }
}

router
  .route('/play/:token{/:filename}')
  .get(handleDeepbridPlayback)
  .head(handleDeepbridPlayback);

export default router;
