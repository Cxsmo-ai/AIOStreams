import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeMetadata, resolveSource } from './merge.js';

test('series metadata uses stronger identities for scalar fields and unions genres', () => {
  const contributions = {
    tvmaze: {
      primaryTitle: 'Kitchen Nightmares',
      year: 2007,
      yearEnd: 2014,
      originalLanguage: 'en',
      country: 'gb',
      runtime: 60,
      genres: ['Reality'],
    },
    tvdb: {
      primaryTitle: 'Kitchen Nightmares',
      year: 2007,
      country: 'US',
      tvdbId: 81189,
    },
    tmdb: {
      primaryTitle: 'Kitchen Nightmares',
      originalLanguage: 'en',
      runtime: 44,
      genres: ['Reality', 'Food'],
      tmdbId: 12345,
    },
  };

  const merged = mergeMetadata(contributions, 'series');

  assert.equal(merged.title, 'Kitchen Nightmares');
  assert.equal(merged.year, 2007);
  assert.equal(merged.yearEnd, 2014);
  assert.equal(merged.country, 'US');
  assert.equal(merged.runtime, 44);
  assert.deepEqual(merged.genres, ['Reality', 'Food']);
  assert.equal(merged.tmdbId, 12345);
  assert.equal(merged.tvdbId, 81189);
  assert.equal(resolveSource(contributions, 'runtime', 'series'), 'tmdb');
  assert.equal(resolveSource(contributions, 'yearEnd', 'series'), 'tvmaze');
});

test('TVDB and TMDB remain authoritative over a conflicting TVMaze fallback', () => {
  const contributions = {
    tvmaze: {
      primaryTitle: 'The Office',
      year: 2005,
      country: 'us',
      runtime: 30,
    },
    tvdb: {
      primaryTitle: 'The Office (UK)',
      year: 2001,
      country: 'gb',
      runtime: 29,
      tvdbId: 100,
    },
    tmdb: {
      primaryTitle: 'The Office',
      year: 2005,
      runtime: 22,
      tmdbId: 200,
    },
    imdbSuggestion: { year: 2005 },
  };

  const merged = mergeMetadata(contributions, 'series');

  // IMDb resolves the known TVDB/TMDB year disagreement, while the field
  // priorities still keep TVDB's country and TMDB's runtime.
  assert.equal(merged.year, 2005);
  assert.equal(merged.country, 'gb');
  assert.equal(merged.runtime, 22);
  assert.equal(merged.title, 'The Office (UK)');
});

test('movie merge does not let a series-only TVMaze contribution affect fields', () => {
  const contributions = {
    tvmaze: { primaryTitle: 'Movie', year: 2020, runtime: 90 },
    tmdb: { primaryTitle: 'Movie', year: 2021, runtime: 95, tmdbId: 42 },
  };

  const merged = mergeMetadata(contributions, 'movie');

  assert.equal(merged.title, 'Movie');
  assert.equal(merged.year, 2021);
  assert.equal(merged.runtime, 95);
  assert.equal(merged.tmdbId, 42);
  assert.equal(resolveSource(contributions, 'runtime', 'movie'), 'tmdb');
});
