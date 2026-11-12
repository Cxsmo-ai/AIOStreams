import assert from 'node:assert/strict';
import test from 'node:test';
import {
  projectDeepbridFolderFiles,
  projectDeepbridUploadDetails,
} from './deepbrid-upload.js';

test('folder projection omits signed file links and distinguishes candidates from unavailable files', () => {
  const projected = projectDeepbridFolderFiles([
    {
      name: 'Movie.mkv',
      link: 'https://premium-dl.deepbrid.com/signed/secret-token',
      size: 42,
      sizeHuman: '42 B',
      playableCandidate: true,
      status: 'candidate',
    },
    {
      name: 'notes.txt',
      link: '',
      size: 10,
      sizeHuman: '10 B',
      playableCandidate: false,
      status: 'unreachable',
      reason: 'missing-link',
    },
  ]);
  assert.deepEqual(projected, [
    {
      name: 'Movie.mkv',
      size: 42,
      sizeHuman: '42 B',
      playableCandidate: true,
      status: 'candidate',
      reason: undefined,
    },
    {
      name: 'notes.txt',
      size: 10,
      sizeHuman: '10 B',
      playableCandidate: false,
      status: 'unreachable',
      reason: 'missing-link',
    },
  ]);
  assert.doesNotMatch(JSON.stringify(projected), /https?:\/\/|secret-token/);
});

test('projects useful upload file and archive state without leaking provider links or raw failure details', () => {
  const projected = projectDeepbridUploadDetails({
    id: '42',
    title: 'Example upload',
    files: [
      {
        name: 'Example.part01.rar',
        link: 'https://private.example/signed/secret-token',
        size: 1024,
        sizeHuman: '1 KiB',
      },
      {
        name: 'Example.part03.rar',
        link: '',
        size: 2048,
        sizeHuman: '2 KiB',
        unreachable: 'provider-private-detail',
      },
      {
        name: 'notes.nfo',
        link: 'https://private.example/notes',
        size: 5,
        sizeHuman: '5 B',
      },
    ],
  });

  assert.equal(projected.id, '42');
  assert.deepEqual(
    projected.files.map(({ kind, status, reason }) => ({
      kind,
      status,
      reason,
    })),
    [
      { kind: 'archive', status: 'non-video', reason: 'not-video' },
      {
        kind: 'archive',
        status: 'unreachable',
        reason: 'provider-unreachable',
      },
      { kind: 'other', status: 'non-video', reason: 'not-video' },
    ]
  );
  assert.deepEqual(projected.archive, {
    status: 'incomplete',
    missingVolumeNumbers: [2],
    unreachableArchiveCount: 1,
  });
  assert.doesNotMatch(
    JSON.stringify(projected),
    /https?:\/\/|secret-token|provider-private-detail/
  );
});
