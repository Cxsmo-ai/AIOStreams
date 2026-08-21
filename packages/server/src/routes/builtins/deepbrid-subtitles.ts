import { NextFunction, Request, Response, Router } from 'express';
import {
  createLogger,
  makeRequest,
  searchDeepbridOpenSubtitles,
  formatDeepbridSubtitles,
  DEEPBRID_SUBTITLE_BASE,
  DEEPBRID_SUBTITLE_USER_AGENT,
  config as appConfig,
  MetadataService,
} from '@aiostreams/core';
import { pipeline } from 'node:stream/promises';

const logger = createLogger('server:deepbrid-subtitles');
const router: Router = Router();

interface AddonConfig {
  languages?: string;
  hearingImpaired?: 'include' | 'exclude' | 'only';
  maxSubtitles?: number;
}

function parseConfig(raw: string): AddonConfig {
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return { languages: 'en', hearingImpaired: 'include', maxSubtitles: 10 };
  }
}

// 1. Manifest
router.get('/:config/manifest.json', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    id: 'deepbrid-opensubtitles',
    name: 'Deepbrid OpenSubtitles',
    version: '1.0.0',
    description: 'Universal OpenSubtitles powered by Deepbrid Web Player API',
    resources: [
      {
        name: 'subtitles',
        types: ['movie', 'series'],
        idPrefixes: ['tt', 'kitsu'],
      },
    ],
    types: ['movie', 'series'],
    catalogs: [],
  });
});

// 2. Subtitles Query
router.get(
  '/:config/subtitles/:type/:id{/:extra}.json',
  async (
    req: Request<{ config: string; type: string; id: string; extra?: string }>,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const cfg = parseConfig(req.params.config);
      const { type, id } = req.params;
      const langs = (cfg.languages || 'en').split(',').map((l) => l.trim()).filter(Boolean);

      // Resolve query title via MetadataService
      const metadataService = new MetadataService();
      let queryTitle: string | undefined;

      try {
        const meta = await metadataService.getMetadata(type, id);
        if (meta?.title) {
          if (type === 'series') {
            const parts = id.split(':');
            const season = parts[1] ? Number(parts[1]) : undefined;
            const episode = parts[2] ? Number(parts[2]) : undefined;
            if (season !== undefined && episode !== undefined) {
              queryTitle = `${meta.title} S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}`;
            } else {
              queryTitle = meta.title;
            }
          } else {
            queryTitle = meta.year ? `${meta.title} ${meta.year}` : meta.title;
          }
        }
      } catch (err: any) {
        logger.debug({ err: err?.message, id }, 'Could not resolve metadata title for subtitles');
      }

      if (!queryTitle) {
        // Fallback: parse IMDb format or raw string
        if (id.startsWith('tt')) {
          const parts = id.split(':');
          if (parts.length >= 3) {
            queryTitle = `${parts[0]} S${Number(parts[1]).toString().padStart(2, '0')}E${Number(parts[2]).toString().padStart(2, '0')}`;
          } else {
            queryTitle = parts[0];
          }
        } else {
          queryTitle = id;
        }
      }

      const allItems = await Promise.all(
        langs.map(async (lang) => {
          return await searchDeepbridOpenSubtitles(queryTitle!, lang);
        })
      );

      let flatItems = allItems.flat();

      if (cfg.hearingImpaired === 'exclude') {
        flatItems = flatItems.filter((i) => !i.hearing_impaired);
      } else if (cfg.hearingImpaired === 'only') {
        flatItems = flatItems.filter((i) => i.hearing_impaired);
      }

      const baseUrl = appConfig.bootstrap.baseUrl || `http://${req.headers.host}`;
      const formatted = formatDeepbridSubtitles(
        flatItems,
        baseUrl,
        cfg.maxSubtitles ?? 10
      );

      res.set('Cache-Control', 'public, max-age=1800');
      res.json({ subtitles: formatted });
    } catch (error) {
      next(error);
    }
  }
);

// 3. VTT Download Proxy
router.get(
  '/download/:fileId{/:filename}',
  async (
    req: Request<{ fileId: string; filename?: string }>,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const { fileId } = req.params;
      const downloadUrl = `${DEEPBRID_SUBTITLE_BASE}/web/sub/osdownload?file_id=${encodeURIComponent(
        fileId
      )}`;

      const upstream = await makeRequest(downloadUrl, {
        method: 'POST',
        headers: {
          'User-Agent': DEEPBRID_SUBTITLE_USER_AGENT,
          Referer: 'https://www.deepbrid.com/',
        },
        timeout: 15_000,
      });

      if (!upstream.ok) {
        res.status(upstream.status || 502).end();
        return;
      }

      res.set('Content-Type', 'text/vtt; charset=utf-8');
      res.set('Cache-Control', 'public, max-age=86400, immutable');
      res.set('Access-Control-Allow-Origin', '*');

      if (upstream.body) {
        await pipeline(upstream.body, res);
      } else {
        res.end();
      }
    } catch (error) {
      next(error);
    }
  }
);

export default router;
