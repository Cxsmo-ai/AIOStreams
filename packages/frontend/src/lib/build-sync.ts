const UNKNOWN_COMMITS = new Set(['', 'unknown', 'development']);

export const BUILD_SYNC_STORAGE_KEY = 'aiostreams-build-sync-reloaded';

export function normaliseBuildCommit(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().slice(0, 8);
}

export function shouldReloadForBuildMismatch(
  frontendCommit: unknown,
  serverCommit: unknown,
  previouslyReloadedServerCommit?: unknown
): boolean {
  const frontend = normaliseBuildCommit(frontendCommit);
  const server = normaliseBuildCommit(serverCommit);
  const previous = normaliseBuildCommit(previouslyReloadedServerCommit);

  if (UNKNOWN_COMMITS.has(frontend) || UNKNOWN_COMMITS.has(server)) {
    return false;
  }

  return frontend !== server && previous !== server;
}
