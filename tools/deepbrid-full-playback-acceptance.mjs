import { readFile } from 'node:fs/promises';

const input = process.env.TEST_INPUT_FILE
  ? JSON.parse(await readFile(process.env.TEST_INPUT_FILE, 'utf8'))
  : {
      manifest: process.env.AIOSTREAMS_MANIFEST_URL,
      cases: JSON.parse(process.env.TEST_CASES_JSON || '[]'),
    };

if (!input.manifest) throw new Error('AIOSTREAMS_MANIFEST_URL is required');

const base = input.manifest.replace(/\/manifest\.json$/, '');
const labels = new Set(
  String(process.env.TEST_LABELS || '')
    .split('|')
    .map((value) => value.trim())
    .filter(Boolean)
);
const cases = labels.size
  ? input.cases.filter((item) => labels.has(item.label))
  : input.cases;

const sizeFactors = {
  B: 1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
};

function findLargestSize(text) {
  let largest = 0;
  for (const match of text.matchAll(/(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|KB|B)\b/gi)) {
    const bytes = Number(match[1].replace(',', '.')) * sizeFactors[match[2].toUpperCase()];
    if (Number.isFinite(bytes)) largest = Math.max(largest, bytes);
  }
  return largest;
}

function streamSize(stream) {
  const hinted = Number(
    stream.behaviorHints?.deepbridReleaseSize ||
      stream.behaviorHints?.videoSize ||
      0
  );
  return Math.max(
    Number.isFinite(hinted) ? hinted : 0,
    findLargestSize(
      `${stream.name || ''}\n${stream.description || ''}\n${stream.behaviorHints?.deepbridReleaseTitle || ''}`
    )
  );
}

function isSeasonPack(stream) {
  const release = `${stream.name || ''}\n${stream.description || ''}`;
  return (
    stream.behaviorHints?.deepbridSeasonPack === true ||
    /\b(?:complete|season[ ._-]*\d{1,2}|s\d{1,2})\b.*\b(?:season|pack|complete)\b/i.test(
      release
    ) ||
    /\bS\d{1,2}\b(?![ ._-]*E\d{1,3})/i.test(release)
  );
}

async function rangeProbe(url, start) {
  const end = start + 65535;
  const response = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' },
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.arrayBuffer();
  const contentRange = response.headers.get('content-range') || '';
  return {
    status: response.status,
    bytes: body.byteLength,
    contentRange,
    contentType: response.headers.get('content-type') || '',
    ok:
      response.status === 206 &&
      body.byteLength > 0 &&
      new RegExp(`^bytes\\s+${start}-\\d+/(?:\\d+|\\*)$`, 'i').test(
        contentRange
      ),
  };
}

let failed = false;
for (const item of cases) {
  const started = performance.now();
  try {
    const response = await fetch(
      `${base}/stream/${item.type}/${encodeURIComponent(item.id)}.json`,
      {
        headers: { 'User-Agent': 'AIOStreams-Deepbrid-acceptance/1.0' },
        signal: AbortSignal.timeout(180_000),
      }
    );
    const payload = await response.json();
    const allStreams = (payload.streams || [])
      .filter(
        (stream) =>
          typeof stream.url === 'string' &&
          /(?:deepbrid|\bDB\b)/i.test(
            `${stream.name || ''}\n${stream.description || ''}`
          )
      )
      .map((stream) => ({
        stream,
        releaseBytes: streamSize(stream),
        seasonPack: isSeasonPack(stream),
      }));

    let selected = allStreams;
    if (item.selectLargest) {
      selected = allStreams.length
        ? [allStreams.reduce((largest, current) =>
            current.releaseBytes > largest.releaseBytes ? current : largest
          )]
        : [];
    } else if (item.selectLargestPack) {
      const packs = allStreams.filter((entry) => entry.seasonPack);
      selected = packs.length
        ? [packs.reduce((largest, current) =>
            current.releaseBytes > largest.releaseBytes ? current : largest
          )]
        : [];
    }

    const results = await Promise.all(
      selected.map(async ({ stream, releaseBytes, seasonPack }) => {
        const description = String(stream.description || '').split('\n');
        const filename = stream.behaviorHints?.filename || '';
        const release =
          stream.behaviorHints?.deepbridReleaseTitle ||
          description.find((line) => line && line !== filename) ||
          '';
        const url = new URL(stream.url);
        try {
          const [first, second] = await Promise.all([
            rangeProbe(stream.url, 0),
            rangeProbe(stream.url, 1_048_576),
          ]);
          return {
            filename,
            release,
            releaseBytes,
            seasonPack,
            archiveExpanded:
              stream.behaviorHints?.deepbridArchiveExpanded === true,
            signedProxy: url.pathname.startsWith(
              '/builtins/deepbrid-usenet/play/'
            ),
            first,
            second,
            ok: first.ok && second.ok,
          };
        } catch (error) {
          return {
            filename,
            release,
            releaseBytes,
            seasonPack,
            error: error instanceof Error ? error.message : String(error),
            ok: false,
          };
        }
      })
    );

    const minimumReleaseBytes = Number(item.minimumReleaseBytes || 0);
    const passed =
      response.ok &&
      results.length > 0 &&
      results.every((entry) => entry.ok) &&
      (!item.requireSeasonPack || results.every((entry) => entry.seasonPack)) &&
      (!minimumReleaseBytes ||
        results.every((entry) => entry.releaseBytes >= minimumReleaseBytes));
    failed ||= !passed;
    process.stdout.write(
      `${JSON.stringify({
        label: item.label,
        passed,
        status: response.status,
        elapsedMs: Math.round(performance.now() - started),
        sourceCount: allStreams.length,
        packSources: allStreams.filter((entry) => entry.seasonPack).length,
        selectedCount: results.length,
        selectedLargest: item.selectLargest === true,
        selectedLargestPack: item.selectLargestPack === true,
        results,
      })}\n`
    );
  } catch (error) {
    failed = true;
    process.stdout.write(
      `${JSON.stringify({
        label: item.label,
        passed: false,
        elapsedMs: Math.round(performance.now() - started),
        requestError: error instanceof Error ? error.message : String(error),
      })}\n`
    );
  }
}

if (failed) process.exitCode = 1;
