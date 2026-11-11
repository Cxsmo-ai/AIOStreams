export type DeepbridPlaybackMode = 'direct' | 'remux' | 'hls';
export type DeepbridPlaybackSelection = DeepbridPlaybackMode | 'all';

export interface DeepbridPlaybackVariant {
  mode: DeepbridPlaybackMode;
  label: 'NATIVE' | 'REMUX' | 'HLS';
  url: string;
}

export interface DeepbridPlaybackVariantPayload {
  apiKey: string;
  url: string;
  filename: string;
  size?: number;
}

/** The player's "all" choice fans each Finder file into three choices. */
export function deepbridPlaybackModes(
  mode: DeepbridPlaybackSelection | undefined
): DeepbridPlaybackMode[] {
  return mode === 'all' ? ['direct', 'remux', 'hls'] : [mode ?? 'direct'];
}

/** Bind a configured player mode to the exact playable URL builder. */
export function buildDeepbridPlaybackVariants(
  payload: DeepbridPlaybackVariantPayload,
  selectedMode: DeepbridPlaybackSelection | undefined,
  createPlaybackUrl: (
    payload: DeepbridPlaybackVariantPayload & { mode: DeepbridPlaybackMode }
  ) => string
): DeepbridPlaybackVariant[] {
  return deepbridPlaybackModes(selectedMode).map((mode) => ({
    mode,
    label:
      mode === 'direct' ? 'NATIVE' : mode === 'remux' ? 'REMUX' : 'HLS',
    url: createPlaybackUrl({ ...payload, mode }),
  }));
}
