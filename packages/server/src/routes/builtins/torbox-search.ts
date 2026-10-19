import { Router, Request, Response, NextFunction } from 'express';
import {
  createLogger,
  TorBoxSearchAddon,
  decodeTorboxSearchConfig,
  TORBOX_SEARCH_CONFIG_HEADER,
  APIError,
  constants,
} from '@aiostreams/core';
const router: Router = Router();

const logger = createLogger('builtins:torbox-search');

function getConfig(configId: string, serializedConfig: string | undefined) {
  return decodeTorboxSearchConfig(configId, serializedConfig);
}

interface TorboxManifestParams {
  configId: string;
}

router.get(
  '/:encodedConfig/manifest.json',
  async (
    req: Request<TorboxManifestParams>,
    res: Response,
    next: NextFunction
  ) => {
    const { configId } = req.params;
    try {
      const manifest = new TorBoxSearchAddon(
        getConfig(configId, req.get(TORBOX_SEARCH_CONFIG_HEADER)),
        req.userIp
      ).getManifest();
      res.set('Cache-Control', 'private, no-store');
      res.json(manifest);
    } catch (error) {
      next(error);
    }
  }
);

interface TorboxStreamParams {
  configId: string;
  type: string;
  id: string;
}

router.get(
  '/:encodedConfig/stream/:type/:id.json',
  async (
    req: Request<TorboxStreamParams>,
    res: Response,
    next: NextFunction
  ) => {
    const { configId, type, id } = req.params;

    try {
      const addon = new TorBoxSearchAddon(
        getConfig(configId, req.get(TORBOX_SEARCH_CONFIG_HEADER)),
        req.userIp
      );
      const streams = await addon.getStreams(type, id);
      res.set('Cache-Control', 'private, no-store');
      res.json({
        streams: streams,
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
