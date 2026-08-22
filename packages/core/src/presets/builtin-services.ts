import {
  BUILTIN_SUPPORTED_SERVICES,
  type BuiltinServiceId,
  type ServiceId,
} from '../utils/constants.js';

const builtinServiceIds = new Set<string>(BUILTIN_SUPPORTED_SERVICES);

/**
 * Keep only services the native resolver can instantiate. Integration-only
 * services (for example TorrentClaw) still belong in UserData, but must not be
 * copied into encrypted built-in addon configs.
 */
export function filterBuiltinServiceIds(
  services: readonly ServiceId[]
): BuiltinServiceId[] {
  return [...new Set(services)].filter(
    (service): service is BuiltinServiceId => builtinServiceIds.has(service)
  );
}
