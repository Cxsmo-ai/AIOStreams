const manifestUrl = process.env.PRIVATE_MANIFEST_URL;
if (!manifestUrl) throw new Error('PRIVATE_MANIFEST_URL is required');
const testId = process.env.TEST_ID ?? 'tt1196946:1:1';
if (!/^(?:tt\d+|tmdb:\d+):\d+:\d+$/.test(testId)) {
  throw new Error('TEST_ID must be a series episode ID');
}

const streamUrl = new URL(manifestUrl);
streamUrl.pathname = streamUrl.pathname.replace(
  /manifest\.json$/,
  `stream/series/${testId}.json`
);

const startedAt = Date.now();
const streamResponse = await fetch(streamUrl, {
  headers: { 'user-agent': 'AIOStreams-Newshosting-Smoke/1.0' },
  signal: AbortSignal.timeout(90_000),
});
if (!streamResponse.ok) {
  throw new Error(`Stream lookup failed with HTTP ${streamResponse.status}`);
}
const payload = await streamResponse.json();
const streams = Array.isArray(payload.streams) ? payload.streams : [];
const newshosting = streams.filter((stream) =>
  JSON.stringify({
    name: stream.name,
    title: stream.title,
    description: stream.description,
    addon: stream.addon,
  })
    .toLowerCase()
    .includes('newshosting')
);
const playable = newshosting.filter(
  (stream) => typeof stream.url === 'string' && /^https:\/\//.test(stream.url)
);
if (playable.length === 0) {
  throw new Error(
    `No playable Newshosting stream survived the final list (${newshosting.length} matching entries)`
  );
}

async function probe(stream, label, start, end) {
  const response = await fetch(stream.url, {
    headers: {
      range: `bytes=${start}-${end}`,
      'user-agent': 'AIOStreams-Newshosting-Smoke/1.0',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(90_000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (response.status !== 206 || bytes.length === 0) {
    throw new Error(`${label}: HTTP ${response.status}, ${bytes.length} bytes`);
  }
  return {
    label,
    status: response.status,
    bytes: bytes.length,
    contentType: response.headers.get('content-type'),
    contentRange: response.headers.get('content-range'),
  };
}

const attempts = [];
let successful;
for (let index = 0; index < playable.length; index += 1) {
  const stream = playable[index];
  try {
    const prefix = await probe(stream, 'prefix', 0, 65_535);
    const sizeHint = Number(stream.behaviorHints?.videoSize ?? 0);
    const totalFromRange = Number(
      prefix.contentRange?.match(/\/(\d+)$/)?.[1] ?? 0
    );
    const totalSize = sizeHint || totalFromRange;
    if (!Number.isFinite(totalSize) || totalSize < 262_144) {
      throw new Error('missing usable total size');
    }
    const midpoint = Math.floor(totalSize / 2);
    const middle = await probe(stream, 'middle', midpoint, midpoint + 65_535);
    successful = { candidate: index + 1, reportedSize: totalSize, prefix, middle };
    break;
  } catch (error) {
    attempts.push({
      candidate: index + 1,
      result: error instanceof Error ? error.message : String(error),
    });
  }
}
if (!successful) {
  throw new Error(`No seekable candidate: ${JSON.stringify(attempts)}`);
}

console.log(
  JSON.stringify({
    lookupStatus: streamResponse.status,
    lookupMs: Date.now() - startedAt,
    totalStreams: streams.length,
    newshostingEntries: newshosting.length,
    playableEntries: playable.length,
    attempts,
    successful,
  })
);
