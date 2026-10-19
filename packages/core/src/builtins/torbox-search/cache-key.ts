import { createHmac } from 'node:crypto';
import { config as appConfig } from '../../config/index.js';

/** A stable, server-keyed cache discriminator for a TorBox API key. */
export function torboxSearchCacheDiscriminator(apiKey: string): string {
  return createHmac('sha256', appConfig.bootstrap.internalSecret)
    .update(apiKey)
    .digest('hex');
}
