import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProgressiveResponseInterruptedError,
  ProgressiveResponseProtocolError,
  readProgressiveArray,
  reportFinalIfNoProgress,
} from './progressiveResponse.js';

function bodyFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const validateNumbers = (values: unknown[]): number[] => {
  if (!values.every((value) => typeof value === 'number')) {
    throw new Error('invalid test fixture');
  }
  return values as number[];
};

test('parses split CRLF NDJSON and emits candidate-index ordered cumulative batches', async () => {
  const batches: number[][] = [];
  const result = await readProgressiveArray(
    bodyFromChunks([
      '{"event":"batch","candidateIndex":4,"streams":[4]}\r\n{"event":',
      '"batch","candidateIndex":1,"streams":[1]}\n{"event":"complete","streams":[1,4]}\n',
    ]),
    validateNumbers,
    (_candidateIndex, streams) => batches.push(streams)
  );

  assert.deepEqual(batches, [[4], [1, 4]]);
  assert.deepEqual(result, [1, 4]);
});

test('ignores blank-line heartbeats in an otherwise valid NDJSON stream', async () => {
  const result = await readProgressiveArray(
    bodyFromChunks([
      '\n {"event":"batch","candidateIndex":0,"streams":[7]}\r\n\n',
      '{"event":"complete","streams":[7]}\n',
    ]),
    validateNumbers,
    () => undefined
  );

  assert.deepEqual(result, [7]);
});

test('classifies a clean EOF without a terminal frame as an interrupted response', async () => {
  const batches: number[][] = [];
  await assert.rejects(
    readProgressiveArray(
      bodyFromChunks(['{"event":"batch","candidateIndex":0,"streams":[7]}\n']),
      validateNumbers,
      (_candidateIndex, streams) => batches.push(streams)
    ),
    ProgressiveResponseInterruptedError
  );
  assert.deepEqual(batches, [[7]]);
});

test('rejects malformed or schema-invalid batch frames as protocol failures', async () => {
  for (const frame of [
    '{not-json}\n',
    '{"event":"batch","candidateIndex":-1,"streams":[1]}\n',
    '{"event":"batch","candidateIndex":0,"streams":["bad"]}\n',
  ]) {
    await assert.rejects(
      readProgressiveArray(
        bodyFromChunks([frame]),
        validateNumbers,
        () => undefined
      ),
      ProgressiveResponseProtocolError
    );
  }
});

test('rejects any NDJSON frame after the terminal completion event', async () => {
  await assert.rejects(
    readProgressiveArray(
      bodyFromChunks([
        '{"event":"complete","streams":[1]}\n{"event":"batch","candidateIndex":0,"streams":[2]}\n',
      ]),
      validateNumbers,
      () => undefined
    ),
    ProgressiveResponseProtocolError
  );
});

test('does not misclassify a progress callback failure as a transport interruption', async () => {
  await assert.rejects(
    readProgressiveArray(
      bodyFromChunks(['{"event":"batch","candidateIndex":0,"streams":[1]}\n']),
      validateNumbers,
      async () => {
        throw new Error('callback failed');
      }
    ),
    /callback failed/
  );
});

test('reports a final cache/lock result when no progressive batches were emitted', async () => {
  const delivered: number[][] = [];
  const result = [1, 2, 3];
  const reported = await reportFinalIfNoProgress(result, false, (streams) =>
    delivered.push(streams)
  );

  assert.equal(reported, true);
  assert.deepEqual(delivered, [result]);
});

test('does not duplicate a progressive result already reported in batches', async () => {
  let deliveries = 0;
  const reported = await reportFinalIfNoProgress([1], true, () => {
    deliveries += 1;
  });

  assert.equal(reported, true);
  assert.equal(deliveries, 0);
});
