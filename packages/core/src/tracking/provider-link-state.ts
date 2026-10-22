import type { DbDriver } from '../db/driver/types.js';

export type TrackerProviderLinkRefs = Record<
  string,
  { authRef?: string } | undefined
>;

export interface TrackerProviderLinkState {
  authRef: string | null;
  generation: number;
}

/** Providers whose credentials changed need a fresh provider-side sync baseline. */
export function changedTrackerProviderLinks(
  previous: TrackerProviderLinkRefs | undefined,
  next: TrackerProviderLinkRefs | undefined
): string[] {
  const before = previous ?? {};
  const after = next ?? {};
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((providerId) => {
      const oldRef = before[providerId]?.authRef;
      const newRef = after[providerId]?.authRef;
      return (
        oldRef !== newRef && (oldRef !== undefined || newRef !== undefined)
      );
    })
    .filter((providerId) => /^[a-z0-9_-]{1,40}$/i.test(providerId));
}

/**
 * Discard only provider-specific sync state after a relink. The canonical
 * tracker ledger is intentionally retained, but old-account retries,
 * snapshots, facets, and checkpoints must never be replayed as the new account.
 */
export async function clearTrackerProviderLinkState(
  tx: DbDriver,
  userUuid: string,
  providerId: string
): Promise<void> {
  if (!/^[a-z0-9_-]{1,40}$/i.test(providerId))
    throw new Error('Invalid tracker provider id');

  for (const table of [
    'tracker_provider_outbox',
    'tracker_scrobble_outbox',
    'tracker_provider_records',
    'tracker_provider_facets',
    'tracker_provider_sync_state',
  ]) {
    await tx.exec(
      `DELETE FROM ${table} WHERE user_uuid = ? AND provider_id = ?`,
      [userUuid, providerId]
    );
  }
}

/** Persist an authRef generation atomically with the config that owns it. */
export async function saveTrackerProviderLinkState(
  tx: DbDriver,
  userUuid: string,
  providerId: string,
  authRef: string | null,
  changed: boolean,
  now = Date.now()
): Promise<void> {
  if (!/^[a-z0-9_-]{1,40}$/i.test(providerId))
    throw new Error('Invalid tracker provider id');

  if (changed) {
    await tx.exec(
      'INSERT INTO tracker_provider_link_state (user_uuid, provider_id, auth_ref, generation, updated_at_ms) VALUES (?, ?, ?, 1, ?) ON CONFLICT(user_uuid, provider_id) DO UPDATE SET auth_ref = excluded.auth_ref, generation = tracker_provider_link_state.generation + 1, updated_at_ms = excluded.updated_at_ms',
      [userUuid, providerId, authRef, now]
    );
    return;
  }

  // Older installations have no row yet; seed it without overwriting a
  // concurrently written generation or credential reference.
  await tx.exec(
    'INSERT INTO tracker_provider_link_state (user_uuid, provider_id, auth_ref, generation, updated_at_ms) VALUES (?, ?, ?, 1, ?) ON CONFLICT(user_uuid, provider_id) DO NOTHING',
    [userUuid, providerId, authRef, now]
  );
}

/** Read the persisted link state. Missing rows are not authorized implicitly. */
export async function getTrackerProviderLinkState(
  db: DbDriver,
  userUuid: string,
  providerId: string,
  lockForUpdate = false
): Promise<TrackerProviderLinkState | null> {
  if (!/^[a-z0-9_-]{1,40}$/i.test(providerId)) return null;
  const lockClause =
    lockForUpdate && db.dialect === 'postgres' ? ' FOR UPDATE' : '';
  const row = await db.maybeOne<{
    auth_ref: string | null;
    generation: number | string;
  }>(
    `SELECT auth_ref, generation FROM tracker_provider_link_state WHERE user_uuid = ? AND provider_id = ?${lockClause}`,
    [userUuid, providerId]
  );
  if (!row) return null;
  const generation = Number(row.generation);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('Invalid tracker provider link generation');
  }
  return { authRef: row.auth_ref, generation };
}

/** Seed legacy state only from an authenticated, saved config's own links. */
export async function initializeTrackerProviderLinkStates(
  tx: DbDriver,
  userUuid: string,
  links: TrackerProviderLinkRefs,
  now = Date.now()
): Promise<void> {
  for (const [providerId, link] of Object.entries(links)) {
    if (!link?.authRef) continue;
    await saveTrackerProviderLinkState(
      tx,
      userUuid,
      providerId,
      link.authRef,
      false,
      now
    );
  }
}

/**
 * Check the active persisted link immediately before provider dispatch. This
 * prevents a worker that loaded an old queue row from sending it with a new
 * account after a relink transaction has committed.
 */
export async function isCurrentTrackerProviderLink(
  db: DbDriver,
  userUuid: string,
  providerId: string,
  authRef: string,
  expectedGeneration: number,
  lockForUpdate = false
): Promise<boolean> {
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1)
    return false;
  const state = await getTrackerProviderLinkState(
    db,
    userUuid,
    providerId,
    lockForUpdate
  );
  return state?.authRef === authRef && state.generation === expectedGeneration;
}
