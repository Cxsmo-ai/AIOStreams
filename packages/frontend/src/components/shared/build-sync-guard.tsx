import React from 'react';
import { useStatus } from '@/context/status';
import {
  BUILD_SYNC_STORAGE_KEY,
  normaliseBuildCommit,
  shouldReloadForBuildMismatch,
} from '@/lib/build-sync';

let reloadRequested = false;

/**
 * Reloads a stale, long-lived frontend tab once when the server has moved to a
 * different build. This prevents an old client-side schema from trying to save
 * configuration fields introduced by the newer server/UI metadata.
 */
export function BuildSyncGuard() {
  const { status } = useStatus();

  React.useEffect(() => {
    if (reloadRequested || !status?.commit) return;

    const serverCommit = normaliseBuildCommit(status.commit);
    let previous = '';
    try {
      previous = sessionStorage.getItem(BUILD_SYNC_STORAGE_KEY) ?? '';
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }

    if (
      shouldReloadForBuildMismatch(
        __AIOSTREAMS_BUILD_COMMIT__,
        serverCommit,
        previous
      )
    ) {
      reloadRequested = true;
      try {
        sessionStorage.setItem(BUILD_SYNC_STORAGE_KEY, serverCommit);
      } catch {
        // The module-level guard still prevents a StrictMode reload loop.
      }
      window.location.reload();
      return;
    }

    if (
      normaliseBuildCommit(__AIOSTREAMS_BUILD_COMMIT__) === serverCommit &&
      previous
    ) {
      try {
        sessionStorage.removeItem(BUILD_SYNC_STORAGE_KEY);
      } catch {
        // Nothing else is required if storage is unavailable.
      }
    }
  }, [status?.commit]);

  return null;
}
