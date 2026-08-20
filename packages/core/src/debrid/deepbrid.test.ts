import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DeepbridService,
  selectDeepbridUploadFile,
  type DeepbridOfficialApi,
} from './deepbrid.js';

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
      return 'upload-1';
    },
    async getUploadInfo() {
      return {
        id: 'upload-1',
        title: 'Tower Prep S01',
        files: [
          {
            name: 'Tower.Prep.S01E01.720p.mkv',
            link: 'https://usenet.myfast.link/e1',
            size: 1,
            sizeHuman: '1 GB',
          },
          {
            name: 'Tower.Prep.S01E09.720p.mkv',
            link: 'https://usenet.myfast.link/e9',
            size: 2,
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
