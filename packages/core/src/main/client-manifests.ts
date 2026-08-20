import type { UserData } from '../db/index.js';
import { constants } from '../utils/index.js';

export const CLIENT_MANIFEST_PROFILES = ['wako-p2p'] as const;

export type ClientManifestProfile = (typeof CLIENT_MANIFEST_PROFILES)[number];

export class ClientManifestProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientManifestProfileError';
  }
}

export function isP2pCapablePreset(
  type: string,
  p2pPresetTypes: ReadonlySet<string>
): boolean {
  return p2pPresetTypes.has(type);
}

/**
 * Returns an isolated, request-scoped configuration for a client manifest.
 * The stored configuration is never mutated.
 *
 * The normal profile only applies the user's exclusion list. The Wako profile
 * deliberately removes every debrid/Usenet service path and only permits
 * presets that explicitly advertise native P2P output.
 */
export function applyClientManifestProfile(
  userData: UserData,
  profile?: ClientManifestProfile,
  p2pPresetTypes: ReadonlySet<string> = new Set()
): UserData {
  const result = structuredClone(userData);

  // Request-only state must never influence a later normal request, even if a
  // client submitted it as part of a configuration payload.
  result.activeClientManifest = undefined;

  if (!profile) {
    const excluded = new Set(
      result.clientManifests?.normal?.excludedPresetIds ?? []
    );
    result.presets = result.presets.filter(
      (preset) => !excluded.has(preset.instanceId)
    );
    return result;
  }

  if (profile !== 'wako-p2p') {
    throw new ClientManifestProfileError(
      `Unsupported client manifest profile: ${String(profile)}`
    );
  }

  const wako = result.clientManifests?.wakoP2p;
  if (!wako?.enabled) {
    throw new ClientManifestProfileError(
      'The Wako P2P manifest is not enabled for this configuration.'
    );
  }

  const selected = new Set(wako.presetIds ?? []);
  result.presets = result.presets
    .filter(
      (preset) =>
        preset.enabled &&
        selected.has(preset.instanceId) &&
        isP2pCapablePreset(preset.type, p2pPresetTypes)
    )
    .map((preset) => ({
      ...preset,
      options: {
        ...preset.options,
        // Presets use an empty service selection as their native P2P mode.
        services: [],
      },
    }));

  if (result.presets.length === 0) {
    throw new ClientManifestProfileError(
      'The Wako P2P manifest has no enabled P2P-capable addons selected.'
    );
  }

  result.activeClientManifest = profile;
  result.services = [];
  result.serviceWrap = { ...result.serviceWrap, enabled: false };
  result.failover = { ...result.failover, enabled: false };
  result.dynamicAddonFetching = {
    ...result.dynamicAddonFetching,
    enabled: false,
  };
  result.groups = { ...result.groups, enabled: false };
  result.externalDownloads = false;

  // Included stream types bypass the rest of filtering, so retain only an
  // existing P2P inclusion. Requiring P2P then rejects every URL/debrid/Usenet
  // result even if an upstream addon unexpectedly returns one.
  result.includedStreamTypes = result.includedStreamTypes?.filter(
    (type) => type === constants.P2P_STREAM_TYPE
  );
  result.excludedStreamTypes = result.excludedStreamTypes?.filter(
    (type) => type !== constants.P2P_STREAM_TYPE
  );
  result.requiredStreamTypes = [constants.P2P_STREAM_TYPE];

  return result;
}
