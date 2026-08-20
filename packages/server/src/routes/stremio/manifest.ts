import { Router, Request, Response, NextFunction } from 'express';
import {
  AIOStreams,
  APIError,
  config as appConfig,
  constants,
  UserData,
  userScopeIdSuffix,
} from '@aiostreams/core';
import { Manifest } from '@aiostreams/core';
import { createLogger } from '@aiostreams/core';

const logger = createLogger('server');
const router: Router = Router();

export default router;

const manifest = async (config?: UserData): Promise<Manifest> => {
  const isWakoP2p = config?.activeClientManifest === 'wako-p2p';
  let addonId = appConfig.branding.addonId;
  if (config) {
    addonId = addonId += `.${userScopeIdSuffix(config)}`;
  }
  if (isWakoP2p) {
    addonId += '.wako-p2p';
  }
  let catalogs: Manifest['catalogs'] = [];
  let resources: Manifest['resources'] = [];
  let addonCatalogs: Manifest['addonCatalogs'] = [];
  if (config) {
    const aiostreams = new AIOStreams(config, { skipFailedAddons: true });

    await aiostreams.initialise();

    catalogs = aiostreams.getCatalogs();
    resources = aiostreams.getResources();
    addonCatalogs = aiostreams.getAddonCatalogs();

    if (isWakoP2p) {
      catalogs = [];
      addonCatalogs = [];
      resources = resources.filter(
        (resource) =>
          (typeof resource === 'string' ? resource : resource.name) === 'stream'
      );
    }
  }
  return {
    name: isWakoP2p
      ? `${config?.addonName || appConfig.branding.addonName} · Wako P2P`
      : config?.addonName || appConfig.branding.addonName,
    id: addonId,
    version:
      !appConfig.bootstrap.version ||
      appConfig.bootstrap.version === 'unknown' ||
      appConfig.bootstrap.version === '0.0.0'
        ? '2.33.0'
        : appConfig.bootstrap.version,
    description: isWakoP2p
      ? 'AIOStreams client profile for Wako. Returns native P2P torrents from only the addons selected for this profile and waits for every selected addon.'
      : config?.addonDescription ||
        (appConfig.bootstrap.description &&
        appConfig.bootstrap.description !== 'unknown'
          ? appConfig.bootstrap.description
          : 'Consolidate multiple Stremio addons and debrid/usenet services into a single super-addon with custom filtering, sorting, and formatting.'),
    catalogs,
    resources,
    types: resources.reduce((types, resource) => {
      const resourceTypes =
        typeof resource === 'string' ? [resource] : resource.types;
      return [...new Set([...types, ...resourceTypes])];
    }, [] as string[]),
    logo:
      config?.addonLogo ||
      `https://raw.githubusercontent.com/Viren070/AIOStreams/refs/heads/main/packages/frontend/public/logo${
        appConfig.branding.alternateDesign ? '_alt' : ''
      }.png`,
    behaviorHints: {
      configurable: true,
      configurationRequired: config ? false : true,
    },
    addonCatalogs,
    stremioAddonsConfig:
      appConfig.api.stremioAddonsConfigIssuer &&
      appConfig.api.stremioAddonsConfigSignature
        ? {
            issuer: appConfig.api.stremioAddonsConfigIssuer,
            signature: appConfig.api.stremioAddonsConfigSignature,
          }
        : undefined,
  };
};

router.get(
  '/',
  async (req: Request, res: Response<Manifest>, next: NextFunction) => {
    logger.info({ uuid: req.userData?.uuid }, 'received request for manifest');
    try {
      res.status(200).json(await manifest(req.userData));
    } catch (error) {
      logger.error(`Failed to generate manifest: ${error}`);
      next(new APIError(constants.ErrorCode.INTERNAL_SERVER_ERROR));
    }
  }
);
