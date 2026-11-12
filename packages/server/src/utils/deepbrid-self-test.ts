import {
  assessDeepbridArchiveVolumes,
  DeepbridApiError,
  parseNewshostingRelease,
  withDeepbridRateLimitRetry,
} from '@aiostreams/core';

export interface DeepbridSelfTestCheck {
  id: 'rate-limit-retry' | 'release-parser' | 'archive-gap-parser';
  status: 'passed' | 'failed';
  durationMs: number;
}

/** Offline checks exercise real retry/parser code without making provider calls. */
export async function runDeepbridLocalSelfTests(): Promise<
  DeepbridSelfTestCheck[]
> {
  const checks: DeepbridSelfTestCheck[] = [];
  const check = async (
    id: DeepbridSelfTestCheck['id'],
    run: () => Promise<void> | void
  ) => {
    const startedAt = Date.now();
    let status: DeepbridSelfTestCheck['status'] = 'passed';
    try {
      await run();
    } catch {
      status = 'failed';
    }
    checks.push({
      id,
      status,
      durationMs: Math.max(0, Date.now() - startedAt),
    });
  };

  await check('rate-limit-retry', async () => {
    let attempts = 0;
    const waits: number[] = [];
    const result = await withDeepbridRateLimitRetry(
      async () => {
        attempts++;
        if (attempts === 1) {
          throw new DeepbridApiError(
            'synthetic rate limit',
            429,
            'api_429',
            25
          );
        }
        return 'ok';
      },
      {
        timeoutMs: 1_000,
        attemptTimeoutMs: 500,
        maxRetries: 1,
        maxTransportRetries: 0,
        wait: async (milliseconds) => {
          waits.push(milliseconds);
        },
      }
    );
    // Retry waits are clamped to a 250 ms minimum by the production helper.
    if (result !== 'ok' || attempts !== 2 || waits[0] !== 250) {
      throw new Error('Rate-limit retry self-test failed');
    }
  });

  await check('release-parser', () => {
    const release = parseNewshostingRelease(
      'Example.Show.S03E23.1080p.WEB-DL.mkv'
    );
    if (
      release.season !== 3 ||
      release.episode !== 23 ||
      release.resolution !== '1080p'
    ) {
      throw new Error('Release parser self-test failed');
    }
  });

  await check('archive-gap-parser', () => {
    const assessment = assessDeepbridArchiveVolumes([
      { name: 'Example.part01.rar' },
      { name: 'Example.part03.rar' },
    ]);
    if (!assessment.incomplete || assessment.missingVolumeNumbers[0] !== 2) {
      throw new Error('Archive parser self-test failed');
    }
  });

  return checks;
}
