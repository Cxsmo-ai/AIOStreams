import type { ServerResponse } from 'node:http';

export type ProgressiveWritableResponse = Pick<
  ServerResponse,
  'destroyed' | 'writableEnded' | 'writableFinished' | 'once' | 'off'
>;

export type ProgressiveDisconnectSource = 'response-close' | 'response-error';

export type ProgressiveHeartbeatResponse = Pick<
  ServerResponse,
  | 'destroyed'
  | 'writableEnded'
  | 'writableNeedDrain'
  | 'write'
  | 'once'
  | 'off'
>;

export const PROGRESSIVE_HEARTBEAT_INTERVAL_MS = 15_000;

/** Keep idle NDJSON streams alive with blank lines, which NDJSON consumers
 * ignore. This matters while a provider is resolving candidates but has no new
 * playable streams to emit. */
export function startProgressiveHeartbeat(
  response: ProgressiveHeartbeatResponse,
  intervalMs = PROGRESSIVE_HEARTBEAT_INTERVAL_MS
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let waitingForDrain = false;

  const schedule = (): void => {
    if (stopped || response.destroyed || response.writableEnded) return;
    timer = setTimeout(tick, intervalMs);
  };

  const onDrain = (): void => {
    waitingForDrain = false;
    response.off('drain', onDrain);
    schedule();
  };

  const stop = (): void => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (waitingForDrain) response.off('drain', onDrain);
    waitingForDrain = false;
  };

  const tick = (): void => {
    timer = undefined;
    if (stopped || response.destroyed || response.writableEnded) return;
    let writable: boolean;
    try {
      writable = response.write('\n');
    } catch {
      stop();
      return;
    }
    if (writable) {
      schedule();
      return;
    }

    // A full response buffer must not accumulate periodic heartbeat writes.
    waitingForDrain = true;
    response.once('drain', onDrain);
    if (!response.writableNeedDrain) onDrain();
  };

  schedule();
  return stop;
}

export class ProgressiveClientDisconnectedError extends Error {
  constructor() {
    super('Progressive client disconnected');
    this.name = 'ProgressiveClientDisconnectedError';
  }
}

/** Observe the response lifecycle; IncomingMessage.close only describes the
 * request body and is not a reliable signal that a streaming response ended. */
export function observeProgressiveResponse(
  response: ProgressiveWritableResponse,
  onDisconnect: (source: ProgressiveDisconnectSource) => void
): { isDisconnected: () => boolean; dispose: () => void } {
  let disconnected = false;
  const markDisconnected = (source: ProgressiveDisconnectSource) => {
    if (disconnected || response.writableFinished) return;
    disconnected = true;
    onDisconnect(source);
  };

  const onClose = () => markDisconnected('response-close');
  const onError = () => markDisconnected('response-error');
  response.once('close', onClose);
  response.once('error', onError);
  if (response.destroyed && !response.writableFinished) onClose();

  return {
    isDisconnected: () => disconnected,
    dispose: () => {
      response.off('close', onClose);
      response.off('error', onError);
    },
  };
}

/** Wait for backpressure to clear, while also settling on disconnect/error. */
export function waitForProgressiveDrain(
  response: ProgressiveWritableResponse
): Promise<void> {
  if (response.destroyed || response.writableEnded) {
    return Promise.reject(new ProgressiveClientDisconnectedError());
  }

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', onDrain);
      response.off('close', onClose);
      response.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      if (response.writableFinished) resolve();
      else reject(new ProgressiveClientDisconnectedError());
    };
    const onError = (error?: Error) => {
      cleanup();
      reject(error ?? new Error('Progressive response write failed'));
    };

    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('error', onError);

    if (response.destroyed || response.writableEnded) onClose();
  });
}
