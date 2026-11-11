import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { initialiseConfig } from '../config/index.js';
import { closeDb, initDb } from '../db/db.js';
import { DeepbridUsenetPreset } from './deepbridUsenet.js';

before(async () => {
  await initDb('sqlite::memory:');
  await initialiseConfig();
});

after(async () => {
  await closeDb();
});

const deepbridUserData = {
  services: [
    {
      id: 'deepbrid',
      enabled: true,
      credentials: { apiKey: 'd'.repeat(32) },
    },
  ],
} as any;

test('subtitle converter toggle is exposed and defaults off', () => {
  const option = DeepbridUsenetPreset.METADATA.OPTIONS.find(
    (item) => item.id === 'convertSubtitlesToWebVtt'
  );
  assert.ok(option);
  assert.equal(option.type, 'boolean');
  assert.equal(option.default, false);
});

test('subtitle converter toggle survives Deepbrid addon generation', async () => {
  const [addon] = await DeepbridUsenetPreset.generateAddons(
    deepbridUserData,
    {
      name: 'Deepbrid Usenet',
      convertSubtitlesToWebVtt: true,
    }
  );

  assert.ok(addon);
  assert.equal(addon.identifier, 'deepbrid-usenet');
  assert.equal(addon.preset.options.convertSubtitlesToWebVtt, true);
});

test('Deepbrid Finder limit options default to zero and accept unlimited', async () => {
  for (const [id, maximum] of [
    ['maxResults', 50],
    ['maxContentResolves', 30],
  ] as const) {
    const option = DeepbridUsenetPreset.METADATA.OPTIONS.find(
      (item) => item.id === id
    );
    assert.ok(option);
    assert.equal(option.default, 0);
    assert.equal(option.constraints?.min, 0);
    assert.equal(option.constraints?.max, maximum);
  }

  const [addon] = await DeepbridUsenetPreset.generateAddons(deepbridUserData, {
    name: 'Deepbrid Usenet',
    maxResults: 0,
    maxContentResolves: 0,
  });
  assert.ok(addon);
  assert.equal(addon.preset.options.maxResults, 0);
  assert.equal(addon.preset.options.maxContentResolves, 0);
});

test('progressive Finder resolution exposes a bounded concurrency control', () => {
  const option = DeepbridUsenetPreset.METADATA.OPTIONS.find(
    (item) => item.id === 'progressiveResolveConcurrency'
  );
  assert.ok(option);
  assert.equal(option.default, 10);
  assert.equal(option.constraints?.min, 1);
  assert.equal(option.constraints?.max, 10);
});
