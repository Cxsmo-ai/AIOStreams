import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DeepbridService,
  selectDeepbridUploadFile,
  type DeepbridOfficialApi,
} from './deepbrid.js';
import {
  DeepbridApiError,
  parseDeepbridAddResponse,
} from '../builtins/deepbrid-usenet/client.js';
import { DebridError } from './base.js';

test('parses the direct files returned by Deepbrid NZB add', () => {
  const result = parseDeepbridAddResponse({
    data: {
      upload_id: 42,
      title: 'Tower Prep S01',
      files: [
        {
          filename: 'Tower.Prep.S01E09.720p.mkv',
          download_url: 'https://usenet.myfast.link/e9',
          filesize: 2_000,
        },
      ],
    },
  });
  assert.equal(result.id, '42');
  assert.equal(result.title, 'Tower Prep S01');
  assert.deepEqual(result.files, [
    {
      name: 'Tower.Prep.S01E09.720p.mkv',
      link: 'https://usenet.myfast.link/e9',
      size: 2_000,
      sizeHuman: '',
    },
  ]);
});

test('Deepbrid upload selection prefers the requested video over archives', () => {
  const selected = selectDeepbridUploadFile(
    [
      {
        name: 'release.rar',
        link: 'https://cdn.deepbrid.com/release.rar',
        size: 2_000,
      },
      {
        name: 'release.nfo',
        link: 'https://cdn.deepbrid.com/release.nfo',
        size: 500,
      },
      {
        name: 'Show.S01E01.720p.mkv',
        link: 'https://cdn.deepbrid.com/episode.mkv',
        size: 700,
      },
    ],
    'Show.S01E01.720p.mkv'
  );
  assert.equal(selected?.name, 'Show.S01E01.720p.mkv');
});

test('Deepbrid upload selection falls back to the largest playable video', () => {
  const selected = selectDeepbridUploadFile(
    [
      {
        name: 'readme.txt',
        link: 'https://cdn.deepbrid.com/readme.txt',
        size: 1,
      },
      {
        name: 'small.mp4',
        link: 'https://cdn.deepbrid.com/small.mp4',
        size: 10,
      },
      {
        name: 'large.mkv',
        link: 'https://cdn.deepbrid.com/large.mkv',
        size: 100,
      },
    ],
    'missing.mkv'
  );
  assert.equal(selected?.name, 'large.mkv');
});

test('Deepbrid upload selection returns no file when an upload has no video', () => {
  assert.equal(
    selectDeepbridUploadFile(
      [{ name: 'release.rar', link: 'https://cdn.deepbrid.com/release.rar' }],
      'release.mkv'
    ),
    undefined
  );
});

test('Deepbrid upload selection chooses the requested member of a season pack', () => {
  const selected = selectDeepbridUploadFile(
    [
      {
        name: 'Tower.Prep.S01E01.720p.mkv',
        link: 'https://usenet.myfast.link/e1',
        size: 1,
      },
      {
        name: 'Tower.Prep.S01E09.720p.mkv',
        link: 'https://usenet.myfast.link/e9',
        size: 2,
      },
    ],
    'Tower Prep S01',
    { season: 1, episode: 9 }
  );
  assert.equal(selected?.name, 'Tower.Prep.S01E09.720p.mkv');
});

test('Deepbrid upload selection never substitutes the wrong pack episode', () => {
  const selected = selectDeepbridUploadFile(
    [
      {
        name: 'Tower.Prep.S01E01.720p.mkv',
        link: 'https://usenet.myfast.link/e1',
      },
      {
        name: 'Tower.Prep.S01E02.720p.mkv',
        link: 'https://usenet.myfast.link/e2',
      },
    ],
    'Tower Prep S01',
    { season: 1, episode: 9 }
  );
  assert.equal(selected, undefined);
});

function fakeDeepbridApi(): DeepbridOfficialApi {
  return {
    async getUser() {
      return { id: 'account' };
    },
    async listUploads() {
      return [
        {
          id: 'upload-1',
          title: 'Tower Prep S01',
          source: 'url',
          sourceUrl: 'https://indexer.example/tower-prep.nzb',
          addedAt: '2026-08-20T00:00:00Z',
        },
      ];
    },
    async addNzbUrl() {
      return { id: 'upload-1', title: 'Tower Prep S01', files: [] };
    },
    async getUploadInfo() {
      return {
        id: 'upload-1',
        title: 'Tower Prep S01',
        files: [
          {
            name: 'Tower.Prep.S01E01.720p.mkv',
            link: 'https://usenet.myfast.link/e1',
            size: 1_000_000_000,
            sizeHuman: '1 GB',
          },
          {
            name: 'Tower.Prep.S01E09.720p.mkv',
            link: 'https://usenet.myfast.link/e9',
            size: 2_000_000_000,
            sizeHuman: '2 GB',
          },
        ],
      };
    },
  };
}

test('Deepbrid service recognizes an already-owned external NZB', async () => {
  const service = new DeepbridService({ token: 'test' }, fakeDeepbridApi());
  const [result] = await service.checkNzbs([
    {
      name: 'Tower Prep S01',
      hash: 'external-hash',
      nzb: 'https://indexer.example/tower-prep.nzb',
    },
  ]);
  assert.equal(result.id, 'upload-1');
  assert.equal(result.status, 'cached');
  assert.equal(result.library, true);
  assert.equal(result.hash, 'external-hash');
});

test('Deepbrid pre-cache mode emits only verified external NZBs', async () => {
  const client = fakeDeepbridApi();
  client.listUploads = async () => [];
  client.addNzbUrl = async () => ({
    id: 'pre-cached-upload',
    title: 'External release',
    files: [],
  });
  client.getUploadInfo = async () => ({
    id: 'pre-cached-upload',
    title: 'External release',
    files: [
      {
        name: 'External.Release.S01E04.1080p.mkv',
        link: 'https://usenet.myfast.link/pre-cached',
        size: 1_000_000_000,
        sizeHuman: '1 GB',
      },
    ],
  });

  const service = new DeepbridService(
    { token: 'pre-cache', preCache: true, preCacheLimit: 1 },
    client
  );
  const [result] = await service.checkNzbs([
    {
      name: 'External release',
      hash: 'external-pre-cache-hash',
      nzb: 'https://indexer.example/external-pre-cache.nzb',
    },
  ]);

  assert.equal(result.id, 'pre-cached-upload');
  assert.equal(result.status, 'cached');
  assert.equal(result.library, true);
  assert.equal(result.files?.[0]?.name, 'External.Release.S01E04.1080p.mkv');
});

test('Deepbrid service resolves the requested episode from an owned upload', async () => {
  const service = new DeepbridService({ token: 'test' }, fakeDeepbridApi());
  const url = await service.resolve(
    {
      type: 'usenet',
      hash: 'external-hash',
      nzb: 'https://indexer.example/tower-prep.nzb',
      serviceItemId: 'upload-1',
      metadata: { titles: ['Tower Prep'], season: 1, episode: 9, airDates: [] },
    },
    'Tower Prep S01',
    true
  );
  assert.equal(url, 'https://usenet.myfast.link/e9');
});

test('Deepbrid service uses playable files returned directly by NZB add', async () => {
  let infoCalls = 0;
  let addCalls = 0;
  const client = fakeDeepbridApi();
  client.listUploads = async () => [];
  client.addNzbUrl = async () => {
    addCalls++;
    return {
      id: 'non-library-job-id',
      title: 'Tower Prep S01',
      files: [
        {
          name: 'Tower.Prep.S01E01.720p.mkv',
          link: `https://usenet.myfast.link/e1-${addCalls}`,
          size: 1_000_000_000,
          sizeHuman: '1 GB',
        },
        {
          name: 'Tower.Prep.S01E09.720p.mkv',
          link: `https://usenet.myfast.link/e9-${addCalls}`,
          size: 2_000_000_000,
          sizeHuman: '2 GB',
        },
      ],
    };
  };
  client.getUploadInfo = async () => {
    infoCalls++;
    throw new Error('must not poll when add already returned files');
  };

  const service = new DeepbridService({ token: 'direct-add' }, client);
  const url = await service.resolve(
    {
      type: 'usenet',
      hash: 'external-hash-direct',
      nzb: 'https://indexer.example/tower-prep-direct.nzb',
      metadata: { titles: ['Tower Prep'], season: 1, episode: 9, airDates: [] },
    },
    'Tower Prep S01',
    true
  );
  assert.equal(url, 'https://usenet.myfast.link/e9-1');
  assert.equal(addCalls, 1);
  assert.equal(infoCalls, 0);
});

test('Deepbrid service recovers the canonical upload id after a missing-id response', async () => {
  let listCalls = 0;
  const client = fakeDeepbridApi();
  client.listUploads = async () => {
    listCalls++;
    return [
      {
        id: 'canonical-upload-id',
        title: 'Tower Prep S01',
        source: 'url',
        sourceUrl: 'https://indexer.example/tower-prep-recover.nzb',
      },
    ];
  };
  client.addNzbUrl = async () => ({
    id: 'non-library-job-id',
    title: 'Tower Prep S01',
    files: [],
  });
  client.getUploadInfo = async (id) => {
    if (id !== 'canonical-upload-id') {
      throw new DeepbridApiError('Missing id', 200, 'api_1');
    }
    return {
      id,
      title: 'Tower Prep S01',
      files: [
        {
          name: 'Tower.Prep.S01E09.720p.mkv',
          link: 'https://usenet.myfast.link/e9',
          size: 2_000_000_000,
          sizeHuman: '2 GB',
        },
      ],
    };
  };

  const service = new DeepbridService({ token: 'recover-id' }, client);
  const url = await service.resolve(
    {
      type: 'usenet',
      hash: 'external-hash-recover',
      nzb: 'https://indexer.example/tower-prep-recover.nzb',
      metadata: { titles: ['Tower Prep'], season: 1, episode: 9, airDates: [] },
    },
    'Tower Prep S01',
    true
  );
  assert.equal(url, 'https://usenet.myfast.link/e9');
  assert.equal(listCalls, 1);
});

test('Deepbrid service rejects generated error videos as retryable playback failures', async () => {
  const client = fakeDeepbridApi();
  client.listUploads = async () => [];
  client.addNzbUrl = async () => ({
    id: 'job-id',
    title: 'Broken release',
    files: [
      {
        name: 'Broken.Release.1080p.mkv',
        link: 'https://usenet.myfast.link/error-video',
        size: 21_982,
        sizeHuman: '21 KB',
      },
    ],
  });
  const service = new DeepbridService({ token: 'error-video' }, client);

  await assert.rejects(
    service.resolve(
      {
        type: 'usenet',
        hash: 'broken-hash',
        nzb: 'https://indexer.example/broken.nzb',
      },
      'Broken.Release.1080p.mkv',
      true
    ),
    (error: unknown) =>
      error instanceof DebridError &&
      error.statusCode === 502 &&
      error.code === 'BAD_GATEWAY'
  );
});
