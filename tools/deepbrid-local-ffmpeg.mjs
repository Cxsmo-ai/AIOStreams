import { spawn } from 'node:child_process';
import { isAllowedPlaybackUrl } from './playback-safety.mjs';

const clamp = (value, min, max, fallback) =>
  Number.isFinite(Number(value))
    ? Math.min(max, Math.max(min, Number(value)))
    : fallback;

function run(binary, args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    let timedOut = false;
    const child = spawn(binary, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 256 * 1024)
        stdout += chunk.toString('utf8').slice(0, 256 * 1024 - stdout.length);
    });
    child.once('error', (error) =>
      finish({
        ok: false,
        category: error.code === 'ENOENT' ? 'binary-missing' : 'process-error',
      })
    );
    child.once('close', (code) =>
      finish({ ok: code === 0 && !timedOut, code, timedOut, stdout })
    );
  });
}

export function audioVideoStartSkewMs(audio, video) {
  const hasStart = (stream) =>
    stream?.start_time !== null &&
    stream?.start_time !== undefined &&
    stream.start_time !== '' &&
    Number.isFinite(Number(stream.start_time));
  if (!hasStart(audio) || !hasStart(video)) return null;
  return Math.round(
    Math.abs(Number(audio.start_time) - Number(video.start_time)) * 1000
  );
}

export async function decodeDeepbridCapability({
  capabilityUrl,
  expectedOrigin,
  allowedBasePaths = ['/'],
  ffmpegPath = 'ffmpeg',
  ffprobePath = 'ffprobe',
  seconds = 15,
  timeoutMs = 90_000,
}) {
  const safeSeconds = clamp(seconds, 1, 60, 15);
  const safeTimeout = clamp(timeoutMs, 1_000, 120_000, 90_000);
  if (!isAllowedPlaybackUrl(capabilityUrl, expectedOrigin, allowedBasePaths)) {
    return {
      status: 'rejected-url',
      decodedSeconds: 0,
      audioVideoSkewMs: null,
    };
  }
  // FFmpeg/ffprobe may follow redirects or HLS child references after this
  // initial check. This helper is for trusted AIOStreams-generated capability
  // URLs only; it is not an egress firewall for arbitrary user-provided URLs.
  const probeArgs = [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,start_time',
    '-of',
    'json',
    capabilityUrl,
  ];
  const probe = await run(ffprobePath, probeArgs, safeTimeout);
  if (!probe.ok)
    return {
      status:
        probe.category || (probe.timedOut ? 'probe-timeout' : 'probe-failed'),
      decodedSeconds: 0,
      audioVideoSkewMs: null,
    };
  let streams;
  try {
    streams = JSON.parse(probe.stdout).streams;
  } catch {
    return {
      status: 'probe-invalid-response',
      decodedSeconds: 0,
      audioVideoSkewMs: null,
    };
  }
  if (!Array.isArray(streams) || streams.length === 0)
    return {
      status: 'probe-no-streams',
      decodedSeconds: 0,
      audioVideoSkewMs: null,
    };
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const video = streams.find((stream) => stream.codec_type === 'video');
  const starts = [audio, video]
    .filter(
      (stream) =>
        stream?.start_time !== null &&
        stream?.start_time !== undefined &&
        stream.start_time !== ''
    )
    .map((stream) => Number(stream.start_time))
    .filter(Number.isFinite);
  const audioVideoSkewMs = audioVideoStartSkewMs(audio, video);
  const decoded = await run(
    ffmpegPath,
    [
      '-nostdin',
      '-hide_banner',
      '-v',
      'error',
      '-i',
      capabilityUrl,
      '-t',
      String(safeSeconds),
      '-map',
      '0:v:0?',
      '-map',
      '0:a:0?',
      '-progress',
      'pipe:1',
      '-nostats',
      '-f',
      'null',
      '-',
    ],
    safeTimeout
  );
  if (!decoded.ok)
    return {
      status: decoded.timedOut ? 'decode-timeout' : 'decode-failed',
      decodedSeconds: 0,
      audioVideoSkewMs,
    };
  const decodedUs = [...decoded.stdout.matchAll(/^out_time_us=(\d+)$/gm)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite)
    .at(-1);
  const decodedSeconds =
    decodedUs === undefined ? 0 : Math.min(safeSeconds, decodedUs / 1_000_000);
  if (decodedSeconds <= 0)
    return {
      status: 'decode-duration-unmeasured',
      decodedSeconds: 0,
      audioVideoSkewMs,
    };
  return {
    status: 'decoded',
    decodedSeconds,
    audioVideoSkewMs,
    audioPresent: Boolean(audio),
    videoPresent: Boolean(video),
    streamCount: streams.length,
    earliestStreamStartMs: starts.length
      ? Math.round(Math.min(...starts) * 1000)
      : null,
  };
}
