import { NextFunction, Request, Response, Router } from 'express';
import { makeRequest, Meta, userScopeIdSuffix } from '@aiostreams/core';
import {
  enrichEnhancedCinemetaMeta,
  filterEnhancedCinemetaResources,
} from './enhancedCinemetaMetadata.js';

const CINEMETA_BASE_URL = 'https://v3-cinemeta.strem.io';
const router: Router = Router();
function upstreamUrl(path: string, query: Request['query']): string {
  const url = new URL(path, CINEMETA_BASE_URL);
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (typeof item === 'string') url.searchParams.append(key, item);
      });
    } else if (typeof value === 'string') url.searchParams.set(key, value);
  }
  return url.toString();
}

async function fetchCinemeta(path: string, query: Request['query'] = {}) {
  const response = await makeRequest(upstreamUrl(path, query), {
    timeout: 6_000,
  });
  if (!response.ok) throw new Error(`Cinemeta returned ${response.status}`);
  return response.json();
}

router.get(
  '/manifest.json',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const upstream = (await fetchCinemeta('/manifest.json')) as Record<
        string,
        unknown
      >;
      const upstreamResources = Array.isArray(upstream.resources)
        ? upstream.resources
        : [];
      const upstreamBehaviorHints =
        upstream.behaviorHints && typeof upstream.behaviorHints === 'object'
          ? (upstream.behaviorHints as Record<string, unknown>)
          : {};
      res.set('Cache-Control', 'private, max-age=300').json({
        ...upstream,
        id: `com.aiostreams.enhanced-cinemeta.${userScopeIdSuffix(req.userData!)}`,
        name: 'Enhanced Cinemeta',
        description:
          'Cinemeta catalogs and stable IDs, enriched with TorrentClaw season and episode metadata. Streams remain with your configured AIOStreams sources.',
        // Keep the standard catalog declarations untouched; expose all three
        // Cinemeta resources that this companion proxies below.
        resources: filterEnhancedCinemetaResources(upstreamResources),
        behaviorHints: { ...upstreamBehaviorHints, p2p: false },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/catalog/:type/:id{/:extras}.json',
  async (
    req: Request<{ type: string; id: string; extras?: string }>,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const { type, id, extras } = req.params;
      const path = `/catalog/${encodeURIComponent(type)}/${encodeURIComponent(id)}${extras ? `/${encodeURIComponent(extras)}` : ''}.json`;
      const data = await fetchCinemeta(path, req.query);
      res.set('Cache-Control', 'public, max-age=300').json(data);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/addon_catalog/:type/:id.json',
  async (
    req: Request<{ type: string; id: string }>,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const { type, id } = req.params;
      const path = `/addon_catalog/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
      const data = await fetchCinemeta(path, req.query);
      res.set('Cache-Control', 'public, max-age=300').json(data);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/meta/:type/:id.json',
  async (
    req: Request<{ type: string; id: string }>,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const { type, id } = req.params;
      const response = (await fetchCinemeta(
        `/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`,
        req.query
      )) as { meta?: Meta };
      if (!response.meta) {
        res.status(404).json({ error: 'Cinemeta metadata not found' });
        return;
      }

      res.set('Cache-Control', 'private, max-age=300').json({
        meta: await enrichEnhancedCinemetaMeta(
          response.meta,
          type,
          id,
          req.userData!
        ),
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
