import { Router, Request, Response, NextFunction } from 'express';
import {
  AIOStreams,
  AIOStreamResponse,
  config as appConfig,
  createLogger,
  StremioTransformer,
} from '@aiostreams/core';
import { trackResource } from '../../middlewares/analytics.js';

const router: Router = Router();
const logger = createLogger('server');

interface StreamParams {
  type: string;
  id: string;
}

type ProgressiveEvent =
  | { event: 'hello'; version: 1 }
  | { event: 'snapshot'; complete: false; streams: AIOStreamResponse['streams'] }
  | { event: 'complete'; complete: true; streams: AIOStreamResponse['streams'] };

router.use(trackResource('stream'));

/**
 * Opt-in NDJSON stream for the modified Nuvio client. Every snapshot is a
 * complete, cumulative AIOStreams view; the final event is the authoritative
 * response. The ordinary Stremio JSON endpoint is intentionally untouched.
 */
router.get(
  '/:type/:id.ndjson',
  async (
    req: Request<StreamParams>,
    res: Response,
    next: NextFunction
  ) => {
    if (!req.userData) {
      res.status(200).json({
        event: 'complete',
        complete: true,
        streams: [],
      });
      return;
    }

    let closed = false;
    req.on('close', () => {
      closed = true;
    });

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const writeEvent = async (event: ProgressiveEvent): Promise<void> => {
      if (closed || res.writableEnded) return;
      const line = `${JSON.stringify(event)}\n`;
      if (res.write(line)) return;
      await new Promise<void>((resolve) => {
        const onDrain = () => {
          res.off('drain', onDrain);
          resolve();
        };
        res.once('drain', onDrain);
        if (closed || res.writableEnded) {
          res.off('drain', onDrain);
          resolve();
        }
      });
    };

    try {
      await writeEvent({ event: 'hello', version: 1 });

      const { type, id } = req.params;
      const transformer = new StremioTransformer(req.userData);
      const provideSetting = appConfig.api.provideStreamData;
      const provideStreamData =
        provideSetting === null
          ? (req.headers['user-agent']?.includes('AIOStreams/') ?? false)
          : typeof provideSetting === 'boolean'
            ? provideSetting
            : provideSetting.includes(req.requestIp || '');

      const aiostreams = await new AIOStreams(req.userData).initialise();
      const disableAutoplay = await aiostreams.shouldStopAutoPlay(type, id);
      let lastFingerprint = '';

      const response = await aiostreams.getStreams(
        id,
        type,
        false,
        async (partial) => {
          if (closed || partial.data.streams.length === 0) return;
          const context = aiostreams.getStreamContext();
          if (!context) return;

          // Do not turn a partial provider failure into a clickable error card.
          // The terminal response carries the normal authoritative errors.
          const transformed = await transformer.transformStreams(
            { ...partial, errors: [] },
            context.toFormatterContext(partial.data.streams),
            {
              provideStreamData,
              disableAutoplay,
              includeUniversalSubtitles: false,
            }
          );
          const fingerprint = transformed.streams
            .map((stream) =>
              [stream.name, stream.title, stream.url, stream.externalUrl].join(
                '\u0000'
              )
            )
            .join('\u0001');
          if (fingerprint === lastFingerprint) return;
          lastFingerprint = fingerprint;
          await writeEvent({
            event: 'snapshot',
            complete: false,
            streams: transformed.streams,
          });
        }
      );

      if (!closed) {
        const context = aiostreams.getStreamContext();
        if (!context) throw new Error('Stream context not available');
        const transformed = await transformer.transformStreams(
          response,
          context.toFormatterContext(response.data.streams),
          { provideStreamData, disableAutoplay, includeUniversalSubtitles: true }
        );
        await writeEvent({
          event: 'complete',
          complete: true,
          streams: transformed.streams,
        });
      }
      if (!res.writableEnded) res.end();
    } catch (error) {
      if (closed || res.writableEnded) return;
      logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'progressive stream request failed'
      );
      // A client that has already received snapshots can safely fall back to
      // the ordinary endpoint. End the NDJSON response without pretending an
      // empty result is authoritative.
      res.end();
      if (!res.headersSent) next(error);
    }
  }
);

export default router;
