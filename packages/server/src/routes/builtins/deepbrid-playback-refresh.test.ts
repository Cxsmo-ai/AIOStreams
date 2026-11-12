import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  clearDeepbridPlaybackRefreshCacheForTests,
  refreshExpiredDeepbridFinderLink,
} from './deepbrid-playback-refresh.js';

const basePayload = {
  apiKey: 'a'.repeat(32),
  filename: 'Example.S03E02.mkv',
  size: 1_234_567,
  finderToken: 'finder-result-token',
  finderArchives: true,
} as const;
const expiredUrl = 'https://usenet-1.myfast.link/files/old?sig=expired';
const freshUrl = 'https://usenet-2.myfast.link/files/new?sig=fresh';

afterEach(() => clearDeepbridPlaybackRefreshCacheForTests());

describe('refreshExpiredDeepbridFinderLink', () => {
  it('refreshes an expired direct link on demand and caches it for range requests', async () => {
    let calls = 0;
    let requestedArchives: boolean | undefined;
    const getContent = async (token: string, archives: boolean) => {
      calls++;
      assert.equal(token, basePayload.finderToken);
      requestedArchives = archives;
      return {
        files: [
          {
            name: 'different-file.mkv',
            link: freshUrl,
            size: basePayload.size,
          },
          {
            name: 'example.s03e02.mkv',
            link: freshUrl,
            size: basePayload.size,
          },
        ],
      };
    };

    const first = await refreshExpiredDeepbridFinderLink(
      410,
      basePayload,
      expiredUrl,
      getContent,
      1_000
    );
    const second = await refreshExpiredDeepbridFinderLink(
      410,
      basePayload,
      expiredUrl,
      getContent,
      2_000
    );

    assert.equal(first, freshUrl);
    assert.equal(second, freshUrl);
    assert.equal(requestedArchives, true);
    assert.equal(calls, 1);
  });

  it('does not refresh healthy, authentication, missing, transformed, or non-storage requests', async () => {
    let calls = 0;
    const getContent = async () => {
      calls++;
      return { files: [{ name: basePayload.filename, link: freshUrl }] };
    };
    const blocked = await Promise.all([
      refreshExpiredDeepbridFinderLink(
        200,
        basePayload,
        expiredUrl,
        getContent
      ),
      refreshExpiredDeepbridFinderLink(
        401,
        basePayload,
        expiredUrl,
        getContent
      ),
      refreshExpiredDeepbridFinderLink(
        403,
        basePayload,
        expiredUrl,
        getContent
      ),
      refreshExpiredDeepbridFinderLink(
        404,
        basePayload,
        expiredUrl,
        getContent
      ),
      refreshExpiredDeepbridFinderLink(
        403,
        { ...basePayload, mode: 'hls' },
        expiredUrl,
        getContent
      ),
      refreshExpiredDeepbridFinderLink(
        403,
        basePayload,
        'https://media.example/files/old.mkv',
        getContent
      ),
      refreshExpiredDeepbridFinderLink(
        403,
        { ...basePayload, finderToken: undefined },
        expiredUrl,
        getContent
      ),
    ]);

    assert.deepEqual(blocked, Array(blocked.length).fill(undefined));
    assert.equal(calls, 0);
  });

  it('requires an exact filename, compatible size, and trusted storage URL', async () => {
    const noMatch = await refreshExpiredDeepbridFinderLink(
      403,
      basePayload,
      expiredUrl,
      async () => ({
        files: [
          {
            name: 'Example.S03E03.mkv',
            link: freshUrl,
            size: basePayload.size,
          },
        ],
      })
    );
    const wrongSize = await refreshExpiredDeepbridFinderLink(
      403,
      { ...basePayload, finderToken: 'different-token' },
      expiredUrl,
      async () => ({
        files: [
          {
            name: basePayload.filename,
            link: freshUrl,
            size: basePayload.size + 1,
          },
        ],
      })
    );
    const untrusted = await refreshExpiredDeepbridFinderLink(
      403,
      { ...basePayload, finderToken: 'third-token' },
      expiredUrl,
      async () => ({
        files: [
          {
            name: basePayload.filename,
            link: 'https://evil.example/file.mkv',
            size: basePayload.size,
          },
        ],
      })
    );
    const unchanged = await refreshExpiredDeepbridFinderLink(
      410,
      { ...basePayload, finderToken: 'fourth-token' },
      expiredUrl,
      async () => ({
        files: [
          {
            name: basePayload.filename,
            link: expiredUrl,
            size: basePayload.size,
          },
        ],
      })
    );

    assert.equal(noMatch, undefined);
    assert.equal(wrongSize, undefined);
    assert.equal(untrusted, undefined);
    assert.equal(unchanged, undefined);
  });

  it('coalesces simultaneous refreshes for the same account and file', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const getContent = async () => {
      calls++;
      await gate;
      return {
        files: [
          {
            name: basePayload.filename,
            link: freshUrl,
            size: basePayload.size,
          },
        ],
      };
    };

    const first = refreshExpiredDeepbridFinderLink(
      410,
      basePayload,
      expiredUrl,
      getContent
    );
    const second = refreshExpiredDeepbridFinderLink(
      410,
      basePayload,
      expiredUrl,
      getContent
    );
    await Promise.resolve();
    release();

    assert.deepEqual(await Promise.all([first, second]), [freshUrl, freshUrl]);
    assert.equal(calls, 1);
  });

  it('refreshes again after the bounded cache entry expires', async () => {
    let calls = 0;
    const getContent = async () => {
      calls++;
      return {
        files: [
          {
            name: basePayload.filename,
            link: `https://usenet-${calls}.myfast.link/file`,
            size: basePayload.size,
          },
        ],
      };
    };

    const first = await refreshExpiredDeepbridFinderLink(
      410,
      basePayload,
      expiredUrl,
      getContent,
      1_000
    );
    const next = await refreshExpiredDeepbridFinderLink(
      410,
      basePayload,
      expiredUrl,
      getContent,
      121_000
    );

    assert.equal(first, 'https://usenet-1.myfast.link/file');
    assert.equal(next, 'https://usenet-2.myfast.link/file');
    assert.equal(calls, 2);
  });
});
