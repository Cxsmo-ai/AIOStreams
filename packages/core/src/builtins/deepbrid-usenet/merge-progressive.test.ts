import assert from 'node:assert/strict';
import test from 'node:test';
import type { Stream } from '../../db/schemas.js';
import {
  mergeDeepbridFinderStreams,
  ValidatedProgressiveStreamCollector,
  ValidatedFinderResolutionQueue,
} from './merge-progressive.js';

function makeStream(
  url: string,
  filename: string,
  mode: 'direct' | 'remux' | 'hls' = 'direct',
  sourceIdentity?: string
): Stream {
  return {
    name: `[DB⚡] Deepbrid Usenet · ${mode}`,
    title: 'The.Mentalist.S03E23',
    description: `${filename}\nDeepbrid Usenet`,
    url,
    type: 'usenet',
    idMatched: true,
    behaviorHints: {
      filename,
      deepbridReleaseTitle: 'The.Mentalist.S03.1080p.WEB-DL',
      deepbridReleaseSize: 4_000_000_000,
      deepbridNzbHash: 'release-hash',
      deepbridSourceIdentity: sourceIdentity,
      deepbridPlaybackMode: mode,
    },
  };
}

test('retains validated progressive Finder streams missing from the final branch', () => {
  const finalStream = makeStream(
    'https://playback.example/final-capability',
    'The.Mentalist.S03E23.1080p.mkv'
  );
  const duplicateFromProgress = makeStream(
    'https://playback.example/progressive-capability',
    'The.Mentalist.S03E23.1080p.mkv'
  );
  const missingFromFinal = makeStream(
    'https://playback.example/validated-progressive-only',
    'The.Mentalist.S03E23.720p.mkv'
  );
  const alternateMode = makeStream(
    'https://playback.example/remux-capability',
    'The.Mentalist.S03E23.1080p.mkv',
    'remux'
  );

  const merged = mergeDeepbridFinderStreams(
    [finalStream],
    [duplicateFromProgress, missingFromFinal, alternateMode]
  );

  assert.deepEqual(
    merged.map((stream) => stream.url),
    [finalStream.url, missingFromFinal.url, alternateMode.url]
  );
});

test('uses stream URLs as a fallback identity when filename metadata is absent', () => {
  const makeUnannotated = (url: string): Stream => ({
    name: 'Finder stream',
    description: 'Finder stream',
    url,
    type: 'usenet',
  });
  const first = makeUnannotated('https://playback.example/one');
  const second = makeUnannotated('https://playback.example/two');

  assert.deepEqual(
    mergeDeepbridFinderStreams([first], [first, second]).map(
      (stream) => stream.url
    ),
    [first.url, second.url]
  );
});

test('does not collapse distinct validated source links with matching release metadata', () => {
  const first = makeStream(
    'https://playback.example/first-capability',
    'The.Mentalist.S03E23.1080p.mkv',
    'direct',
    'profile-keyed-source-identity-one'
  );
  const second = makeStream(
    'https://playback.example/second-capability',
    'The.Mentalist.S03E23.1080p.mkv',
    'direct',
    'profile-keyed-source-identity-two'
  );

  assert.deepEqual(
    mergeDeepbridFinderStreams([first], [second]).map((stream) => stream.url),
    [first.url, second.url]
  );
});

test('does not append retained streams after request cancellation', () => {
  const collector = new ValidatedProgressiveStreamCollector();
  const retained = makeStream(
    'https://playback.example/validated',
    'The.Mentalist.S03E23.1080p.mkv'
  );
  const final = makeStream(
    'https://playback.example/final',
    'The.Mentalist.S03E23.720p.mkv'
  );
  const controller = new AbortController();
  collector.recordValidated(0, [retained]);
  controller.abort();

  assert.deepEqual(
    collector.mergeFinal([final], controller.signal).map((stream) => stream.url),
    [final.url]
  );
});

test('keeps validated progressive candidates isolated per request collector', () => {
  const requestA = new ValidatedProgressiveStreamCollector();
  const requestB = new ValidatedProgressiveStreamCollector();
  const streamA = makeStream(
    'https://playback.example/request-a',
    'The.Mentalist.S03E23.1080p.mkv'
  );
  const streamB = makeStream(
    'https://playback.example/request-b',
    'The.Mentalist.S03E23.720p.mkv'
  );
  requestA.recordValidated(2, [streamA]);
  requestB.recordValidated(0, [streamB]);

  assert.deepEqual(
    requestA.mergeFinal([]).map((stream) => stream.url),
    [streamA.url]
  );
  assert.deepEqual(
    requestB.mergeFinal([]).map((stream) => stream.url),
    [streamB.url]
  );
  requestA.clear();
  assert.deepEqual(requestA.mergeFinal([]), []);
  assert.deepEqual(
    requestB.mergeFinal([]).map((stream) => stream.url),
    [streamB.url]
  );
});

test('probes early direct successes without blocking the external NZB branch', async () => {
  const collector = new ValidatedProgressiveStreamCollector();
  const validated = makeStream(
    'https://playback.example/early-success',
    'The.Mentalist.S03E23.1080p.mkv'
  );
  let releaseProbe!: () => void;
  const probeGate = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  const queue = new ValidatedFinderResolutionQueue(
    collector,
    async () => {
      await probeGate;
      return [validated];
    }
  );

  queue.schedule([{ filename: 'first' }], 3);
  let externalNzbBranchContinued = false;
  await Promise.resolve().then(() => {
    externalNzbBranchContinued = true;
  });
  assert.equal(externalNzbBranchContinued, true);

  let drained = false;
  const drain = queue.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  releaseProbe();
  await drain;

  assert.deepEqual(
    collector.mergeFinal([]).map((stream) => stream.url),
    [validated.url]
  );
});

test('keeps validated streams if progressive notification fails', async () => {
  const collector = new ValidatedProgressiveStreamCollector();
  const validated = makeStream(
    'https://playback.example/validated-before-notify',
    'The.Mentalist.S03E23.1080p.mkv'
  );
  const errors: number[] = [];
  const queue = new ValidatedFinderResolutionQueue(
    collector,
    async () => [validated],
    async () => {
      throw new Error('progress transport closed');
    },
    (_error, candidateIndex) => errors.push(candidateIndex)
  );

  queue.schedule([{}], 0);
  await queue.drain();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, [0]);
  assert.deepEqual(
    collector.mergeFinal([]).map((stream) => stream.url),
    [validated.url]
  );
});

test('final validation drain does not wait for progressive notification backpressure', async () => {
  const collector = new ValidatedProgressiveStreamCollector();
  const validated = makeStream(
    'https://playback.example/validated-before-slow-notification',
    'The.Mentalist.S03E23.1080p.mkv'
  );
  let notificationStarted!: () => void;
  let releaseNotification!: () => void;
  const started = new Promise<void>((resolve) => {
    notificationStarted = resolve;
  });
  const notification = new Promise<void>((resolve) => {
    releaseNotification = resolve;
  });
  const queue = new ValidatedFinderResolutionQueue(
    collector,
    async () => [validated],
    async () => {
      notificationStarted();
      await notification;
    }
  );

  queue.schedule([{}], 0);
  await queue.drain();
  await started;
  assert.deepEqual(
    collector.mergeFinal([]).map((stream) => stream.url),
    [validated.url]
  );
  releaseNotification();
});

test('progressive finalization waits for earlier batches before the terminal frame', async () => {
  const collector = new ValidatedProgressiveStreamCollector();
  const validated = makeStream(
    'https://playback.example/validated-before-terminal-fence',
    'The.Mentalist.S03E23.1080p.mkv'
  );
  let releaseNotification!: () => void;
  const notification = new Promise<void>((resolve) => {
    releaseNotification = resolve;
  });
  const queue = new ValidatedFinderResolutionQueue(
    collector,
    async () => [validated],
    async () => notification
  );

  queue.schedule([{}], 0);
  let finalized = false;
  const finalization = queue.drain(Date.now() + 1_000, true).then(() => {
    finalized = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(finalized, false);
  releaseNotification();
  await finalization;
  assert.equal(finalized, true);
});

test('progressive notification backpressure fails closed at the request deadline', async () => {
  const collector = new ValidatedProgressiveStreamCollector();
  const validated = makeStream(
    'https://playback.example/validated-before-notification-timeout',
    'The.Mentalist.S03E23.1080p.mkv'
  );
  const queue = new ValidatedFinderResolutionQueue(
    collector,
    async () => [validated],
    async () => new Promise<void>(() => undefined)
  );

  queue.schedule([{}], 0);
  await assert.rejects(
    queue.drain(Date.now() + 10, true),
    (error: unknown) => error instanceof Error && error.name === 'TimeoutError'
  );
  assert.deepEqual(
    collector.mergeFinal([]).map((stream) => stream.url),
    [validated.url]
  );
});

test('already-expired progressive deadlines reject while JSON validation remains nonblocking', async () => {
  const collector = new ValidatedProgressiveStreamCollector();
  const validated = makeStream(
    'https://playback.example/expired-progressive-deadline',
    'The.Mentalist.S03E23.1080p.mkv'
  );
  let notificationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    notificationStarted = resolve;
  });
  const queue = new ValidatedFinderResolutionQueue(
    collector,
    async () => [validated],
    async () => {
      notificationStarted();
      return new Promise<void>(() => undefined);
    }
  );

  queue.schedule([{}], 0);
  await started;
  await assert.rejects(
    queue.drain(Date.now() - 1, true),
    (error: unknown) => error instanceof Error && error.name === 'TimeoutError'
  );

  const jsonQueue = new ValidatedFinderResolutionQueue(
    new ValidatedProgressiveStreamCollector(),
    async () => [validated]
  );
  jsonQueue.schedule([{}], 0);
  await assert.doesNotReject(() => jsonQueue.drain(Date.now() - 1, false));
});

test('deadline closes pending probes and rejects late validated results', async () => {
  const collector = new ValidatedProgressiveStreamCollector();
  const validated = makeStream(
    'https://playback.example/late-after-deadline',
    'The.Mentalist.S03E23.1080p.mkv'
  );
  let releaseProbe!: () => void;
  const probe = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  let notifications = 0;
  const queue = new ValidatedFinderResolutionQueue(
    collector,
    async () => {
      await probe;
      return [validated];
    },
    () => {
      notifications += 1;
    }
  );

  queue.schedule([{}], 0);
  await queue.drain(Date.now() + 10);
  releaseProbe();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(collector.mergeFinal([]), []);
  assert.equal(notifications, 0);
});

test('canceled requests cannot publish results from probes that finish late', async () => {
  const collector = new ValidatedProgressiveStreamCollector();
  const validated = makeStream(
    'https://playback.example/late-after-cancel',
    'The.Mentalist.S03E23.1080p.mkv'
  );
  const controller = new AbortController();
  let releaseProbe!: () => void;
  const probe = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  let notifications = 0;
  const queue = new ValidatedFinderResolutionQueue(
    collector,
    async () => {
      await probe;
      return [validated];
    },
    () => {
      notifications += 1;
    },
    undefined,
    controller.signal
  );

  queue.schedule([{}], 0);
  const drain = queue.drain();
  controller.abort();
  await drain;
  releaseProbe();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(collector.mergeFinal([]), []);
  assert.equal(notifications, 0);
});
