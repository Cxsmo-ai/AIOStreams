import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseTorboxAudioTrack,
  chooseTorboxSubtitleTrack,
  TorboxClient,
} from './torbox-client.js';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function queuedClient(...responses: unknown[]) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    calls.push({ url: new URL(String(input)), init });
    const next = responses.shift();
    if (next instanceof Response) return next;
    return jsonResponse({ success: true, data: next });
  }) as typeof fetch;
  return { client: new TorboxClient(fetchImpl), calls };
}

test('builds permanent requestdl links for torrent, Usenet, and WebDL', () => {
  const client = new TorboxClient();
  for (const [type, endpoint, idParam] of [
    ['torrent', '/v1/api/torrents/requestdl', 'torrent_id'],
    ['usenet', '/v1/api/usenet/requestdl', 'usenet_id'],
    ['webdownload', '/v1/api/webdl/requestdl', 'web_id'],
  ] as const) {
    const url = new URL(
      client.buildRequestDlPermalink({
        type,
        itemId: 42,
        fileId: 7,
        token: 'test-token',
        quality: 'native',
        audioLanguage: 'auto',
        subtitleLanguage: 'off',
        appendFilename: true,
      })
    );
    assert.equal(url.pathname, endpoint);
    assert.equal(url.searchParams.get(idParam), '42');
    assert.equal(url.searchParams.get('file_id'), '7');
    assert.equal(url.searchParams.get('redirect'), 'true');
    assert.equal(url.searchParams.get('zip_link'), 'false');
    assert.equal(url.searchParams.get('append_name'), 'true');
  }
});

test('chooses relative audio/subtitle indexes with strict language matching', () => {
  const audios = [
    { index: 99, language_full: 'Japanese', channels: 2 },
    { index: 3, language: 'eng', channels: 6, default: true },
  ];
  const subtitles = [
    { index: 50, language: 'eng', codec: 'hdmv_pgs_subtitle' },
    { index: 51, language_full: 'English', codec: 'subrip', default: true },
  ];
  assert.equal(chooseTorboxAudioTrack(audios, 'English'), 1);
  assert.equal(chooseTorboxAudioTrack(audios, 'French'), undefined);
  assert.equal(chooseTorboxSubtitleTrack(subtitles, 'English'), 1);
  assert.equal(chooseTorboxSubtitleTrack(subtitles, 'off'), null);
});

test('creates a 1080p HLS stream using preflight relative track indexes', async () => {
  const { client, calls } = queuedClient(
    {
      metadata: {
        audios: [
          { language: 'jpn', channels: 2 },
          { language: 'eng', channels: 6, default: true },
        ],
        subtitles: [{ language: 'eng', codec: 'srt', default: true }],
      },
    },
    { hls_url: 'https://cdn.example.test/stream.m3u8', metadata: {} }
  );
  const result = await client.resolvePlayback({
    type: 'torrent',
    itemId: 12,
    fileId: 4,
    token: 'test-token',
    quality: '1080p',
    audioLanguage: 'English',
    subtitleLanguage: 'English',
    appendFilename: false,
  });
  assert.equal(result.mode, 'stream');
  assert.equal(result.url, 'https://cdn.example.test/stream.m3u8');
  assert.equal(result.chosenAudioIndex, 1);
  assert.equal(result.chosenSubtitleIndex, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.searchParams.get('chosen_audio_index'), '1');
  assert.equal(calls[1].url.searchParams.get('chosen_subtitle_index'), '0');
  assert.equal(calls[1].url.searchParams.get('chosen_resolution_index'), '5');
});

test('uses resolution index 4 for 720p and supports WebDL stream type', async () => {
  const { client, calls } = queuedClient(
    { metadata: { audios: [{}], subtitles: [] } },
    { hls_url: 'https://cdn.example.test/web.m3u8' }
  );
  const result = await client.resolvePlayback({
    type: 'webdownload',
    itemId: 8,
    fileId: 0,
    token: 'test-token',
    quality: '720p',
    audioLanguage: 'auto',
    subtitleLanguage: 'off',
    appendFilename: false,
  });
  assert.equal(result.mode, 'stream');
  assert.equal(calls[1].url.searchParams.get('type'), 'webdownload');
  assert.equal(calls[1].url.searchParams.get('chosen_resolution_index'), '4');
});

test('falls back to the complete native file when preferred audio is absent', async () => {
  const { client, calls } = queuedClient({
    metadata: { audios: [{ language: 'jpn' }], subtitles: [] },
  });
  const result = await client.resolvePlayback({
    type: 'usenet',
    itemId: 2,
    fileId: 1,
    token: 'test-token',
    quality: '1080p',
    audioLanguage: 'English',
    subtitleLanguage: 'off',
    appendFilename: false,
  });
  assert.equal(result.mode, 'native');
  assert.equal(result.fallbackReason, 'preferred-audio-missing');
  assert.equal(calls.length, 1);
  assert.equal(new URL(result.url).pathname, '/v1/api/usenet/requestdl');
});

test('falls back to native for an explicitly requested image-only subtitle', async () => {
  const { client } = queuedClient({
    metadata: {
      audios: [{ language: 'eng' }],
      subtitles: [{ language: 'eng', codec: 'hdmv_pgs_subtitle' }],
    },
  });
  const result = await client.resolvePlayback({
    type: 'torrent',
    itemId: 2,
    fileId: 1,
    token: 'test-token',
    quality: '720p',
    audioLanguage: 'English',
    subtitleLanguage: 'English',
    appendFilename: false,
  });
  assert.equal(result.mode, 'native');
  assert.equal(result.fallbackReason, 'subtitle-format-unsupported');
});

test('falls back to native when the Stream API fails', async () => {
  const { client } = queuedClient(
    jsonResponse(
      { success: false, error: 'TEMPORARY_ERROR', detail: 'try later' },
      503
    )
  );
  const result = await client.resolvePlayback({
    type: 'webdownload',
    itemId: 2,
    fileId: 1,
    token: 'test-token',
    quality: '1080p',
    audioLanguage: 'auto',
    subtitleLanguage: 'off',
    appendFilename: false,
  });
  assert.equal(result.mode, 'native');
  assert.equal(result.fallbackReason, 'stream-api-failure');
  assert.equal(new URL(result.url).pathname, '/v1/api/webdl/requestdl');
});

test('uses official WebDL cache, create, and list operations', async () => {
  const { client, calls } = queuedClient({}, {}, []);
  await client.checkWebDownloadCache('test-token', ['abc']);
  await client.createWebDownload(
    'test-token',
    'https://files.example/a.mkv',
    true
  );
  await client.listWebDownloads('test-token', 9);
  assert.equal(calls[0].url.pathname, '/v1/api/webdl/checkcached');
  assert.equal(calls[0].init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    hashes: ['abc'],
  });
  assert.equal(calls[1].url.pathname, '/v1/api/webdl/createwebdownload');
  assert.match(String(calls[1].init?.body), /add_only_if_cached=true/);
  assert.equal(calls[2].url.pathname, '/v1/api/webdl/mylist');
  assert.equal(calls[2].url.searchParams.get('id'), '9');
});

test('uploads NZB bytes with official immediate cached-only fields', async () => {
  const { client, calls } = queuedClient({
    usenetdownload_id: 55,
    hash: 'hash-55',
    auth_id: 9,
  });
  const created = await client.createUsenetDownloadFromFile(
    'test-token',
    Buffer.from('<nzb/>'),
    'Movie',
    true
  );
  assert.equal(created.id, 55);
  assert.equal(calls[0].url.pathname, '/v1/api/usenet/createusenetdownload');
  const form = calls[0].init?.body as FormData;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('add_only_if_cached'), 'true');
  assert.equal(form.get('as_queued'), 'false');
  assert.equal(form.get('post_processing'), '-1');
  assert.equal(form.get('name'), 'Movie');
  assert.ok(form.get('file') instanceof Blob);
});
