import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import {
  APIError,
  constants,
  pollTraktDeviceToken,
  removeTraktToken,
  requestTraktDeviceCode,
  storeTraktToken,
  UserRepository,
  type TraktDeviceCode,
  type TraktTrackerApplicationCredentials,
  type TraktTrackerToken,
} from '@aiostreams/core';
import { userApiRateLimiter } from '../../middlewares/ratelimit.js';
import { parseBasicAuthHeader } from '../../utils/basic-auth.js';

type TrackerUser = {
  trackerProviders?: Record<string, { authRef?: string; enabled?: boolean }>;
};

type DeviceLinkState = {
  userUuid: string;
  device: TraktDeviceCode;
  expiresAt: number;
  nextPollAt: number;
  polling: boolean;
  applicationCredentials?: TraktTrackerApplicationCredentials;
  authRef?: string;
  error?: string;
};

export type TraktRouterDependencies = {
  authenticate: (uuid: string, password: string) => Promise<TrackerUser | null>;
  requestDeviceCode: (credentials: TraktTrackerApplicationCredentials) => Promise<TraktDeviceCode>;
  pollDeviceToken: (deviceCode: string, credentials: TraktTrackerApplicationCredentials) => Promise<
    | { status: 'pending'; retryAfter: number }
    | { status: 'authorized'; token: TraktTrackerToken }
  >;
  storeToken: (token: TraktTrackerToken, credentials: TraktTrackerApplicationCredentials) => Promise<string>;
  removeToken: (reference: string) => Promise<void>;
  rateLimiter?: import('express').RequestHandler;
};

export function createTraktRouter(
  dependencies: TraktRouterDependencies = {
    authenticate: async (uuid, password) =>
      (await UserRepository.getUser(uuid, password)) ?? null,
    requestDeviceCode: requestTraktDeviceCode,
    pollDeviceToken: pollTraktDeviceToken,
    storeToken: storeTraktToken,
    removeToken: removeTraktToken,
    rateLimiter: userApiRateLimiter,
  }
): Router {
  const router = Router();
  const states = new Map<string, DeviceLinkState>();
  router.use(dependencies.rateLimiter ?? userApiRateLimiter);

  function cleanExpired(now = Date.now()): void {
    for (const [key, state] of states) {
      if (state.expiresAt <= now) states.delete(key);
    }
  }

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
    return { uuid: credentials.uuid, user };
  }

  router.post('/link/device', async (req, res, next) => {
    cleanExpired();
    try {
      const { uuid } = await authenticatedUser(req);
      const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
      const applicationCredentials: TraktTrackerApplicationCredentials = {
        clientId: typeof body.clientId === 'string' ? body.clientId.trim() : '',
        clientSecret: typeof body.clientSecret === 'string' ? body.clientSecret.trim() : '',
        redirectUri: typeof body.redirectUri === 'string' ? body.redirectUri.trim() : '',
      };
      if (!applicationCredentials.clientId || !applicationCredentials.clientSecret || !applicationCredentials.redirectUri) {
        res.status(400).json({ error: 'This AIOStreams configuration must provide its own Trakt client ID, client secret, and redirect URI.' });
        return;
      }
      const device = await dependencies.requestDeviceCode(applicationCredentials);
      const state = randomUUID();
      const expiresAt = Date.now() + device.expiresIn * 1000;
      states.set(state, {
        userUuid: uuid,
        device,
        expiresAt,
        nextPollAt: 0,
        polling: false,
        applicationCredentials,
      });
      res.status(200).json({
        state,
        userCode: device.userCode,
        verificationUri: device.verificationUri,
        expiresIn: device.expiresIn,
        expiresAt,
        interval: device.interval,
      });
    } catch (error) {
      if (error instanceof APIError) next(error);
      else
        res.status(502).json({
          error: error instanceof Error ? error.message : 'Unable to start Trakt link',
        });
    }
  });

  router.get('/link/status/:state', async (req, res, next) => {
    cleanExpired();
    let uuid: string;
    try {
      ({ uuid } = await authenticatedUser(req));
    } catch (error) {
      next(error);
      return;
    }
    const state = states.get(req.params.state);
    if (!state || state.userUuid !== uuid) {
      res.status(404).json({ status: 'error', error: 'Trakt link not found or expired. Start again.' });
      return;
    }
    if (state.authRef) {
      res.status(200).json({ status: 'authorized', authRef: state.authRef });
      return;
    }
    if (state.error) {
      res.status(502).json({ status: 'error', error: state.error });
      return;
    }
    const now = Date.now();
    if (now < state.nextPollAt || state.polling) {
      res.status(200).json({
        status: 'pending',
        retryAfter: state.polling
          ? state.device.interval
          : Math.max(1, Math.ceil((state.nextPollAt - now) / 1000)),
      });
      return;
    }
    state.polling = true;
    try {
      const applicationCredentials = state.applicationCredentials;
      if (!applicationCredentials) throw new Error('Trakt app credentials expired from the device-link flow; start again.');
      const result = await dependencies.pollDeviceToken(state.device.deviceCode, applicationCredentials);
      if (result.status === 'pending') {
        state.nextPollAt = Date.now() + result.retryAfter * 1000;
        res.status(200).json({ status: 'pending', retryAfter: result.retryAfter });
        return;
      }
      state.authRef = await dependencies.storeToken(result.token, applicationCredentials);
      state.applicationCredentials = undefined;
      state.expiresAt = Date.now() + 10 * 60 * 1000;
      res.status(200).json({ status: 'authorized', authRef: state.authRef });
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Trakt authorization failed';
      state.applicationCredentials = undefined;
      res.status(502).json({ status: 'error', error: state.error });
    } finally {
      state.polling = false;
    }
  });

  router.delete('/link/:authRef', async (req, res, next) => {
    let user: TrackerUser;
    try {
      ({ user } = await authenticatedUser(req));
    } catch (error) {
      next(error);
      return;
    }
    const authRef = String(req.params.authRef ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(authRef)) {
      res.status(400).json({ error: 'Invalid Trakt account reference' });
      return;
    }
    if (user.trackerProviders?.trakt?.authRef !== authRef) {
      res.status(404).json({ error: 'Trakt account link not found' });
      return;
    }
    try {
      await dependencies.removeToken(authRef);
      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createTraktRouter();
