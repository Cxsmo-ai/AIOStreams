import { describe, expect, it } from 'vitest';
import {
  normaliseBuildCommit,
  shouldReloadForBuildMismatch,
} from '../build-sync';

describe('frontend build synchronisation', () => {
  it('normalises full and short hashes to the same build id', () => {
    expect(normaliseBuildCommit('F6903DE2A7A5417D')).toBe('f6903de2');
  });

  it('does not reload when frontend and server builds match', () => {
    expect(shouldReloadForBuildMismatch('f6903de2', 'f6903de2')).toBe(false);
  });

  it('reloads once when a stale frontend reaches a newer server', () => {
    expect(shouldReloadForBuildMismatch('0745af6d', 'f6903de2')).toBe(true);
    expect(
      shouldReloadForBuildMismatch('0745af6d', 'f6903de2', 'f6903de2')
    ).toBe(false);
  });

  it('does not reload unknown or development builds', () => {
    expect(shouldReloadForBuildMismatch('unknown', 'f6903de2')).toBe(false);
    expect(shouldReloadForBuildMismatch('0745af6d', 'unknown')).toBe(false);
  });
});
