import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  observeProgressiveResponse,
  ProgressiveClientDisconnectedError,
  startProgressiveHeartbeat,
  type ProgressiveWritableResponse,
  waitForProgressiveDrain,
} from './progressiveStreamLifecycle.js';

class MockResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableFinished = false;
  writableNeedDrain = false;
  writeResult = true;
  writes: string[] = [];

  write(chunk: string): boolean {
    this.writes.push(chunk);
    this.emit('write', chunk);
    return this.writeResult;
  }
}

async function waitForWrites(res: MockResponse, count: number): Promise<void> {
  if (res.writes.length >= count) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      res.off('write', onWrite);
      reject(new Error(`Timed out waiting for ${count} progressive writes`));
    }, 500);
    const onWrite = () => {
      if (res.writes.length < count) return;
      clearTimeout(timeout);
      res.off('write', onWrite);
      resolve();
    };
    res.on('write', onWrite);
  });
}

const asProgressiveResponse = (res: MockResponse) =>
  res as unknown as ProgressiveWritableResponse;

test('marks a premature response close as a disconnect', () => {
  const res = new MockResponse();
  let disconnects = 0;
  let source: string | undefined;
  const lifecycle = observeProgressiveResponse(
    asProgressiveResponse(res),
    (event) => {
      disconnects++;
      source = event;
    }
  );

  res.emit('close');

  assert.equal(lifecycle.isDisconnected(), true);
  assert.equal(disconnects, 1);
  assert.equal(source, 'response-close');
  lifecycle.dispose();
});

test('reports a premature response error as a distinct disconnect source', () => {
  const res = new MockResponse();
  const sources: string[] = [];
  const lifecycle = observeProgressiveResponse(
    asProgressiveResponse(res),
    (source) => sources.push(source)
  );

  res.emit('error', new Error('transport failed'));

  assert.equal(lifecycle.isDisconnected(), true);
  assert.deepEqual(sources, ['response-error']);
  lifecycle.dispose();
});

test('does not treat a normally finished response close as a disconnect', () => {
  const res = new MockResponse();
  let disconnects = 0;
  const lifecycle = observeProgressiveResponse(
    asProgressiveResponse(res),
    () => disconnects++
  );
  res.writableFinished = true;

  res.emit('close');

  assert.equal(lifecycle.isDisconnected(), false);
  assert.equal(disconnects, 0);
  lifecycle.dispose();
});

test('settles progressive backpressure when drain arrives', async () => {
  const res = new MockResponse();
  const pending = waitForProgressiveDrain(asProgressiveResponse(res));
  res.emit('drain');

  await assert.doesNotReject(pending);
  assert.equal(res.listenerCount('drain'), 0);
  assert.equal(res.listenerCount('close'), 0);
  assert.equal(res.listenerCount('error'), 0);
});

test('rejects progressive backpressure on client close without drain', async () => {
  const res = new MockResponse();
  const pending = waitForProgressiveDrain(asProgressiveResponse(res));
  res.emit('close');

  await assert.rejects(pending, ProgressiveClientDisconnectedError);
  assert.equal(res.listenerCount('drain'), 0);
  assert.equal(res.listenerCount('close'), 0);
  assert.equal(res.listenerCount('error'), 0);
});

test('settles immediately if the response is already destroyed', async () => {
  const res = new MockResponse();
  res.destroyed = true;

  await assert.rejects(
    waitForProgressiveDrain(asProgressiveResponse(res)),
    ProgressiveClientDisconnectedError
  );
});

test('writes blank NDJSON heartbeats while active and stops cleanly', async () => {
  const res = new MockResponse();
  const stop = startProgressiveHeartbeat(res as never, 5);
  await waitForWrites(res, 2);
  stop();
  const writesAtStop = res.writes.length;
  await new Promise((resolve) => setTimeout(resolve, 12));

  assert.ok(writesAtStop >= 2);
  assert.equal(res.writes.length, writesAtStop);
  assert.ok(res.writes.every((write) => write === '\n'));
});

test('does not write heartbeats after the response ends', async () => {
  const res = new MockResponse();
  res.writableEnded = true;
  const stop = startProgressiveHeartbeat(res as never, 5);
  await new Promise((resolve) => setTimeout(resolve, 12));
  stop();

  assert.deepEqual(res.writes, []);
});

test('pauses heartbeats during backpressure and resumes on drain', async () => {
  const res = new MockResponse();
  res.writeResult = false;
  res.writableNeedDrain = true;
  const stop = startProgressiveHeartbeat(res as never, 5);
  await waitForWrites(res, 1);
  assert.equal(res.writes.length, 1);

  res.writeResult = true;
  res.writableNeedDrain = false;
  res.emit('drain');
  await waitForWrites(res, 2);
  stop();

  assert.ok(res.writes.length >= 2);
  assert.equal(res.listenerCount('drain'), 0);
});
