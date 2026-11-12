import test from 'node:test';
import assert from 'node:assert/strict';
import { collectProgressiveResult } from './progressive-ndjson.mjs';

const response = (text, status = 200) => new Response(text, { status });

test('progressive collector reads chunked hello/snapshots/complete and returns summary timings', async () => {
  const startedAt = performance.now() - 5;
  const result = await collectProgressiveResult(
    response(
      [
        JSON.stringify({ event: 'hello', version: 1 }),
        JSON.stringify({ event: 'snapshot', streams: [{ id: 'one' }] }),
        JSON.stringify({
          event: 'complete',
          streams: [{ id: 'one' }, { id: 'two' }],
        }),
      ].join('\n')
    ),
    {
      startedAt,
      classifySnapshot: (event) => ({
        deepbrid: true,
        finder: true,
        deepbridCount: event.streams.length,
        finderCount: 1,
      }),
    }
  );
  assert.equal(result.payload.event, 'complete');
  assert.equal(result.payload.streams.length, 2);
  assert.equal(result.snapshotCount, 1);
  assert.equal(result.maximumDeepbridSnapshotCount, 1);
  assert.equal(result.maximumFinderSnapshotCount, 1);
  assert.ok(result.firstDeepbridSnapshotElapsedMs >= 0);
  assert.equal(
    result.firstFinderSnapshotElapsedMs,
    result.lastFinderSnapshotElapsedMs
  );
});

test('progressive collector rejects incomplete and invalid terminal sequences safely', async () => {
  await assert.rejects(
    collectProgressiveResult(response('{"event":"snapshot","streams":[]}\n')),
    /progressive-incomplete/
  );
  await assert.rejects(
    collectProgressiveResult(
      response(
        '{"event":"complete","streams":[]}\n{"event":"snapshot","streams":[]}'
      )
    ),
    /progressive-event-after-terminal/
  );
  await assert.rejects(
    collectProgressiveResult(response('{"event":"complete","streams":null}')),
    /progressive-invalid-complete/
  );
  await assert.rejects(
    collectProgressiveResult(response('{not-json}')),
    /progressive-invalid-json/
  );
});

test('progressive collector rejects wrong hello versions and HTTP failures without body leakage', async () => {
  await assert.rejects(
    collectProgressiveResult(response('{"event":"hello","version":2}')),
    /progressive-invalid-hello/
  );
  await assert.rejects(
    collectProgressiveResult(response('secret body', 503)),
    /progressive-http-503/
  );
  const interrupted = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('{"event":"snapshot","streams":[]}\n')
        );
        controller.error(new Error('token=must-not-escape'));
      },
    })
  );
  await assert.rejects(
    collectProgressiveResult(interrupted),
    (error) =>
      error.message === 'progressive-read-failed' &&
      !error.message.includes('must-not-escape')
  );
});

test('progressive collector enforces event and response size ceilings', async () => {
  const oversized = JSON.stringify({
    event: 'snapshot',
    streams: [],
    padding: 'x'.repeat(1024 * 1024 + 20),
  });
  await assert.rejects(
    collectProgressiveResult(response(oversized)),
    /progressive-line-limit/
  );
  const oversizedFinal =
    JSON.stringify({ event: 'hello', version: 1 }) +
    '\n' +
    'x'.repeat(1024 * 1024 + 1);
  await assert.rejects(
    collectProgressiveResult(response(oversizedFinal)),
    /progressive-line-limit/
  );
});
