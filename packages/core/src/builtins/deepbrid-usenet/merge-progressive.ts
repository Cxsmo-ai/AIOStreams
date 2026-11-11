import type { Stream } from '../../db/schemas.js';

/**
 * Merge final Finder results with files already resolved and playback-probed
 * for progressive delivery. Capability URLs are encrypted with fresh nonces,
 * so URL equality is not stable across the progressive and final paths.
 */
export function mergeDeepbridFinderStreams(
  finalStreams: readonly Stream[],
  validatedProgressiveStreams: readonly Stream[]
): Stream[] {
  const identity = (stream: Stream): string => {
    const hints = (stream.behaviorHints ?? {}) as Record<string, unknown>;
    const stableFields = [
      hints.deepbridSourceIdentity ?? '',
      stream.title ?? '',
      hints.filename ?? '',
      hints.deepbridReleaseTitle ?? '',
      hints.deepbridReleaseSize ?? '',
      hints.deepbridNzbHash ?? '',
    ];
    return stableFields.some((value) => value !== '')
      ? JSON.stringify([
          ...stableFields,
          hints.deepbridPlaybackMode ?? 'direct',
        ])
      : `url:${stream.url ?? ''}`;
  };

  const merged = [...finalStreams];
  const seen = new Set(finalStreams.map(identity));
  for (const stream of validatedProgressiveStreams) {
    const key = identity(stream);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(stream);
  }
  return merged;
}

/**
 * Request-local collector for candidates validated as Finder content resolves.
 * It serves progressive delivery and preserves early successes for ordinary
 * responses when the shared request deadline is exhausted by later work. Keep
 * an instance on the addon/request, never in process-global state, so
 * capability URLs cannot cross profile/request boundaries.
 */
export class ValidatedProgressiveStreamCollector {
  private readonly streamsByCandidate = new Map<number, Stream[]>();

  recordValidated(candidateIndex: number, streams: readonly Stream[]): void {
    if (!Number.isInteger(candidateIndex) || candidateIndex < 0) return;
    if (streams.length === 0) return;
    this.streamsByCandidate.set(
      candidateIndex,
      mergeDeepbridFinderStreams(
        this.streamsByCandidate.get(candidateIndex) ?? [],
        streams
      )
    );
  }

  mergeFinal(
    finalStreams: readonly Stream[],
    signal?: AbortSignal
  ): Stream[] {
    if (signal?.aborted) return [...finalStreams];
    const progressiveStreams = [...this.streamsByCandidate.entries()]
      .sort(([left], [right]) => left - right)
      .flatMap(([, streams]) => streams);
    return mergeDeepbridFinderStreams(finalStreams, progressiveStreams);
  }

  clear(): void {
    this.streamsByCandidate.clear();
  }
}

/**
 * Schedule direct probes as Finder content resolves without holding up NZB
 * fan-out workers. The direct-playback branch drains the queue before reading
 * the collector, while the external resolver can consume Finder NZBs promptly.
 */
export class ValidatedFinderResolutionQueue<T> {
  private readonly pending = new Set<Promise<void>>();
  private readonly notifications = new Set<Promise<void>>();
  private notificationTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly collector: ValidatedProgressiveStreamCollector,
    private readonly createStreams: (
      resolved: T[],
      candidateIndex: number
    ) => Promise<Stream[]> | Stream[],
    private readonly notify?: (
      streams: Stream[],
      candidateIndex: number
    ) => Promise<void> | void,
    private readonly onError?: (
      error: unknown,
      candidateIndex: number
    ) => void,
    private readonly signal?: AbortSignal
  ) {}

  /** Enqueue work and return immediately to the content-resolution worker. */
  readonly schedule = (resolved: T[], candidateIndex: number): void => {
    if (this.closed || this.signal?.aborted) return;
    const task = Promise.resolve()
      .then(() => this.createStreams(resolved, candidateIndex))
      .then((streams) => {
        if (this.closed || this.signal?.aborted || streams.length === 0) return;
        this.collector.recordValidated(candidateIndex, streams);
        if (!this.notify) return;

        // Keep progressive batches ordered; callers can selectively wait for
        // this transport work before emitting their terminal frame.
        const notification = this.notificationTail
          .then(() => {
            if (this.closed || this.signal?.aborted) return;
            return this.notify?.(streams, candidateIndex);
          })
          .then(() => undefined)
          .catch((error: unknown) => {
            this.reportError(error, candidateIndex);
          });
        this.notificationTail = notification;
        this.notifications.add(notification);
        void notification.then(() => this.notifications.delete(notification));
      })
      .catch((error: unknown) => {
        this.reportError(error, candidateIndex);
      });

    this.pending.add(task);
    void task.then(() => this.pending.delete(task));
  };

  /** Wait for validation work, bounded by the shared request deadline. */
  async drain(deadline?: number, waitForNotifications = false): Promise<void> {
    while (
      this.pending.size > 0 ||
      (waitForNotifications && this.notifications.size > 0)
    ) {
      if (this.closed || this.signal?.aborted) return;
      const tasks = Promise.all([
        ...this.pending,
        ...(waitForNotifications ? this.notifications : []),
      ]);
      const remainingMs = deadline === undefined ? undefined : deadline - Date.now();
      if (remainingMs !== undefined && remainingMs <= 0) {
        this.close();
        if (waitForNotifications) {
          throw new DOMException(
            'Deepbrid progressive notifications exceeded the request deadline',
            'TimeoutError'
          );
        }
        return;
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => abortWaitResolve?.();
      let abortWaitResolve: (() => void) | undefined;
      const aborted = this.signal
        ? new Promise<'aborted'>((resolve) => {
            abortWaitResolve = () => resolve('aborted');
            if (this.signal?.aborted) abortWaitResolve();
            else this.signal?.addEventListener('abort', onAbort, { once: true });
          })
        : new Promise<never>(() => undefined);
      const timeout =
        remainingMs === undefined
          ? new Promise<never>(() => undefined)
          : new Promise<'deadline'>((resolve) => {
              timer = setTimeout(() => resolve('deadline'), remainingMs);
            });
      const outcome = await Promise.race([
        tasks.then(() => 'complete' as const),
        aborted,
        timeout,
      ]);
      if (timer) clearTimeout(timer);
      this.signal?.removeEventListener('abort', onAbort);
      if (outcome === 'aborted') return;
      if (outcome === 'deadline') {
        this.close();
        if (waitForNotifications) {
          throw new DOMException(
            'Deepbrid progressive notifications exceeded the request deadline',
            'TimeoutError'
          );
        }
        return;
      }
    }
  }

  /** Prevent late probes or notifications from mutating a finished request. */
  close(): void {
    this.closed = true;
  }

  private reportError(error: unknown, candidateIndex: number): void {
    try {
      this.onError?.(error, candidateIndex);
    } catch {
      // Diagnostics must not become an unhandled rejection either.
    }
  }
}
