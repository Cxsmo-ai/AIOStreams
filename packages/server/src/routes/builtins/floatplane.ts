import { Router, Request, NextFunction } from 'express';
import {
  FloatplaneAddon,
  fromUrlSafeBase64,
  resolveFloatplaneAuth,
} from '@aiostreams/core';

const router: Router = Router();
async function addon(encoded: string) {
  const value = JSON.parse(fromUrlSafeBase64(encoded));
  return new FloatplaneAddon({
    ...value,
    auth: await resolveFloatplaneAuth(value.authRef),
  });
}
router.get(
  '{/:encodedConfig}/manifest.json',
  async (req: Request<{ encodedConfig?: string }>, res, next) => {
    try {
      res.json(FloatplaneAddon.getManifest());
    } catch (e) {
      next(e);
    }
  }
);
router.get(
  '/:encodedConfig/catalog/:type/:id{/:extras}.json',
  async (
    req: Request<{
      encodedConfig: string;
      type: string;
      id: string;
      extras?: string;
    }>,
    res,
    next: NextFunction
  ) => {
    try {
      res.json({
        metas: await (
          await addon(req.params.encodedConfig)
        ).getCatalog(req.params.type, req.params.id, req.params.extras),
      });
    } catch (e) {
      next(e);
    }
  }
);
router.get(
  '/:encodedConfig/meta/:type/:id.json',
  async (
    req: Request<{ encodedConfig: string; type: string; id: string }>,
    res,
    next: NextFunction
  ) => {
    try {
      res.json({
        meta: await (
          await addon(req.params.encodedConfig)
        ).getMeta(req.params.type, req.params.id),
      });
    } catch (e) {
      next(e);
    }
  }
);
router.get(
  '/:encodedConfig/stream/:type/:id.json',
  async (
    req: Request<{ encodedConfig: string; type: string; id: string }>,
    res,
    next: NextFunction
  ) => {
    try {
      res.json({
        streams: await (
          await addon(req.params.encodedConfig)
        ).getStreams(req.params.type, req.params.id),
      });
    } catch (e) {
      next(e);
    }
  }
);
router.get(
  '/:encodedConfig/subtitles/:type/:id.json',
  async (
    req: Request<{ encodedConfig: string; type: string; id: string }>,
    res,
    next: NextFunction
  ) => {
    try {
      res.json({
        subtitles: await (
          await addon(req.params.encodedConfig)
        ).getSubtitles(req.params.type, req.params.id),
      });
    } catch (e) {
      next(e);
    }
  }
);
export default router;
