import assert from 'node:assert/strict';
import test from 'node:test';
import {
  makeTrackerCursor,
  makeTrackerTombstone,
  mergeTrackerRecord,
  parseTrackerCursor,
  TrackerRecordSchema,
} from './types.js';

const record = (updatedAt: number) =>
  TrackerRecordSchema.parse({
    id: 'imdb:tt1234567',
    kind: 'movie',
    state: 'in_progress',
    updatedAt,
    origin: 'nuvio',
  });

test('tracker records reject unsafe or malformed values', () => {
  assert.equal(
    TrackerRecordSchema.safeParse({ ...record(10), positionMs: -1 }).success,
    false
  );
  assert.equal(
    TrackerRecordSchema.safeParse({ ...record(10), text: 'x'.repeat(10_001) })
      .success,
    false
  );
  assert.equal(
    TrackerRecordSchema.safeParse({ ...record(10), id: '' }).success,
    false
  );
});

test('episode records preserve parent and episode titles separately', () => {
  const episode = TrackerRecordSchema.parse({
    id: 'episode:imdb:tt1234567:s2:e4',
    kind: 'episode',
    ids: { imdb: 'tt1234567' },
    title: 'Sample Show',
    seriesTitle: 'Sample Show',
    episodeTitle: 'A Separate Episode',
    season: 2,
    episode: 4,
    state: 'in_progress',
    updatedAt: 10,
    origin: 'nuvio',
  });
  assert.equal(episode.seriesTitle, 'Sample Show');
  assert.equal(episode.episodeTitle, 'A Separate Episode');
});

test('comment reactions can be represented without inventing comment text', () => {
  const comment = TrackerRecordSchema.parse({
    id: 'movie:imdb:tt1234567|comment:42',
    kind: 'movie',
    ids: { imdb: 'tt1234567' },
    state: 'comment',
    reaction: 'like',
    updatedAt: 10,
    origin: 'wetrakr',
  });
  assert.equal(comment.reaction, 'like');
  assert.equal(comment.text, undefined);
});

test('provider comment targets are distinct tracker records', () => {
  const likedComment = TrackerRecordSchema.parse({
    id: 'comment:wetrakr:80055|liked',
    kind: 'comment',
    ids: {},
    providerId: '80055',
    text: 'A terrific episode.',
    state: 'liked',
    updatedAt: 10,
    origin: 'wetrakr',
  });
  assert.equal(likedComment.kind, 'comment');
  assert.equal(likedComment.providerId, '80055');
});

test('merge is monotonic and stable for equal timestamps', () => {
  assert.equal(mergeTrackerRecord(null, record(10)).updatedAt, 10);
  assert.equal(mergeTrackerRecord(record(11), record(10)).updatedAt, 11);
  assert.equal(mergeTrackerRecord(record(10), record(10)).origin, 'nuvio');
});

test('deletion markers advance timestamp and revision and remain idempotent', () => {
  const original = TrackerRecordSchema.parse({
    ...record(42),
    revision: 3,
  });
  const deleted = makeTrackerTombstone(original, 'aiostreams', 40);
  assert.equal(deleted.state, 'deleted');
  assert.equal(deleted.deletedState, 'in_progress');
  assert.equal(deleted.updatedAt, 43);
  assert.equal(deleted.revision, 4);
  assert.equal(makeTrackerTombstone(deleted, 'aiostreams', 100), deleted);
});

test('cursor is keyset-based so timestamp ties do not skip records', () => {
  const token = makeTrackerCursor({ updatedAt: 42, id: 'imdb:tt1234567' });
  assert.deepEqual(parseTrackerCursor(token), {
    updatedAt: 42,
    id: 'imdb:tt1234567',
  });
  assert.equal(parseTrackerCursor('not-a-cursor'), null);
  assert.equal(parseTrackerCursor(''), null);
});
