import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  audioVideoStartSkewMs,
  decodeDeepbridCapability,
} from './deepbrid-local-ffmpeg.mjs';

test('decoder rejects non-capability, cross-origin, and credential-bearing URLs before spawning tools', async () => {
  for (const capabilityUrl of [
    'file:///tmp/private.mkv',
    'https://elsewhere.test/video.mkv',
    'https://user:secret@example.test/builtins/deepbrid-usenet/play/token/file.mkv',
  ]) {
    const result = await decodeDeepbridCapability({
      capabilityUrl,
      expectedOrigin: 'https://example.test',
      allowedBasePaths: ['/builtins/deepbrid-usenet/play/'],
      ffmpegPath: 'must-not-run',
      ffprobePath: 'must-not-run',
    });
    assert.equal(result.status, 'rejected-url');
    assert.equal(result.decodedSeconds, 0);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
});

const ffmpegAvailable =
  spawnSync(process.env.DEEPBIRD_FFMPEG_PATH || 'ffmpeg', ['-version'], {
    windowsHide: true,
    stdio: 'ignore',
  }).status === 0;
const ffprobeAvailable =
  spawnSync(process.env.DEEPBIRD_FFPROBE_PATH || 'ffprobe', ['-version'], {
    windowsHide: true,
    stdio: 'ignore',
  }).status === 0;

test('A/V skew is unknown rather than zero when either stream lacks a valid timestamp', () => {
  const audio = { start_time: '0.125' };
  assert.equal(audioVideoStartSkewMs(audio, { start_time: '0.1' }), 25);
  assert.equal(
    audioVideoStartSkewMs({ start_time: null }, { start_time: '0' }),
    null
  );
  assert.equal(
    audioVideoStartSkewMs({ start_time: 'N/A' }, { start_time: '0' }),
    null
  );
  assert.equal(audioVideoStartSkewMs({}, { start_time: '0' }), null);
});

test(
  'local synthetic A/V fixture is actually probed and decoded with measured duration',
  { skip: !ffmpegAvailable || !ffprobeAvailable },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'deepbrid-acceptance-'));
    const mediaPath = join(directory, 'fixture.mp4');
    const generated = spawnSync(
      process.env.DEEPBIRD_FFMPEG_PATH || 'ffmpeg',
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=320x180:r=24',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=44100',
        '-t',
        '2',
        '-c:v',
        'mpeg4',
        '-q:v',
        '5',
        '-c:a',
        'aac',
        '-shortest',
        '-movflags',
        '+faststart',
        mediaPath,
      ],
      { windowsHide: true, stdio: 'ignore', timeout: 20_000 }
    );
    if (generated.status !== 0) {
      await rm(directory, { recursive: true, force: true });
      t.skip('local FFmpeg lacks lavfi or fixture codecs');
      return;
    }
    const server = createServer((request, response) => {
      if (request.url !== '/fixture.mp4') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'video/mp4' });
      createReadStream(mediaPath).pipe(response);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      const origin = `http://127.0.0.1:${address.port}`;
      const result = await decodeDeepbridCapability({
        capabilityUrl: `${origin}/fixture.mp4`,
        expectedOrigin: origin,
        allowedBasePaths: ['/fixture.mp4'],
        ffmpegPath: process.env.DEEPBIRD_FFMPEG_PATH || 'ffmpeg',
        ffprobePath: process.env.DEEPBIRD_FFPROBE_PATH || 'ffprobe',
        seconds: 5,
        timeoutMs: 20_000,
      });
      assert.equal(result.status, 'decoded');
      assert.equal(result.audioPresent, true);
      assert.equal(result.videoPresent, true);
      assert.ok(result.decodedSeconds >= 1.5 && result.decodedSeconds <= 2.1);
      assert.ok(Number.isFinite(result.audioVideoSkewMs));
    } finally {
      server.close();
      await once(server, 'close');
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test('decoder clamps resource controls and does not return exception text', async () => {
  const result = await decodeDeepbridCapability({
    capabilityUrl: 'https://example.test/not-allowed',
    expectedOrigin: 'https://example.test',
    allowedBasePaths: ['/builtins/deepbrid-usenet/play/'],
    seconds: 1e9,
    timeoutMs: 1,
  });
  assert.deepEqual(result, {
    status: 'rejected-url',
    decodedSeconds: 0,
    audioVideoSkewMs: null,
  });
});
