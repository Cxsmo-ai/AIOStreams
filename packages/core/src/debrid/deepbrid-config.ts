import type { DebridServiceConfig } from './base.js';

const DEFAULT_DEEPBRID_PRECACHE_LIMIT = 24;

/** Normalize persisted service-form values for every Deepbrid entry point. */
export function getDeepbridPreCacheOptions(
  credentials?: Record<string, unknown>
): Pick<DebridServiceConfig, 'preCache' | 'preCacheLimit'> {
  const rawEnabled = credentials?.preCache;
  const preCache =
    rawEnabled === true ||
    (typeof rawEnabled === 'string' && rawEnabled.toLowerCase() === 'true');
  const parsedLimit = Number.parseInt(String(credentials?.preCacheLimit ?? ''), 10);
  return {
    preCache,
    preCacheLimit: Math.min(
      100,
      Math.max(
        1,
        Number.isFinite(parsedLimit)
          ? parsedLimit
          : DEFAULT_DEEPBRID_PRECACHE_LIMIT
      )
    ),
  };
}
