export interface SourcePriorityPreviewItem {
  instanceId: string;
  name: string;
  enabled: boolean;
}

export interface SourcePriorityPreview {
  ranked: Array<{ instanceId: string; name: string; rank: number }>;
  dedupWinner?: { instanceId: string; name: string };
  disabledCount: number;
  omittedCount: number;
}

/**
 * Model the add-on-order tiebreaker for equivalent sample results.
 * This intentionally does not pretend to predict title, quality, or other
 * sorting criteria; those still take precedence when they distinguish results.
 */
export function buildSourcePriorityPreview(
  items: readonly SourcePriorityPreviewItem[],
  visibleLimit = 5
): SourcePriorityPreview {
  const limit = Math.max(1, Math.min(10, Math.floor(visibleLimit) || 5));
  const enabled = items.filter((item) => item.enabled);
  const ranked = enabled.slice(0, limit).map((item, index) => ({
    instanceId: item.instanceId,
    name: item.name,
    rank: index + 1,
  }));
  const winner = enabled[0];

  return {
    ranked,
    dedupWinner: winner
      ? { instanceId: winner.instanceId, name: winner.name }
      : undefined,
    disabledCount: items.length - enabled.length,
    omittedCount: Math.max(0, enabled.length - ranked.length),
  };
}
