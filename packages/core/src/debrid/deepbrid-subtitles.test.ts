import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterDeepbridSubtitles,
  formatDeepbridSubtitles,
  matchesDeepbridSubtitleQuery,
  type DeepbridOpenSubtitleItem,
} from './deepbrid-subtitles.js';

const item = (overrides: Partial<DeepbridOpenSubtitleItem>): DeepbridOpenSubtitleItem => ({
  file_id: 1,
  file_name: 'Titanic.1997.1080p.WEBRip.x264',
  release: 'Titanic.1997.1080p.WEBRip.x264',
  title: 'Titanic',
  lang: 'en',
  year: 1997,
  ...overrides,
});

test('Deepbrid subtitle matching rejects fuzzy title collisions', () => {
  assert.equal(matchesDeepbridSubtitleQuery(item({
    file_name: 'The.Chambermaid.On.The.Titanic.1997.720p.WEBRip.x264',
    release: 'The.Chambermaid.On.The.Titanic.1997.720p.WEBRip.x264',
    title: 'The Chambermaid on the Titanic',
  }), 'Titanic 1997'), false);
  assert.equal(matchesDeepbridSubtitleQuery(item({}), 'Titanic 1997'), true);
});

test('Deepbrid subtitle matching keeps the requested show episode', () => {
  assert.equal(matchesDeepbridSubtitleQuery(item({
    file_name: 'The.Mentalist.S01E04.720p.HDTV.x264',
    release: 'The.Mentalist.S01E04.720p.HDTV.x264',
    title: 'Ladies in Red',
    year: 2008,
  }), 'The Mentalist S01E04'), true);
  assert.equal(matchesDeepbridSubtitleQuery(item({
    file_name: 'The.Mentalist.S01E05.720p.HDTV.x264',
    release: 'The.Mentalist.S01E05.720p.HDTV.x264',
    title: 'Red Sky at Night',
    year: 2008,
  }), 'The Mentalist S01E04'), false);
  assert.equal(matchesDeepbridSubtitleQuery(item({
    file_name: 'The.Hawk.2026.S01E06.1080p.WEB.h264',
    release: 'The.Hawk.2026.S01E06.1080p.WEB.h264',
    title: 'The Genesis Invitational',
    year: 2026,
  }), 'The Hawk S01E06'), true);
});

test('Deepbrid subtitle filtering validates IDs, language, and duplicates', () => {
  const results = filterDeepbridSubtitles([
    item({ file_id: 10 }),
    item({ file_id: '10' }),
    item({ file_id: 11, lang: 'Spanish' }),
    item({ file_id: 'bad' }),
  ], 'Titanic 1997', 'en');
  assert.deepEqual(results.map((result) => result.file_id), [10]);
});

test('Deepbrid subtitle formatting creates playable absolute VTT proxy URLs', () => {
  const [subtitle] = formatDeepbridSubtitles([
    item({ file_id: '3100908', lang: 'English', hearing_impaired: true, downloads: 12 }),
  ], 'https://example.test/', 8);
  assert.equal(subtitle.lang, 'en');
  assert.match(subtitle.title, /^\[DB\] .*\[SDH\].*12 dl/);
  assert.equal(
    subtitle.url,
    'https://example.test/builtins/deepbrid-subtitles/download/3100908/Titanic.1997.1080p.WEBRip.x264.vtt'
  );
});
