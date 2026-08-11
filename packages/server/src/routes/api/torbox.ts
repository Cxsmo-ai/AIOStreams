import { Router } from 'express';
import {
  TorboxClient,
  torboxDeviceFlows,
  type TorboxUserSettings,
} from '@aiostreams/core';
import { userApiRateLimiter } from '../../middlewares/ratelimit.js';
import { createResponse } from '../../utils/responses.js';

const router: Router = Router();
const client = new TorboxClient();

router.use(userApiRateLimiter);

router.post('/device/start', async (_req, res, next) => {
  try {
    const flow = await torboxDeviceFlows.start();
    res.status(201).json(createResponse({ success: true, data: flow }));
  } catch (error) {
    next(error);
  }
});

router.post('/device/status', async (req, res, next) => {
  try {
    const { flowId, flowSecret } = req.body ?? {};
    if (typeof flowId !== 'string' || typeof flowSecret !== 'string') {
      res.status(400).json(
        createResponse({
          success: false,
          detail: 'flowId and flowSecret are required',
        })
      );
      return;
    }
    const flow = await torboxDeviceFlows.status(flowId, flowSecret);
    res.status(200).json(createResponse({ success: true, data: flow }));
  } catch (error) {
    next(error);
  }
});

router.post('/device/cancel', (req, res, next) => {
  try {
    const { flowId, flowSecret } = req.body ?? {};
    if (typeof flowId !== 'string' || typeof flowSecret !== 'string') {
      res.status(400).json(
        createResponse({
          success: false,
          detail: 'flowId and flowSecret are required',
        })
      );
      return;
    }
    const flow = torboxDeviceFlows.cancel(flowId, flowSecret);
    res.status(200).json(createResponse({ success: true, data: flow }));
  } catch (error) {
    next(error);
  }
});

router.post('/validate', async (req, res, next) => {
  try {
    const token = req.body?.token;
    if (typeof token !== 'string' || !token) {
      res
        .status(400)
        .json(createResponse({ success: false, detail: 'token is required' }));
      return;
    }
    const account = await client.getUserSettings(token);
    res
      .status(200)
      .json(
        createResponse({ success: true, data: { settings: account.settings } })
      );
  } catch (error) {
    next(error);
  }
});

router.put('/settings', async (req, res, next) => {
  try {
    const token = req.body?.token;
    const settings = req.body?.settings as Partial<TorboxUserSettings>;
    if (typeof token !== 'string' || !token || !settings) {
      res.status(400).json(
        createResponse({
          success: false,
          detail: 'token and settings are required',
        })
      );
      return;
    }
    const allowed: Partial<TorboxUserSettings> = {};
    for (const key of [
      'stremio_wait_for_download_torrent',
      'stremio_wait_for_download_usenet',
    ] as const) {
      if (typeof settings[key] === 'boolean') allowed[key] = settings[key];
    }
    if (!Object.keys(allowed).length) {
      res.status(400).json(
        createResponse({
          success: false,
          detail: 'No supported TorBox settings were supplied',
        })
      );
      return;
    }
    await client.editSettings(token, allowed);
    const account = await client.getUserSettings(token);
    res
      .status(200)
      .json(
        createResponse({ success: true, data: { settings: account.settings } })
      );
  } catch (error) {
    next(error);
  }
});

export default router;
