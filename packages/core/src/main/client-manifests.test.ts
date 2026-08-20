import assert from 'node:assert/strict';
import test from 'node:test';
import type { UserData } from '../db/index.js';
import {
  applyClientManifestProfile,
  ClientManifestProfileError,
  isP2pCapablePreset,
} from './client-manifests.js';

function config(): UserData {
  return {
    presets: [
      {
        type: 'torrentio',
        instanceId: 'torrentio-one',
        enabled: true,
        options: { services: ['realdebrid'] },
      },
      {
        type: 'deepbrid-usenet',
        instanceId: 'deepbrid-one',
        enabled: true,
        options: { services: ['deepbrid'] },
      },
      {
        type: 'comet',
        instanceId: 'comet-disabled',
        enabled: false,
        options: { services: ['torbox'] },
      },
    ],
    services: [
      { id: 'realdebrid', enabled: true, credentials: { token: 'test' } },
    ],
    formatter: {} as UserData['formatter'],
    sortCriteria: { global: [] },
    requiredStreamTypes: ['debrid'],
    includedStreamTypes: ['debrid'],
    excludedStreamTypes: ['p2p'],
    serviceWrap: { enabled: true },
    failover: { enabled: true },
    dynamicAddonFetching: { enabled: true, condition: 'totalTimeTaken > 1' },
    groups: { enabled: true, groupings: [], behaviour: 'parallel' },
    externalDownloads: true,
    clientManifests: {
      normal: { excludedPresetIds: ['deepbrid-one'] },
      wakoP2p: {
        enabled: true,
        presetIds: ['torrentio-one', 'deepbrid-one', 'comet-disabled'],
        waitForAll: true,
      },
    },
  };
}

const p2pPresetTypes = new Set(['torrentio', 'comet']);

test('normal client manifest excludes only configured addon instances', () => {
  const source = config();
  const result = applyClientManifestProfile(source);

  assert.deepEqual(
    result.presets.map((preset) => preset.instanceId),
    ['torrentio-one', 'comet-disabled']
  );
  assert.equal(source.presets.length, 3);
  assert.equal(source.services?.length, 1);
});

test('Wako profile is an immutable P2P-only wait-for-all configuration', () => {
  const source = config();
  const result = applyClientManifestProfile(source, 'wako-p2p', p2pPresetTypes);

  assert.deepEqual(
    result.presets.map((preset) => preset.instanceId),
    ['torrentio-one']
  );
  assert.deepEqual(result.presets[0]?.options.services, []);
  assert.deepEqual(result.services, []);
  assert.deepEqual(result.requiredStreamTypes, ['p2p']);
  assert.deepEqual(result.includedStreamTypes, []);
  assert.deepEqual(result.excludedStreamTypes, []);
  assert.equal(result.serviceWrap?.enabled, false);
  assert.equal(result.failover?.enabled, false);
  assert.equal(result.dynamicAddonFetching?.enabled, false);
  assert.equal(result.groups?.enabled, false);
  assert.equal(result.externalDownloads, false);
  assert.equal(result.activeClientManifest, 'wako-p2p');

  assert.deepEqual(source.presets[0]?.options.services, ['realdebrid']);
  assert.equal(source.serviceWrap?.enabled, true);
});

test('Wako profile rejects disabled or empty selections', () => {
  const disabled = config();
  disabled.clientManifests!.wakoP2p!.enabled = false;
  assert.throws(
    () => applyClientManifestProfile(disabled, 'wako-p2p', p2pPresetTypes),
    ClientManifestProfileError
  );

  const noP2p = config();
  noP2p.clientManifests!.wakoP2p!.presetIds = ['deepbrid-one'];
  assert.throws(
    () => applyClientManifestProfile(noP2p, 'wako-p2p', p2pPresetTypes),
    /no enabled P2P-capable addons/i
  );
});

test('preset capability lookup only accepts declared P2P support', () => {
  assert.equal(isP2pCapablePreset('torrentio', p2pPresetTypes), true);
  assert.equal(isP2pCapablePreset('deepbrid-usenet', p2pPresetTypes), false);
  assert.equal(isP2pCapablePreset('does-not-exist', p2pPresetTypes), false);
});
