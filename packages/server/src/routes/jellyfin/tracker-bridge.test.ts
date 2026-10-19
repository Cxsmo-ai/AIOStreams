import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { trackerRecordToWatchIdentity } from './tracker-bridge.js';
import { TrackerRecordSchema, config as appConfig } from '@aiostreams/core';

describe('Jellyfin Tracker Bridge', () => {
  it('defaults tracker bridge to enabled', () => {
    assert.equal(appConfig.jellyfin.trackerBridgeEnabled, true);
  });

  it('correctly maps movie tracker records to watch identity', () => {
    const movie = TrackerRecordSchema.parse({
      id: 'movie:imdb:tt1234567',
      kind: 'movie',
      ids: { imdb: 'tt1234567', tmdb: '999' },
      title: 'Test Movie',
      state: 'watched',
      updatedAt: 1000,
    });
    const identity = trackerRecordToWatchIdentity(movie);
    assert.ok(identity);
    assert.equal(identity.itemKey, 'm|tt1234567');
    assert.equal(identity.kind, 'movie');
    assert.equal(identity.mediaType, 'movie');
    assert.equal(identity.baseId, 'tt1234567');
  });

  it('correctly maps episode tracker records to watch identity with videoId and seriesKey', () => {
    const episode = TrackerRecordSchema.parse({
      id: 'episode:imdb:tt1196946:s2:e1',
      kind: 'episode',
      ids: { imdb: 'tt1196946' },
      season: 2,
      episode: 1,
      title: 'Red Sky at Night',
      state: 'in_progress',
      positionMs: 60000,
      durationMs: 120000,
      updatedAt: 2000,
    });
    const identity = trackerRecordToWatchIdentity(episode);
    assert.ok(identity);
    assert.equal(identity.itemKey, 'e|tt1196946:2:1');
    assert.equal(identity.kind, 'episode');
    assert.equal(identity.mediaType, 'series');
    assert.equal(identity.baseId, 'tt1196946');
    assert.equal(identity.videoId, 'tt1196946:2:1');
    assert.equal(identity.seriesKey, 's|tt1196946');
  });

  it('correctly maps series tracker records to watch identity', () => {
    const series = TrackerRecordSchema.parse({
      id: 'series:imdb:tt1196946',
      kind: 'series',
      ids: { imdb: 'tt1196946' },
      title: 'The Mentalist',
      state: 'watchlist',
      updatedAt: 3000,
    });
    const identity = trackerRecordToWatchIdentity(series);
    assert.ok(identity);
    assert.equal(identity.itemKey, 's|tt1196946');
    assert.equal(identity.kind, 'series');
    assert.equal(identity.mediaType, 'series');
    assert.equal(identity.baseId, 'tt1196946');
  });

  it('falls back to tmdb id when imdb id is not present', () => {
    const tmdbMovie = TrackerRecordSchema.parse({
      id: 'movie:tmdb:12345',
      kind: 'movie',
      ids: { tmdb: '12345' },
      title: 'TMDB Movie',
      state: 'watched',
    });
    const identity = trackerRecordToWatchIdentity(tmdbMovie);
    assert.ok(identity);
    assert.equal(identity.itemKey, 'm|tmdb:12345');
    assert.equal(identity.baseId, 'tmdb:12345');
  });
});

