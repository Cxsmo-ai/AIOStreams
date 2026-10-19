import { describe, expect, it } from 'vitest';
import {
  applyServiceMetadata,
  enableServiceAfterCredentialSave,
} from '../service-status';

type TestService = {
  enabled?: boolean;
  credentials: Record<string, string>;
};

describe('applyServiceMetadata', () => {
  const metadata = {
    credentials: [
      { id: 'apiKey', required: true, default: 'server-default' },
      { id: 'unarrUrl', required: false, default: null },
    ],
  };

  it('keeps an explicit disabled choice when defaults are available', () => {
    const result = applyServiceMetadata<TestService>(
      { enabled: false, credentials: {} },
      metadata
    );

    expect(result.enabled).toBe(false);
    expect(result.credentials.apiKey).toBe('server-default');
  });

  it('does not replace a user-supplied credential with a default', () => {
    const result = applyServiceMetadata<TestService>(
      { enabled: true, credentials: { apiKey: 'my-own-key' } },
      metadata
    );

    expect(result.credentials.apiKey).toBe('my-own-key');
    expect(result.enabled).toBe(true);
  });

  it('infers state for legacy entries but ignores missing optional credentials', () => {
    const result = applyServiceMetadata<TestService>(
      { credentials: { apiKey: 'profile-key' } },
      {
        credentials: [
          { id: 'apiKey', required: true },
          { id: 'unarrUrl', required: false },
        ],
      }
    );

    expect(result.enabled).toBe(true);
  });

  it('still applies an explicitly forced value', () => {
    const result = applyServiceMetadata<TestService>(
      { enabled: true, credentials: { apiKey: 'my-own-key' } },
      { credentials: [{ id: 'apiKey', required: true, forced: 'forced-key' }] }
    );

    expect(result.credentials.apiKey).toBe('forced-key');
  });
});

describe('enableServiceAfterCredentialSave', () => {
  it('enables TorrentClaw when a saved API key is present', () => {
    expect(
      enableServiceAfterCredentialSave('torrentclaw', false, {
        apiKey: ' tc_test-key ',
      })
    ).toBe(true);
  });

  it('preserves a disabled TorrentClaw choice when no key was entered', () => {
    expect(
      enableServiceAfterCredentialSave('torrentclaw', false, { apiKey: '  ' })
    ).toBe(false);
  });

  it('does not auto-enable unrelated services', () => {
    expect(
      enableServiceAfterCredentialSave('torbox', false, { apiKey: 'key' })
    ).toBe(false);
  });
});
