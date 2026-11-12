const MAX_LINE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

export async function collectProgressiveResult(
  response,
  { startedAt = performance.now(), classifySnapshot = () => ({}) } = {}
) {
  if (!response?.ok)
    throw new Error(`progressive-http-${response?.status || 0}`);
  if (!response.body) throw new Error('progressive-body-missing');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let totalBytes = 0;
  let terminal = false;
  let payload;
  let snapshotCount = 0;
  let firstSnapshotElapsedMs = null;
  let firstNonEmptySnapshotElapsedMs = null;
  let firstDeepbridSnapshotElapsedMs = null;
  let firstFinderSnapshotElapsedMs = null;
  let lastDeepbridSnapshotElapsedMs = null;
  let lastFinderSnapshotElapsedMs = null;
  let maximumDeepbridSnapshotCount = 0;
  let maximumFinderSnapshotCount = 0;
  let helloSeen = false;

  const processLine = (line) => {
    if (!line.trim()) return;
    if (terminal) throw new Error('progressive-event-after-terminal');
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error('progressive-invalid-json');
    }
    if (!event || typeof event !== 'object' || Array.isArray(event))
      throw new Error('progressive-invalid-event');
    if (event.event === 'hello') {
      if (helloSeen || event.version !== 1)
        throw new Error('progressive-invalid-hello');
      helloSeen = true;
      return;
    }
    if (event.event === 'snapshot') {
      if (!Array.isArray(event.streams))
        throw new Error('progressive-invalid-snapshot');
      const elapsed = Math.max(0, Math.round(performance.now() - startedAt));
      const stats = classifySnapshot(event) || {};
      snapshotCount++;
      firstSnapshotElapsedMs ??= elapsed;
      if (event.streams.length) firstNonEmptySnapshotElapsedMs ??= elapsed;
      if (stats.deepbrid) firstDeepbridSnapshotElapsedMs ??= elapsed;
      if (stats.finder) firstFinderSnapshotElapsedMs ??= elapsed;
      if (stats.deepbrid) lastDeepbridSnapshotElapsedMs = elapsed;
      if (stats.finder) lastFinderSnapshotElapsedMs = elapsed;
      maximumDeepbridSnapshotCount = Math.max(
        maximumDeepbridSnapshotCount,
        Number(stats.deepbridCount) || 0
      );
      maximumFinderSnapshotCount = Math.max(
        maximumFinderSnapshotCount,
        Number(stats.finderCount) || 0
      );
      payload = { ...event, streams: event.streams };
      return;
    }
    if (event.event === 'complete') {
      if (!Array.isArray(event.streams))
        throw new Error('progressive-invalid-complete');
      payload = event;
      terminal = true;
      return;
    }
    if (event.event === 'error') throw new Error('progressive-stream-error');
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES)
        throw new Error('progressive-size-limit');
      buffer += decoder.decode(value, { stream: true });
      if (
        Buffer.byteLength(buffer, 'utf8') > MAX_LINE_BYTES &&
        !buffer.includes('\n')
      )
        throw new Error('progressive-line-limit');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES)
          throw new Error('progressive-line-limit');
        buffer = buffer.slice(newline + 1);
        processLine(line);
      }
    }
    buffer += decoder.decode();
    if (Buffer.byteLength(buffer, 'utf8') > MAX_LINE_BYTES) {
      throw new Error('progressive-line-limit');
    }
    if (buffer.trim()) processLine(buffer.replace(/\r$/, ''));
    if (!terminal || !payload) throw new Error('progressive-incomplete');
    return {
      payload,
      snapshotCount,
      firstSnapshotElapsedMs,
      firstNonEmptySnapshotElapsedMs,
      firstDeepbridSnapshotElapsedMs,
      firstFinderSnapshotElapsedMs,
      lastDeepbridSnapshotElapsedMs,
      lastFinderSnapshotElapsedMs,
      maximumDeepbridSnapshotCount,
      maximumFinderSnapshotCount,
    };
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof Error && error.message.startsWith('progressive-')) {
      throw error;
    }
    throw new Error('progressive-read-failed');
  } finally {
    reader.releaseLock();
  }
}
