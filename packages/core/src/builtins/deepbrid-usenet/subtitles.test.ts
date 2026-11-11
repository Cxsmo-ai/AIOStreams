import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyDeepbridSubtitleConversion,
  shouldConvertDeepbridSubtitleToWebVtt,
} from './subtitles.js';

const subtitle = {
  id: 'source-1',
  url: 'https://subs.example/captions.ass',
  lang: 'eng',
};

const enabledContext = {
  addons: [
    {
      enabled: true,
      identifier: 'deepbrid-usenet',
      preset: { options: { convertSubtitlesToWebVtt: true } },
    },
  ],
  userData: {
    services: [
      {
        id: 'deepbrid',
        enabled: true,
        credentials: { apiKey: 'd'.repeat(32) },
      },
    ],
  },
} as any;
const conversionUrl = () =>
  'https://aio.example/builtins/deepbrid-usenet/subtitle/convert/private.vtt';

test('recognizes only ASS/SSA/SUB by URL or declared format', () => {
  for (const ext of ['ass', 'SSA', 'sub']) {
    assert.equal(
      shouldConvertDeepbridSubtitleToWebVtt({
        url: `https://subs.example/track.${ext}?x=1`,
      }),
      true
    );
  }
  assert.equal(
    shouldConvertDeepbridSubtitleToWebVtt({ url: '/subs/captions.sub?file=1' }),
    true
  );
  assert.equal(
    shouldConvertDeepbridSubtitleToWebVtt({
      url: 'https://subs.example/download?id=1',
      format: 'SSA',
    }),
    true
  );
  assert.equal(
    shouldConvertDeepbridSubtitleToWebVtt({
      url: 'https://subs.example/a.srt',
    }),
    false
  );
  assert.equal(
    shouldConvertDeepbridSubtitleToWebVtt({
      url: 'https://subs.example/a.vtt',
    }),
    false
  );
  assert.equal(
    shouldConvertDeepbridSubtitleToWebVtt({
      url: 'https://subs.example/download?id=1',
      mimeType: 'text/x-ssa',
    }),
    true
  );
  assert.equal(
    shouldConvertDeepbridSubtitleToWebVtt({
      url: 'https://subs.example/download?id=1',
      filename: 'captions%2Eass',
    }),
    true
  );
  assert.equal(
    shouldConvertDeepbridSubtitleToWebVtt({
      url: 'https://subs.example/captions%2Essa?download=1',
    }),
    true
  );
  assert.equal(
    shouldConvertDeepbridSubtitleToWebVtt({
      url: 'https://subs.example/captions%2Esrt?download=1',
      format: 'ass',
    }),
    false
  );
  assert.equal(
    shouldConvertDeepbridSubtitleToWebVtt({
      url: 'https://subs.example/download?id=1',
      name: 'English ASS-style commentary',
    }),
    false
  );
  assert.equal(
    shouldConvertDeepbridSubtitleToWebVtt({
      url: 'https://subs.example/captions.ass',
      contentType: 'application/x-subrip',
    }),
    false
  );
  for (const [url, format] of [
    ['https://subs.example/captions.ass', 'srt'],
    ['https://subs.example/captions.ssa', 'vtt'],
    ['https://subs.example/captions.srt', 'ass'],
    ['https://subs.example/captions.vtt', 'sub'],
  ]) {
    assert.equal(
      shouldConvertDeepbridSubtitleToWebVtt({ url, format }),
      false,
      `${url} with declared ${format} must not be converted`
    );
  }
  assert.equal(
    shouldConvertDeepbridSubtitleToWebVtt({
      url: 'https://subs.example/download?id=1',
      extension: '.vtt',
      format: 'ass',
    }),
    false
  );
  assert.equal(
    shouldConvertDeepbridSubtitleToWebVtt({
      url: 'https://subs.example/captions.ass',
      extension: '.srt',
    }),
    false
  );
  assert.equal(
    shouldConvertDeepbridSubtitleToWebVtt({
      url: 'https://subs.example/download?id=1',
      extension: '.ssa',
    }),
    true
  );
});

test('toggle defaults off and leaves tracks alone without its Deepbrid config', () => {
  assert.deepEqual(
    applyDeepbridSubtitleConversion({ addons: [], userData: {} } as any, [
      subtitle,
    ]),
    [subtitle]
  );
});

test('Deepbrid converter wraps eligible tracks as private VTT capabilities', () => {
  const converted = applyDeepbridSubtitleConversion(
    enabledContext,
    [subtitle],
    'some-other-subtitle-addon',
    conversionUrl
  );
  assert.equal(converted.length, 1);
  assert.match(
    converted[0]!.url,
    /\/builtins\/deepbrid-usenet\/subtitle\/convert\//
  );
  assert.match(converted[0]!.url, /\.vtt$/);
  assert.equal(converted[0]!.format, 'vtt');
  assert.equal(converted[0]!.id, 'source-1-deepbrid-vtt');
  assert.equal(converted[0]!.url.includes('subs.example'), false);
  assert.equal(converted[0]!.url.includes('d'.repeat(32)), false);
});

test('subtitle conversion uses only the active profile Deepbrid key', () => {
  const keys: string[] = [];
  const profile = (apiKey: string) => ({
    addons: enabledContext.addons,
    userData: {
      services: [
        {
          id: 'deepbrid',
          enabled: true,
          credentials: { apiKey },
        },
      ],
    },
  });
  const makeUrl = ({ apiKey }: { apiKey: string }) => {
    keys.push(apiKey);
    return `https://aio.example/private-${keys.length}.vtt`;
  };

  const first = applyDeepbridSubtitleConversion(
    profile('a'.repeat(32)) as any,
    [subtitle],
    'subtitle-addon',
    makeUrl
  );
  const second = applyDeepbridSubtitleConversion(
    profile('b'.repeat(32)) as any,
    [subtitle],
    'subtitle-addon',
    makeUrl
  );

  assert.deepEqual(keys, ['a'.repeat(32), 'b'.repeat(32)]);
  assert.equal(first[0]!.url, 'https://aio.example/private-1.vtt');
  assert.equal(second[0]!.url, 'https://aio.example/private-2.vtt');
});

test('OpenSubtitles, Deepbrid OpenSubtitles, SRT, and VTT are not modified', () => {
  for (const addon of [
    'opensubtitles',
    'opensubtitles-v3-plus',
    'deepbrid-opensubtitles',
  ]) {
    assert.deepEqual(
      applyDeepbridSubtitleConversion(
        enabledContext,
        [subtitle],
        addon,
        conversionUrl
      ),
      [subtitle]
    );
  }
  for (const ext of ['srt', 'vtt']) {
    const track = { ...subtitle, url: `https://subs.example/track.${ext}` };
    assert.deepEqual(
      applyDeepbridSubtitleConversion(
        enabledContext,
        [track],
        'subtitle-addon',
        conversionUrl
      ),
      [track]
    );
  }
});

test('OpenSubtitles-origin tracks stay untouched inside mixed subtitle results', () => {
  const openTrack = {
    ...subtitle,
    id: 'opensubtitles-download-42',
    source: 'OpenSubtitles',
  };
  const converted = applyDeepbridSubtitleConversion(
    enabledContext,
    [openTrack, subtitle],
    'subtitle-aggregator',
    conversionUrl
  );

  assert.deepEqual(converted[0], openTrack);
  assert.match(converted[1]!.url, /\/subtitle\/convert\//);
  assert.equal(converted[1]!.format, 'vtt');
});

test('unsafe subtitle URLs remain available unmodified', () => {
  const unsafe = { ...subtitle, url: 'http://127.0.0.1/private.ass' };
  assert.deepEqual(
    applyDeepbridSubtitleConversion(
      enabledContext,
      [unsafe],
      'subtitle-addon',
      conversionUrl
    ),
    [unsafe]
  );
});
