import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(
  new URL('./deepbrid-full-playback-acceptance.mjs', import.meta.url)
);

function runAcceptance(inputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, TEST_INPUT_FILE: inputPath, TEST_LABELS: '' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout }));
  });
}

test('full acceptance harness exercises a synthetic Deepbrid episode through ranged playback', async () => {
  const media = Buffer.alloc(2 * 1024 * 1024, 0x41);
  const streamsFor = (type, origin) => {
    const release =
      type === 'series'
        ? 'Example Show S03E23 1080p WEB-DL'
        : 'Example Film 2024 1080p WEB-DL';
    return ['direct', 'hls', 'remux'].map((mode) => ({
      name: `Deepbrid Usenet Finder · ${mode}`,
      description: release,
      url: `${origin}/builtins/deepbrid-usenet/play/test-capability/${mode === 'hls' ? 'stream.m3u8' : `${mode}.mkv`}`,
      addon: { identifier: 'deepbrid-usenet' },
      behaviorHints: {
        deepbridPlaybackMode: mode,
        deepbridReleaseTitle: release,
        deepbridReleaseSize: 100 * 1024 * 1024,
      },
    }));
  };
  const server = createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    const seriesProgressive =
      pathname === '/stream-progressive/series/series-fixture.ndjson';
    const seriesJson = pathname === '/stream/series/series-fixture.json';
    const movieJson = pathname === '/stream/movie/movie-fixture.json';
    if (seriesJson || movieJson || seriesProgressive) {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const type = movieJson ? 'movie' : 'series';
      const payload = {
        streams: streamsFor(type, origin),
      };
      if (seriesProgressive) {
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        response.end(
          [
            JSON.stringify({ event: 'hello', version: 1 }),
            JSON.stringify({ event: 'snapshot', ...payload }),
            JSON.stringify({ event: 'complete', ...payload }),
          ].join('\n')
        );
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(payload));
      }
      return;
    }
    if (pathname.startsWith('/builtins/deepbrid-usenet/play/')) {
      if (pathname.endsWith('.m3u8')) {
        response.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
        });
        response.end('#EXTM3U\n#EXTINF:2,fixture\nsegment.ts\n');
        return;
      }
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
      if (!range) {
        response.writeHead(416).end();
        return;
      }
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), media.length - 1);
      if (start >= media.length || end < start) {
        response.writeHead(416).end();
        return;
      }
      response.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes ${start}-${end}/${media.length}`,
        'Content-Length': String(end - start + 1),
      });
      response.end(media.subarray(start, end + 1));
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const directory = await mkdtemp(join(tmpdir(), 'deepbrid-harness-'));
  const inputPath = join(directory, 'input.json');
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    await writeFile(
      inputPath,
      JSON.stringify({
        manifest: `${origin}/manifest.json`,
        cases: [
          {
            label: 'synthetic-episode',
            type: 'series',
            id: 'series-fixture',
            targetSeason: 3,
            targetEpisode: 23,
            selectLargestEpisodePerMode: true,
            minimumReleaseBytes: 1024,
            maxProbes: 3,
          },
        ],
      })
    );
    const { code, stdout } = await runAcceptance(inputPath);
    assert.equal(code, 0, stdout);
    const [line] = stdout.trim().split(/\r?\n/);
    const report = JSON.parse(line);
    assert.equal(report.playbackPassed, true);
    assert.equal(report.episodeModeSelectionPassed, true);
    assert.equal(report.deepbridFinderEntryCount, 3);
    assert.deepEqual([...report.selectedPlaybackModes].sort(), [
      'direct',
      'hls',
      'remux',
    ]);
    assert.equal(
      report.results.every((result) => result.ok),
      true
    );
    const directResult = report.results.find(
      (result) => result.mode === 'direct'
    );
    const hlsResult = report.results.find((result) => result.mode === 'hls');
    const remuxResult = report.results.find(
      (result) => result.mode === 'remux'
    );
    assert.equal(directResult.first.rangeHonored, true);
    assert.equal(directResult.second.rangeHonored, true);
    assert.equal(hlsResult.playlist.isManifest, true);
    assert.equal(remuxResult.probeKind, 'sequential-transport-only');
    assert.equal(stdout.includes('test-capability'), false);

    await writeFile(
      inputPath,
      JSON.stringify({
        manifest: `${origin}/manifest.json`,
        cases: [
          {
            label: 'synthetic-movie',
            type: 'movie',
            id: 'movie-fixture',
            selectLargestPerMode: true,
            minimumReleaseBytes: 1024,
            maxProbes: 3,
          },
        ],
      })
    );
    const movieRun = await runAcceptance(inputPath);
    assert.equal(movieRun.code, 0, movieRun.stdout);
    const movieReport = JSON.parse(movieRun.stdout.trim());
    assert.equal(movieReport.playbackPassed, true);
    assert.deepEqual([...movieReport.selectedPlaybackModes].sort(), [
      'direct',
      'hls',
      'remux',
    ]);

    await writeFile(
      inputPath,
      JSON.stringify({
        manifest: `${origin}/manifest.json?client=nuvio-progressive`,
        cases: [
          {
            label: 'synthetic-progressive-episode',
            type: 'series',
            id: 'series-fixture',
            targetSeason: 3,
            targetEpisode: 23,
            selectLargestEpisodePerMode: true,
            minimumReleaseBytes: 1024,
            maxProbes: 3,
          },
        ],
      })
    );
    const progressiveRun = await runAcceptance(inputPath);
    assert.equal(progressiveRun.code, 0, progressiveRun.stdout);
    const progressiveReport = JSON.parse(progressiveRun.stdout.trim());
    assert.equal(progressiveReport.playbackPassed, true);
    assert.equal(progressiveReport.deepbridFinderEntryCount, 3);
    assert.equal(progressiveReport.progressiveSnapshotCount, 1);
    assert.equal(progressiveReport.progressiveFirstFinderMs >= 0, true);
    assert.equal(progressiveRun.stdout.includes('test-capability'), false);
  } finally {
    server.close();
    await once(server, 'close');
    await rm(directory, { recursive: true, force: true });
  }
});
