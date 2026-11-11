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

test('zero result limits are accepted as unlimited', () => {
  const parsed = UserDataSchema.safeParse({
    ...minimalUserData,
    resultLimits: {
      global: 0,
      service: 0,
      addon: 0,
      resolution: 0,
      quality: 0,
      streamType: 0,
      indexer: 0,
      releaseGroup: 0,
    },
  });

  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  const negative = UserDataSchema.safeParse({
    ...minimalUserData,
    resultLimits: { global: -1 },
  });
  assert.equal(negative.success, false);
});
