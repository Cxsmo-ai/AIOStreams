/**
 * TorrentClaw can expose info-hash results for AIOStreams to resolve through
 * configured debrid services. Keep that automatic path local to TorrentClaw;
 * the user-facing Service Wrap setting continues to control every other addon.
 */
export function shouldAutoWrapTorrentClaw(input: {
  presetType: string;
  supportsP2P: boolean;
  supportedServiceIds: readonly string[];
  enabledServiceIds: readonly string[];
}): boolean {
  if (input.presetType !== 'torrentclaw' || !input.supportsP2P) return false;

  const supportedServices = new Set(input.supportedServiceIds);
  return input.enabledServiceIds.some((serviceId) =>
    supportedServices.has(serviceId)
  );
}
