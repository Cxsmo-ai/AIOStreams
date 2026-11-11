import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDeepbridPlaybackVariants } from './playbackVariants.js';

const basePayload = {
  apiKey: 'test-only',
  url: 'https://media.example.invalid/media/example.mkv?sig=opaque',
  filename: 'example.mkv',
  size: 1234,
};

test('selected player delivery generates exactly its matching playable variant', () => {
  for (const [selected, expectedLabel] of [
    ['direct', 'NATIVE'],
    ['remux', 'REMUX'],
    ['hls', 'HLS'],
  ] as const) {
    const payloads: Array<typeof basePayload & { mode: string }> = [];
    const variants = buildDeepbridPlaybackVariants(
      basePayload,
      selected,
      (payload) => {
        payloads.push(payload);
        return `playable:${payload.mode}`;
      }
    );
    assert.equal(variants.length, 1);
    assert.equal(variants[0]!.mode, selected);
    assert.equal(variants[0]!.label, expectedLabel);
    assert.equal(variants[0]!.url, `playable:${selected}`);
    assert.equal(payloads[0]!.mode, selected);
    assert.equal(payloads[0]!.url, basePayload.url);
    assert.equal(payloads[0]!.filename, basePayload.filename);
  }
});

test('Show all three emits distinct native, remux, and HLS capabilities in order', () => {
  const payloads: Array<typeof basePayload & { mode: string }> = [];
  const variants = buildDeepbridPlaybackVariants(
    basePayload,
    'all',
    (payload) => {
      payloads.push(payload);
      return `playable:${payload.mode}`;
    }
  );
  assert.deepEqual(
    variants.map(({ mode, label }) => [mode, label]),
    [
      ['direct', 'NATIVE'],
      ['remux', 'REMUX'],
      ['hls', 'HLS'],
    ]
  );
  assert.deepEqual(
    variants.map(({ url }) => url),
    ['playable:direct', 'playable:remux', 'playable:hls']
  );
  assert.deepEqual(
    payloads.map(({ mode }) => mode),
    ['direct', 'remux', 'hls']
  );
});
