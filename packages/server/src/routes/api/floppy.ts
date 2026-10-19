import { Router, type Request } from 'express';
import {
  APIError,
  constants,
  removeFloppyAccount,
  storeFloppyAccount,
  UserRepository,
} from '@aiostreams/core';
import { userApiRateLimiter } from '../../middlewares/ratelimit.js';
import { parseBasicAuthHeader } from '../../utils/basic-auth.js';

type TrackerUser = {
  trackerProviders?: Record<string, { authRef?: string; enabled?: boolean }>;
};

export type FloppyRouterDependencies = {
  authenticate: (uuid: string, password: string) => Promise<TrackerUser | null>;
  storeAccount: (baseUrl: string, apiToken: string) => Promise<string>;
  removeAccount: (reference: string) => Promise<void>;
  rateLimiter?: import('express').RequestHandler;
};

export function createFloppyRouter(
  dependencies: FloppyRouterDependencies = {
    authenticate: async (uuid, password) =>
      (await UserRepository.getUser(uuid, password)) ?? null,
    storeAccount: storeFloppyAccount,
    removeAccount: removeFloppyAccount,
    rateLimiter: userApiRateLimiter,
  }
): Router {
  const router = Router();
  router.use(dependencies.rateLimiter ?? userApiRateLimiter);

  async function authenticatedUser(req: Request) {
    const credentials = parseBasicAuthHeader(req, { allowEncrypted: false });
    if (!credentials)
      throw new APIError(
        constants.ErrorCode.UNAUTHORIZED,
        undefined,
        'Basic AIOStreams credentials required'
      );
    const user = await dependencies.authenticate(credentials.uuid, credentials.password);
    if (!user) throw new APIError(constants.ErrorCode.UNAUTHORIZED);
    return user;
  }

  router.post('/link', async (req, res, next) => {
    try {
      await authenticatedUser(req);
      const body = req.body && typeof req.body === 'object'
        ? (req.body as Record<string, unknown>)
        : {};
      const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl : '';
      const apiToken = typeof body.apiToken === 'string' ? body.apiToken : '';
      const authRef = await dependencies.storeAccount(baseUrl, apiToken);
      res.status(200).json({ success: true, authRef });
    } catch (error) {
      if (error instanceof APIError) next(error);
      else
        res.status(400).json({
          error: error instanceof Error ? error.message : 'Floppy authorization failed',
        });
    }
  });

  router.delete('/link/:authRef', async (req, res, next) => {
    let user: TrackerUser;
    try {
      user = await authenticatedUser(req);
    } catch (error) {
      next(error);
      return;
    }
    const authRef = String(req.params.authRef ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(authRef)) {
      res.status(400).json({ error: 'Invalid Floppy account reference' });
      return;
    }
    if (user.trackerProviders?.floppy?.authRef !== authRef) {
      res.status(404).json({ error: 'Floppy account link not found' });
      return;
    }
    try {
      await dependencies.removeAccount(authRef);
      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createFloppyRouter();
