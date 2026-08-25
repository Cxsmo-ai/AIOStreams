import { NextFunction, Request, Response, Router } from 'express';
import {
  KuratoAddon,
  decryptString,
} from '@aiostreams/core';

const router: Router = Router();

function getConfig(encodedConfig: string) {
  const decrypted = decryptString(encodedConfig);
  if (!decrypted.success || !decrypted.data) {
    throw new Error('Invalid encrypted Kurato configuration.');
  }
  return JSON.parse(decrypted.data);
}

interface ConfigParams { encodedConfig: string }
interface CatalogParams extends ConfigParams { type: string; id: string; extras?: string }
interface MetaParams extends ConfigParams { type: string; id: string }

router.get(
  '/:encodedConfig/manifest.json',
  (req: Request<ConfigParams>, res: Response, next: NextFunction) => {
    try {
      res.set('Cache-Control', 'private, no-store');
      res.json(new KuratoAddon(getConfig(req.params.encodedConfig)).getManifest());
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/:encodedConfig/catalog/:type/:id{/:extras}.json',
  async (req: Request<CatalogParams>, res: Response, next: NextFunction) => {
    try {
      const addon = new KuratoAddon(getConfig(req.params.encodedConfig));
      res.set('Cache-Control', 'private, no-store');
      res.json({ metas: await addon.getCatalog(req.params.type, req.params.id, req.params.extras) });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/:encodedConfig/meta/:type/:id.json',
  async (req: Request<MetaParams>, res: Response, next: NextFunction) => {
    try {
      const addon = new KuratoAddon(getConfig(req.params.encodedConfig));
      res.set('Cache-Control', 'private, no-store');
      res.json({ meta: await addon.getMeta(req.params.type, req.params.id) });
    } catch (error) {
      next(error);
    }
  }
);

// Stremio sends searches to catalog endpoints with the search extra.
// Keeping this route explicit also supports clients that call a dedicated search resource.
router.get(
  '/:encodedConfig/search/:type/:query{/:extras}.json',
  async (req: Request<ConfigParams & { type: string; query: string; extras?: string }>, res: Response, next: NextFunction) => {
    try {
      const addon = new KuratoAddon(getConfig(req.params.encodedConfig));
      res.set('Cache-Control', 'private, no-store');
      res.json({ metas: await addon.search(req.params.type, decodeURIComponent(req.params.query), req.params.extras) });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
