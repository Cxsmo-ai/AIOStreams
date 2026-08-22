import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UserDataSchema } from './schemas.js';

const minimalUserData = {
  formatter: { id: 'gdrive' },
  sortCriteria: { global: [] },
  presets: [],
};

test('user data accepts TorrentClaw as a credential integration service', () => {
  const parsed = UserDataSchema.safeParse({
    ...minimalUserData,
    services: [
      {
        id: 'torrentclaw',
        enabled: true,
        credentials: {
          apiKey: 'test-only-key',
          unarrUrl: 'https://unarr.app',
        },
      },
    ],
  });

  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
});

test('user data still rejects unknown service ids', () => {
  const parsed = UserDataSchema.safeParse({
    ...minimalUserData,
    services: [
      {
        id: 'not-a-real-service',
        enabled: true,
        credentials: {},
      },
    ],
  });

  assert.equal(parsed.success, false);
});
