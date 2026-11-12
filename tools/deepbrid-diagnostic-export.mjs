import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const KNOWN_EVENTS = new Map([
  ['Deepbrid Finder content resolution accounting', 'complete'],
  ['Deepbrid Finder content resolution incomplete', 'incomplete'],
]);
const MAX_LINE_BYTES = 1_048_576;
const MAX_INPUT_BYTES = 52_428_800;
const MAX_EVENTS = 10_000;

const numeric = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(value, Number.MAX_SAFE_INTEGER)
    : undefined;

function pickNumbers(source, fields) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  return Object.fromEntries(
    fields.flatMap((field) => {
      const value = numeric(source[field]);
      return value === undefined ? [] : [[field, value]];
    })
  );
}

function pickNumericRecord(source, fields) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  return Object.fromEntries(
    fields.flatMap((field) => {
      const value = numeric(source[field]);
      return value === undefined ? [] : [[field, value]];
    })
  );
}

function safeTimings(source) {
  return {
    ...pickNumbers(source, ['samples', 'p50Ms', 'p95Ms', 'maxMs']),
  };
}

function projectApiMetrics(api) {
  if (!api || typeof api !== 'object' || Array.isArray(api)) return undefined;
  const output = {
    ...pickNumbers(api, [
      'attempts',
      'currentFinderRequestsInRollingMinute',
      'maxFinderRequestsInRollingMinute',
    ]),
    attemptsByKind: pickNumericRecord(api.attemptsByKind, [
      'search',
      'content',
      'other',
    ]),
    responses: pickNumericRecord(api.responses, [
      'success',
      'rateLimited',
      'clientError',
      'serverError',
      'other',
      'transportFailure',
    ]),
    transportFailureClasses: pickNumericRecord(api.transportFailureClasses, [
      'aborted',
      'timeout',
      'connection',
      'other',
    ]),
    queueWait: safeTimings(api.queueWait),
    responseHeaders: safeTimings(api.responseHeaders),
    searchCache: {
      ...pickNumbers(api.searchCache, [
        'freshHits',
        'staleRateLimitFallbacks',
        'coldFetches',
        'coldFetchFailures',
      ]),
      freshLookup: safeTimings(api.searchCache?.freshLookup),
      coldFetch: safeTimings(api.searchCache?.coldFetch),
    },
    rateLimit: pickNumbers(api.rateLimit, [
      'observations',
      'latestLimit',
      'minimumRemaining',
    ]),
  };
  const gate = api.sharedAccountGate;
  if (gate && typeof gate === 'object' && !Array.isArray(gate)) {
    output.sharedAccountGate = {
      ...pickNumbers(gate, [
        'currentRequestsInRollingMinute',
        'maxRequestsInRollingMinute',
        'requestStartLimitPerMinute',
        'observedProviderLimit',
        'cooldownRemainingMs',
      ]),
      queueWait: safeTimings(gate.queueWait),
    };
  }
  return output;
}

/** Projects only known, numeric diagnostics from AIOStreams structured logs. */
export function exportRedactedDeepbridDiagnostics(
  lines,
  generatedAt = new Date()
) {
  const events = [];
  let malformedLines = 0;
  let oversizedLines = 0;
  let ignoredLines = 0;

  for (const line of lines) {
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      oversizedLines++;
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      malformedLines++;
      continue;
    }
    const status = KNOWN_EVENTS.get(record?.msg);
    if (!status || events.length >= MAX_EVENTS) {
      ignoredLines++;
      continue;
    }
    const timestamp = numeric(record.time);
    const resolutionFailureClasses = pickNumericRecord(
      record.resolutionFailureClasses,
      ['abort', 'timeout', 'connection', 'api', 'other']
    );
    const apiFailureKinds = pickNumericRecord(record.apiFailureKinds, [
      'api_12',
      'api_response',
      'http_error',
      'retry_exhausted',
      'cloudflare_response',
      'invalid_json',
      'unsafe_download_url',
      'request_gate_capacity',
      'other',
    ]);
    const projectedApi = projectApiMetrics(record.api);
    const event = {
      status,
      ...(timestamp === undefined ? {} : { timestamp }),
      resolution: {
        ...pickNumbers(record, [
          'candidates',
          'attempted',
          'contentRequests',
          'resolutionFailures',
          'api12Skips',
          'otherApiFailures',
          'passwordProtected',
          'episodeMatchedFiles',
          'returnedFiles',
          'unattempted',
          'deadlineSkipped',
        ]),
        stopReason: [
          'complete',
          'deadline',
          'aborted',
          'max-results',
          'failed',
        ].includes(record.stopReason)
          ? record.stopReason
          : 'unknown',
        deadlineReached: record.deadlineReached === true,
        aborted: record.aborted === true,
        resolutionFailureClasses,
        apiFailureKinds,
      },
      ...(projectedApi ? { api: projectedApi } : {}),
    };
    events.push(event);
  }

  return {
    schema: 'aiostreams.deepbrid-diagnostics.v1',
    generatedAt: generatedAt.toISOString(),
    privacy: {
      containsProfileCredentials: false,
      containsProviderUrls: false,
      containsFilenames: false,
      containsRawErrors: false,
    },
    input: {
      acceptedEvents: events.length,
      malformedLines,
      oversizedLines,
      ignoredLines,
      maxEventsReached: events.length === MAX_EVENTS,
    },
    events,
  };
}

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(
      'Usage: node tools/deepbrid-diagnostic-export.mjs < server.jsonl > deepbrid-diagnostics-redacted.json\n' +
        'Reads structured logs from stdin and emits only allowlisted numeric Deepbrid diagnostics.\n'
    );
    return;
  }
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = [];
  let inputBytes = 0;
  for await (const line of input) {
    inputBytes += Buffer.byteLength(line, 'utf8') + 1;
    if (inputBytes > MAX_INPUT_BYTES) {
      throw new Error('Input limit exceeded');
    }
    lines.push(line);
  }
  const report = exportRedactedDeepbridDiagnostics(lines);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    process.stderr.write(
      'Could not create the redacted Deepbrid diagnostic export.\n'
    );
    process.exitCode = 1;
  });
}
