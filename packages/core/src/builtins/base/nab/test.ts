import { createLogger } from '../../../utils/index.js';
import { BaseNabApi, type NabTestResult } from './api.js';

const logger = createLogger('nab-test');

export type NabNamespaceId = 'newznab' | 'torznab';

/**
 * Probe a newznab/torznab endpoint
 */
export async function testNabEndpoint(args: {
  namespace: NabNamespaceId;
  url: string;
  apiKey?: string;
}): Promise<NabTestResult> {
  let api: BaseNabApi<NabNamespaceId>;
  try {
    api = new BaseNabApi(args.namespace, logger, args.url, args.apiKey, '');
  } catch {
    return {
      ok: false,
      stage: 'caps',
      error: { message: 'That does not look like a valid URL' },
    };
  }
  return api.testConnection();
}
