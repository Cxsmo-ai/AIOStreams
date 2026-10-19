import { createHmac, timingSafeEqual } from 'node:crypto';
import { config as appConfig } from '../../config/index.js';
import type { TorBoxSearchAddonConfig } from './addon.js';

export const TORBOX_SEARCH_CONFIG_HEADER = 'x-aiostreams-torbox-search-config';

function serialize(config: unknown): string {
  const serialized = JSON.stringify(config);
  if (serialized === undefined) {
    throw new Error('Invalid TorBox Search configuration.');
  }
  return serialized;
}

/** Stable, opaque URL identifier; configuration and credentials are not in the URL. */
export function createTorboxSearchConfigId(config: unknown): string {
  return createHmac('sha256', appConfig.bootstrap.internalSecret)
    .update(serialize(config))
    .digest('base64url');
}

/** Verify that the internal-only header belongs to the opaque URL identifier. */
export function decodeTorboxSearchConfig(
  configId: string,
  serializedConfig: string | undefined
): TorBoxSearchAddonConfig {
  if (!serializedConfig || !configId) {
    throw new Error('TorBox Search configuration is required.');
  }

  const expected = Buffer.from(
    createTorboxSearchConfigId(JSON.parse(serializedConfig))
  );
  const actual = Buffer.from(configId);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('Invalid TorBox Search configuration reference.');
  }

  return JSON.parse(serializedConfig) as TorBoxSearchAddonConfig;
}
