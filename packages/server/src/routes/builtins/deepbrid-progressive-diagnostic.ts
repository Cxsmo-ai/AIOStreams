const SAFE_DEEPBRID_CODES = new Set([
  'cloudflare-response',
  'invalid-json',
  'http-error',
  'retry-exhausted',
  'unsafe-download-url',
]);

const SAFE_ERROR_NAMES = new Set([
  'AbortError',
  'AggregateError',
  'AssertionError',
  'ConnectTimeoutError',
  'DeepbridApiError',
  'DOMException',
  'Error',
  'FetchError',
  'HeadersTimeoutError',
  'ProgressiveClientDisconnectedError',
  'RateLimitedError',
  'RangeError',
  'ResponseStatusCodeError',
  'SocketError',
  'SyntaxError',
  'SystemError',
  'TimeoutError',
  'TypeError',
  'URIError',
]);

const SAFE_TRANSPORT_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'ERR_ABORTED',
  'ERR_HTTP2_STREAM_CANCEL',
  'ERR_SOCKET_CLOSED',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_PREMATURE_CLOSE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function safeErrorName(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return SAFE_ERROR_NAMES.has(error.name)
    ? error.name
    : error.name === 'DeepbridApiError'
      ? error.name
      : 'Error';
}

function safeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string') return undefined;
  if (/^api_\d{1,4}$/.test(code) || SAFE_DEEPBRID_CODES.has(code)) return code;
  return SAFE_TRANSPORT_CODES.has(code) ? code : undefined;
}

/** Return only fixed, non-secret fields suitable for server-side diagnostics. */
export function getDeepbridProgressiveDiagnostic(error: unknown): {
  kind: 'deepbrid-api' | 'aborted' | 'network-or-type' | 'rate-limited' | 'unexpected';
  errorName?: string;
  code?: string;
  causeName?: string;
  causeCode?: string;
  status?: number;
  retryAfterMs?: number;
  retryAfterSeconds?: number;
} {
  const cause = error instanceof Error ? error.cause : undefined;
  const errorName = safeErrorName(error);
  const code = safeErrorCode(error);
  const causeName = safeErrorName(cause);
  const causeCode = safeErrorCode(cause);

  if (error instanceof Error && error.name === 'DeepbridApiError') {
    const apiError = error as Error & {
      status?: unknown;
      code?: unknown;
      retryAfterMs?: unknown;
    };
    const diagnostic: ReturnType<typeof getDeepbridProgressiveDiagnostic> = {
      kind: 'deepbrid-api',
    };
    if (errorName) diagnostic.errorName = errorName;
    if (code) diagnostic.code = code;
    if (causeName) diagnostic.causeName = causeName;
    if (causeCode) diagnostic.causeCode = causeCode;
    if (
      Number.isInteger(apiError.status) &&
      (apiError.status as number) >= 400 &&
      (apiError.status as number) <= 599
    ) {
      diagnostic.status = apiError.status as number;
    }
    if (
      typeof apiError.code === 'string' &&
      (/^api_\d{1,4}$/.test(apiError.code) || SAFE_DEEPBRID_CODES.has(apiError.code))
    ) {
      diagnostic.code = apiError.code;
    }
    if (
      Number.isFinite(apiError.retryAfterMs) &&
      (apiError.retryAfterMs as number) >= 0 &&
      (apiError.retryAfterMs as number) <= 300_000
    ) {
      diagnostic.retryAfterMs = apiError.retryAfterMs as number;
    }
    return diagnostic;
  }

  if (error instanceof DOMException && error.name === 'AbortError') {
    return {
      kind: 'aborted',
      ...(errorName ? { errorName } : {}),
      ...(code ? { code } : {}),
      ...(causeName ? { causeName } : {}),
      ...(causeCode ? { causeCode } : {}),
    };
  }
  if (error instanceof TypeError) {
    return {
      kind: 'network-or-type',
      ...(errorName ? { errorName } : {}),
      ...(code ? { code } : {}),
      ...(causeName ? { causeName } : {}),
      ...(causeCode ? { causeCode } : {}),
    };
  }
  if (error instanceof Error && error.name === 'RateLimitedError') {
    const retryAfterSeconds = (error as Error & { retryAfterSeconds?: unknown })
      .retryAfterSeconds;
    return {
      kind: 'rate-limited',
      ...(errorName ? { errorName } : {}),
      ...(Number.isFinite(retryAfterSeconds) &&
      (retryAfterSeconds as number) >= 0 &&
      (retryAfterSeconds as number) <= 300
        ? { retryAfterSeconds: retryAfterSeconds as number }
        : {}),
    };
  }
  return {
    kind: 'unexpected',
    ...(errorName ? { errorName } : {}),
    ...(code ? { code } : {}),
    ...(causeName ? { causeName } : {}),
    ...(causeCode ? { causeCode } : {}),
  };
}
