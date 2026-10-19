import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTorboxSearchConfigId,
  decodeTorboxSearchConfig,
} from './config.js';

test('TorBox Search config URL identifier never contains credentials', () => {
  const apiKey = '4this-is-a-test-torbox-api-key-ending-in-f';
  const config = { torBoxApiKey: apiKey, sources: ['torrent'] };

  const id = createTorboxSearchConfigId(config);
  const serialized = JSON.stringify(config);

  assert.equal(id.includes(apiKey), false);
  assert.deepEqual(decodeTorboxSearchConfig(id, serialized), config);
});

test('TorBox Search config reference rejects a mismatched payload', () => {
  const id = createTorboxSearchConfigId({ torBoxApiKey: 'expected' });

  assert.throws(() =>
    decodeTorboxSearchConfig(id, JSON.stringify({ torBoxApiKey: 'other' }))
  );
});

test('TorBox Search config reference rejects old reversible Base64 URLs', () => {
  const legacy = Buffer.from(
    JSON.stringify({ torBoxApiKey: '4test-key-ending-f' })
  ).toString('base64url');

  assert.throws(() => decodeTorboxSearchConfig(legacy, undefined));
});
