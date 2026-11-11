export class ProgressiveResponseInterruptedError extends Error {
  constructor() {
    super('Progressive addon response was interrupted before completion.');
    this.name = 'ProgressiveResponseInterruptedError';
  }
}

export class ProgressiveResponseProtocolError extends Error {
  constructor(message = 'Invalid progressive addon response.') {
    super(message);
    this.name = 'ProgressiveResponseProtocolError';
  }
}

const MAX_PROGRESSIVE_FRAME_BYTES = 16 * 1024 * 1024;

/** Ensure cache/lock coalescing still delivers one current result to a progressive caller. */
export async function reportFinalIfNoProgress<T>(
  result: T,
  progressWasReported: boolean,
  onProgress?: (result: T) => Promise<void> | void
): Promise<boolean> {
  if (onProgress && !progressWasReported) {
    await onProgress(result);
    return true;
  }
  return progressWasReported;
}

/** Read validated Deepbrid batches while requiring one authoritative terminal frame. */
export async function readProgressiveArray<T>(
  body: ReadableStream<Uint8Array>,
  validate: (streams: unknown[]) => T[],
  onBatch: (candidateIndex: number, streams: T[]) => Promise<void> | void,
  signal?: AbortSignal
): Promise<T[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const candidates = new Map<number, T[]>();
  let pending = '';
  let complete = false;
  let completedStreams: T[] | undefined;
  let protocolFailure: ProgressiveResponseProtocolError | undefined;
  let callbackFailure: unknown;

  const consumeLine = async (line: string): Promise<void> => {
    if (!line.trim()) return;
    if (complete) {
      protocolFailure = new ProgressiveResponseProtocolError(
        'Progressive addon sent data after completion.'
      );
      throw protocolFailure;
    }

    let event: any;
    try {
      event = JSON.parse(line.endsWith('\r') ? line.slice(0, -1) : line);
    } catch {
      protocolFailure = new ProgressiveResponseProtocolError(
        'Invalid progressive addon event.'
      );
      throw protocolFailure;
    }

    if (event?.event === 'batch') {
      if (
        !Number.isSafeInteger(event.candidateIndex) ||
        event.candidateIndex < 0 ||
        !Array.isArray(event.streams)
      ) {
        protocolFailure = new ProgressiveResponseProtocolError(
          'Invalid progressive addon batch.'
        );
        throw protocolFailure;
      }
      try {
        candidates.set(event.candidateIndex, validate(event.streams));
      } catch {
        protocolFailure = new ProgressiveResponseProtocolError(
          'Progressive addon batch failed validation.'
        );
        throw protocolFailure;
      }
      const cumulative = [...candidates.entries()]
        .sort(([left], [right]) => left - right)
        .flatMap(([, streams]) => streams);
      try {
        await onBatch(event.candidateIndex, cumulative);
      } catch (error) {
        callbackFailure = error;
        throw error;
      }
      return;
    }

    if (event?.event === 'complete' && Array.isArray(event.streams)) {
      try {
        completedStreams = validate(event.streams);
      } catch {
        protocolFailure = new ProgressiveResponseProtocolError(
          'Progressive addon completion failed validation.'
        );
        throw protocolFailure;
      }
      complete = true;
      return;
    }

    protocolFailure = new ProgressiveResponseProtocolError(
      'Unknown progressive addon event.'
    );
    throw protocolFailure;
  };

  try {
    while (true) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (protocolFailure) throw protocolFailure;
        if (callbackFailure !== undefined) throw callbackFailure;
        throw new ProgressiveResponseInterruptedError();
      }

      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        if (line.length > MAX_PROGRESSIVE_FRAME_BYTES) {
          throw new ProgressiveResponseProtocolError(
            'Progressive addon frame exceeds the safe size limit.'
          );
        }
        pending = pending.slice(newline + 1);
        await consumeLine(line);
        newline = pending.indexOf('\n');
      }
      if (pending.length > MAX_PROGRESSIVE_FRAME_BYTES) {
        throw new ProgressiveResponseProtocolError(
          'Progressive addon frame exceeds the safe size limit.'
        );
      }
      if (chunk.done) break;
    }

    if (pending.trim()) await consumeLine(pending);
    if (!complete || completedStreams === undefined) {
      throw new ProgressiveResponseInterruptedError();
    }
    return completedStreams;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
