import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ParsedStream, UserData } from '../db/schemas.js';
import StreamLimiter from './limiter.js';

const makeStream = (id: string): ParsedStream =>
  ({
    id,
    type: 'usenet',
    addon: { preset: { id: 'addon-a' } },
    service: { id: 'deepbrid' },
    parsedFile: { resolution: '1080p', quality: 'WEB-DL', releaseGroup: 'grp' },
  }) as ParsedStream;

const runLimit = (
  streams: ParsedStream[],
  resultLimits: NonNullable<UserData['resultLimits']>
) => new StreamLimiter({ resultLimits } as UserData).limit(streams);

test('zero result limits leave all results unbounded in independent mode', async () => {
  const streams = [makeStream('a'), makeStream('b'), makeStream('c')];
  const result = await runLimit(streams, {
    global: 0,
    service: 0,
    addon: 0,
    resolution: 0,
    quality: 0,
    streamType: 0,
    indexer: 0,
    releaseGroup: 0,
    mode: 'independent',
  });

  assert.deepEqual(result.map((stream) => stream.id), ['a', 'b', 'c']);
});

test('zero result limits leave all results unbounded in conjunctive mode', async () => {
  const streams = [makeStream('a'), makeStream('b'), makeStream('c')];
  const result = await runLimit(streams, {
    global: 0,
    service: 0,
    addon: 0,
    resolution: 0,
    quality: 0,
    streamType: 0,
    indexer: 0,
    releaseGroup: 0,
    mode: 'conjunctive',
  });

  assert.deepEqual(result.map((stream) => stream.id), ['a', 'b', 'c']);
});

test('all-zero limits preserve more than 250 results in both modes', async () => {
  const streams = Array.from({ length: 501 }, (_, index) =>
    makeStream(`stream-${index}`)
  );

  for (const mode of ['independent', 'conjunctive'] as const) {
    const result = await runLimit(streams, {
      global: 0,
      service: 0,
      addon: 0,
      resolution: 0,
      quality: 0,
      streamType: 0,
      indexer: 0,
      releaseGroup: 0,
      mode,
    });

    assert.equal(result.length, 501);
    assert.deepEqual(
      result.map((stream) => stream.id),
      streams.map((stream) => stream.id)
    );
  }
});

test('zero disables only its own cap while positive caps still apply', async () => {
  const streams = [makeStream('a'), makeStream('b'), makeStream('c')];
  const result = await runLimit(streams, {
    global: 0,
    service: 0,
    addon: 0,
    resolution: 1,
    quality: 0,
    streamType: 0,
    indexer: 0,
    releaseGroup: 0,
    mode: 'conjunctive',
  });

  assert.deepEqual(result.map((stream) => stream.id), ['a']);
});
