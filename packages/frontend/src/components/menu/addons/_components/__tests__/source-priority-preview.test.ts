import { describe, expect, it } from 'vitest';
import { buildSourcePriorityPreview } from '../source-priority-preview.js';

describe('buildSourcePriorityPreview', () => {
  it('shows enabled source order and the equivalent-result dedup winner', () => {
    const result = buildSourcePriorityPreview([
      { instanceId: 'first', name: 'Deepbrid Usenet', enabled: true },
      { instanceId: 'disabled', name: 'Hidden source', enabled: false },
      { instanceId: 'second', name: 'TorrentClaw', enabled: true },
    ]);

    expect(result.ranked.map(({ name }) => name)).toEqual([
      'Deepbrid Usenet',
      'TorrentClaw',
    ]);
    expect(result.dedupWinner?.name).toBe('Deepbrid Usenet');
  });

  it('bounds the visible preview and reports omitted enabled entries', () => {
    const result = buildSourcePriorityPreview(
      Array.from({ length: 12 }, (_, index) => ({
        instanceId: `source-${index}`,
        name: `Source ${index}`,
        enabled: true,
      })),
      4
    );

    expect(result.ranked).toHaveLength(4);
    expect(result.omittedCount).toBe(8);
  });

  it('returns no winner when all add-ons are disabled', () => {
    const result = buildSourcePriorityPreview([
      { instanceId: 'off', name: 'Disabled', enabled: false },
    ]);

    expect(result.ranked).toEqual([]);
    expect(result.dedupWinner).toBeUndefined();
  });
});
