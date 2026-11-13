export type DeepbridInsightFailureReason =
  | 'authentication'
  | 'rate-limited'
  | 'premium-required'
  | 'premium-required-or-forbidden'
  | 'provider-unavailable';

export type DeepbridInsightOutcome<T> =
  | { status: 'available'; data: T }
  | { status: 'unavailable'; reason: DeepbridInsightFailureReason };

/** Project provider failures to a fixed safe status; never forward error text. */
export function projectDeepbridInsightOutcome<T>(
  result: PromiseSettledResult<T>
): DeepbridInsightOutcome<T> {
  if (result.status === 'fulfilled') {
    return { status: 'available', data: result.value };
  }
  const status =
    result.reason && typeof result.reason === 'object'
      ? (result.reason as Record<string, unknown>).status
      : undefined;
  const reason: DeepbridInsightFailureReason =
    status === 401
      ? 'authentication'
      : status === 429
        ? 'rate-limited'
        : status === 403
          ? 'premium-required-or-forbidden'
          : 'provider-unavailable';
  return { status: 'unavailable', reason };
}

type DeepbridInsightsClient = {
  getUser(options: { timeoutMs: number; deadlineAtMs: number }): Promise<{
    premium?: boolean;
    expiration?: string;
    maxDownloads?: number;
    maxConnections?: number;
    fidelityPoints?: number;
  }>;
  getUserStats(options: {
    timeoutMs: number;
    deadlineAtMs: number;
  }): Promise<unknown>;
  getApiKeyInfo(options: {
    timeoutMs: number;
    deadlineAtMs: number;
  }): Promise<unknown>;
  getApiKeyDevices(
    options: { timeoutMs: number; deadlineAtMs: number },
    limit: number
  ): Promise<unknown>;
  getHosts(options: {
    timeoutMs: number;
    deadlineAtMs: number;
  }): Promise<unknown>;
  getOfficialApps(options: {
    timeoutMs: number;
    deadlineAtMs: number;
  }): Promise<unknown>;
  getUserLimits(options: {
    timeoutMs: number;
    deadlineAtMs: number;
  }): Promise<unknown>;
};

/**
 * Load only the aggregate facts the dashboard needs. The provider's limits
 * route is Premium-only, so a clearly free plan must not spend a request on it.
 */
export async function loadDeepbridInsights(
  client: DeepbridInsightsClient,
  now = Date.now()
) {
  const deadlineAtMs = now + 20_000;
  const options = { timeoutMs: 8_000, deadlineAtMs };
  const [
    accountResult,
    statsResult,
    keyInfoResult,
    devicesResult,
    hostsResult,
    officialAppsResult,
  ] = await Promise.allSettled([
    client.getUser(options),
    client.getUserStats(options),
    client.getApiKeyInfo(options),
    client.getApiKeyDevices(options, 50),
    client.getHosts(options),
    client.getOfficialApps(options),
  ]);

  const plan =
    accountResult.status === 'fulfilled' &&
    typeof accountResult.value.premium === 'boolean'
      ? accountResult.value.premium
        ? 'premium'
        : 'free'
      : 'unknown';

  const accountDetails =
    accountResult.status === 'fulfilled'
      ? {
          status: 'available' as const,
          data: {
            ...(accountResult.value.expiration
              ? { expiration: accountResult.value.expiration }
              : {}),
            ...(accountResult.value.maxDownloads !== undefined
              ? { maxDownloads: accountResult.value.maxDownloads }
              : {}),
            ...(accountResult.value.maxConnections !== undefined
              ? { maxConnections: accountResult.value.maxConnections }
              : {}),
            ...(accountResult.value.fidelityPoints !== undefined
              ? { fidelityPoints: accountResult.value.fidelityPoints }
              : {}),
          },
        }
      : projectDeepbridInsightOutcome(accountResult);

  let limits;
  if (plan === 'free') {
    limits = { status: 'unavailable', reason: 'premium-required' } as const;
  } else {
    const [limitsResult] = await Promise.allSettled([
      client.getUserLimits(options),
    ]);
    limits = projectDeepbridInsightOutcome(limitsResult!);
  }

  return {
    plan,
    accountDetails,
    stats: projectDeepbridInsightOutcome(statsResult),
    apiKeyActivity: projectDeepbridInsightOutcome(keyInfoResult),
    apiKeyDevices: projectDeepbridInsightOutcome(devicesResult),
    hostStatus: projectDeepbridInsightOutcome(hostsResult),
    officialApps: projectDeepbridInsightOutcome(officialAppsResult),
    limits,
  };
}
