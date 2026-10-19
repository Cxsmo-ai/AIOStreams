import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import express from 'express';
import type {
  DbDriver,
  ExecResult,
  Row,
  TrackerRecord,
} from '@aiostreams/core';
import { encryptString, WeTrakrRateLimitError } from '@aiostreams/core';
import { errorMiddleware } from '../../middlewares/errors.js';
import { createTrackerRouter } from './tracking.js';
import {
  weTrakrTrackerAdapter,
  type TrackerProviderAdapter,
} from './tracker-providers.js';

type StoredRecord = {
  record_id: string;
  record_json: string;
  updated_at_ms: number;
};

type StoredOutboxRecord = StoredRecord & {
  provider_id: string;
  attempt_count: number;
  next_attempt_at_ms: number;
  lease_token: string | null;
  lease_until_ms: number;
  last_error_code?: string | null;
};

type StoredScrobbleOutbox = {
  event_id: string;
  provider_id: string;
  event_json: string;
  delivery_status: 'pending' | 'delivered';
  created_at_ms: number;
  attempt_count: number;
  next_attempt_at_ms: number;
  lease_token: string | null;
  lease_until_ms: number;
  last_error_code?: string | null;
};

/** Small SQL-aware fake keeps route tests isolated from process-global DB state. */
class MemoryTrackerDb {
  private readonly users = new Map<string, Map<string, StoredRecord>>();
  private readonly syncStates = new Map<string, number>();
  private readonly providerFacets = new Map<
    string,
    {
      facet_id: string;
      completed_at_ms: number;
      attempt_count: number;
      next_attempt_at_ms: number;
      last_failure_reason: string | null;
      endpoint: string | null;
    }
  >();
  private readonly providerRecords = new Map<
    string,
    Map<string, StoredRecord>
  >();
  private readonly outbox = new Map<string, StoredOutboxRecord>();
  private readonly scrobbleOutbox = new Map<string, StoredScrobbleOutbox>();

  inspectOutbox() {
    return [...this.outbox.values()].map((row) => ({ ...row }));
  }

  private rows(uuid: string) {
    let rows = this.users.get(uuid);
    if (!rows) this.users.set(uuid, (rows = new Map()));
    return rows;
  }

  private providerRows(uuid: string, providerId: string) {
    const key = `${uuid}:${providerId}`;
    let rows = this.providerRecords.get(key);
    if (!rows) this.providerRecords.set(key, (rows = new Map()));
    return rows;
  }

  async query<T extends Row = Row>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<T[]> {
    if (sql.includes('FROM tracker_scrobble_outbox')) {
      if (!sql.includes('lease_until_ms <=')) {
        const [uuid, providerId] = params;
        const pending = [...this.scrobbleOutbox.entries()].some(
          ([key, row]) =>
            key.startsWith(`${uuid}\u0000${providerId}\u0000`) &&
            row.delivery_status === 'pending'
        );
        return (pending ? [{ event_id: 'pending' }] : []) as unknown as T[];
      }
      const [uuid, providerId, dueAt] = params;
      const effectiveLimit = Number(params.at(-1) ?? 1);
      const leaseDeadline = sql.includes('next_attempt_at_ms <=')
        ? params[3]
        : dueAt;
      let rows = [...this.scrobbleOutbox.entries()]
        .filter(([key]) => key.startsWith(`${uuid}\u0000${providerId}\u0000`))
        .map(([, row]) => row)
        .filter((row) => row.delivery_status === 'pending');
      if (sql.includes('next_attempt_at_ms <='))
        rows = rows.filter((row) => row.next_attempt_at_ms <= Number(dueAt));
      if (sql.includes('lease_until_ms <='))
        rows = rows.filter(
          (row) => row.lease_until_ms <= Number(leaseDeadline)
        );
      rows.sort(
        (a, b) =>
          a.created_at_ms - b.created_at_ms ||
          a.event_id.localeCompare(b.event_id)
      );
      return rows
        .slice(0, effectiveLimit)
        .map((row) => ({ ...row }) as unknown as T);
    }
    if (sql.includes('FROM tracker_provider_outbox')) {
      const [uuid, providerId, dueAt] = params;
      const effectiveLimit = params.at(-1) ?? 1;
      const leaseDeadline = sql.includes('next_attempt_at_ms <=')
        ? params[3]
        : dueAt;
      let rows = [...this.outbox.entries()]
        .filter(([key]) => key.startsWith(`${uuid}\u0000${providerId}\u0000`))
        .map(([, row]) => row);
      if (sql.includes('next_attempt_at_ms <='))
        rows = rows.filter((row) => row.next_attempt_at_ms <= Number(dueAt));
      if (sql.includes('lease_until_ms <='))
        rows = rows.filter(
          (row) => row.lease_until_ms <= Number(leaseDeadline)
        );
      rows.sort(
        (a, b) =>
          a.updated_at_ms - b.updated_at_ms ||
          a.record_id.localeCompare(b.record_id)
      );
      return rows
        .slice(
          0,
          Number.isFinite(Number(effectiveLimit)) ? Number(effectiveLimit) : 1
        )
        .map((row) => ({ ...row }) as unknown as T);
    }
    if (sql.includes('FROM tracker_provider_records')) {
      const [uuid, providerId] = params;
      return [...this.providerRows(String(uuid), String(providerId)).values()]
        .sort((a, b) => a.record_id.localeCompare(b.record_id))
        .map((row) => ({ ...row }) as unknown as T);
    }
    if (sql.includes('FROM tracker_provider_facets')) {
      const [uuid, providerId] = params;
      const prefix = `${uuid}\u0000${providerId}\u0000`;
      return [...this.providerFacets.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, row]) => ({ ...row }) as unknown as T);
    }
    if (!sql.includes('FROM tracker_records'))
      throw new Error(`Unexpected query: ${sql}`);
    const [uuid, afterTs, sameTs, afterId, cursorLimit] = params;
    const rawLimit = params.length === 5 ? cursorLimit : params[1];
    let records = [...this.rows(String(uuid)).values()].sort(
      (a, b) =>
        a.updated_at_ms - b.updated_at_ms ||
        a.record_id.localeCompare(b.record_id)
    );
    if (params.length === 5) {
      records = records.filter(
        (row) =>
          row.updated_at_ms > Number(afterTs) ||
          (row.updated_at_ms === Number(sameTs) &&
            row.record_id > String(afterId))
      );
    }
    return records
      .slice(
        0,
        Number.isFinite(Number(rawLimit)) ? Number(rawLimit) : undefined
      )
      .map((row) => ({ ...row }) as unknown as T);
  }

  async maybeOne<T extends Row = Row>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<T | null> {
    if (sql.includes('FROM tracker_provider_sync_state')) {
      const [uuid, providerId] = params;
      const checkpoint = this.syncStates.get(`${uuid}:${providerId}`);
      return checkpoint === undefined
        ? null
        : ({ checkpoint_at_ms: checkpoint } as unknown as T);
    }
    const [uuid, id] = params;
    const row = this.rows(String(uuid)).get(String(id));
    return row
      ? ({
          record_json: row.record_json,
          updated_at_ms: row.updated_at_ms,
        } as unknown as T)
      : null;
  }

  async exec(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<ExecResult> {
    if (sql.startsWith('DELETE FROM tracker_scrobble_outbox')) {
      const [uuid, providerId, cutoff] = params;
      let deleted = 0;
      for (const [key, row] of this.scrobbleOutbox) {
        if (
          key.startsWith(`${uuid}\u0000${providerId}\u0000`) &&
          row.delivery_status === 'delivered' &&
          row.created_at_ms < Number(cutoff)
        ) {
          this.scrobbleOutbox.delete(key);
          deleted += 1;
        }
      }
      return { rowCount: deleted };
    }
    if (sql.startsWith('INSERT INTO tracker_scrobble_outbox')) {
      const [uuid, providerId, eventId, eventJson, createdAt] = params;
      const key = `${uuid}\u0000${providerId}\u0000${eventId}`;
      if (!this.scrobbleOutbox.has(key))
        this.scrobbleOutbox.set(key, {
          event_id: String(eventId),
          provider_id: String(providerId),
          event_json: String(eventJson),
          delivery_status: 'pending',
          created_at_ms: Number(createdAt),
          attempt_count: 0,
          next_attempt_at_ms: 0,
          lease_token: null,
          lease_until_ms: 0,
          last_error_code: null,
        });
      return { rowCount: 1 };
    }
    if (sql.startsWith('UPDATE tracker_scrobble_outbox')) {
      if (sql.includes('SET lease_token = ?')) {
        const [token, leaseUntil, uuid, providerId, eventId, createdAt, now] =
          params;
        const row = this.scrobbleOutbox.get(
          `${uuid}\u0000${providerId}\u0000${eventId}`
        );
        if (
          !row ||
          row.created_at_ms !== Number(createdAt) ||
          row.lease_until_ms > Number(now)
        )
          return { rowCount: 0 };
        row.lease_token = String(token);
        row.lease_until_ms = Number(leaseUntil);
        return { rowCount: 1 };
      }
      if (sql.includes("delivery_status = 'delivered'")) {
        const [uuid, providerId, eventId, createdAt, token] = params;
        const row = this.scrobbleOutbox.get(
          `${uuid}\u0000${providerId}\u0000${eventId}`
        );
        if (
          !row ||
          row.created_at_ms !== Number(createdAt) ||
          row.lease_token !== token
        )
          return { rowCount: 0 };
        row.delivery_status = 'delivered';
        row.lease_token = null;
        row.lease_until_ms = 0;
        return { rowCount: 1 };
      }
      const [
        nextAttempt,
        errorCode,
        uuid,
        providerId,
        eventId,
        createdAt,
        token,
      ] = sql.includes('last_error_code = ?')
        ? params
        : [params[0], 'provider_unavailable', ...params.slice(1)];
      const row = this.scrobbleOutbox.get(
        `${uuid}\u0000${providerId}\u0000${eventId}`
      );
      if (
        !row ||
        row.created_at_ms !== Number(createdAt) ||
        row.lease_token !== token
      )
        return { rowCount: 0 };
      row.attempt_count += 1;
      row.next_attempt_at_ms = Number(nextAttempt);
      row.lease_token = null;
      row.lease_until_ms = 0;
      row.last_error_code = String(errorCode);
      return { rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO tracker_provider_outbox')) {
      const [uuid, providerId, id, recordJson, updatedAt] = params;
      const key = `${uuid}\u0000${providerId}\u0000${id}`;
      const current = this.outbox.get(key);
      if (!current || Number(updatedAt) >= current.updated_at_ms) {
        this.outbox.set(key, {
          record_id: String(id),
          provider_id: String(providerId),
          record_json: String(recordJson),
          updated_at_ms: Number(updatedAt),
          attempt_count: 0,
          next_attempt_at_ms: 0,
          lease_token: null,
          lease_until_ms: 0,
          last_error_code: null,
        });
      }
      return { rowCount: 1 };
    }
    if (sql.startsWith('DELETE FROM tracker_provider_outbox')) {
      const [uuid, providerId, id, updatedAt, leaseToken] = params;
      const key = `${uuid}\u0000${providerId}\u0000${id}`;
      const current = this.outbox.get(key);
      if (
        !current ||
        current.updated_at_ms !== Number(updatedAt) ||
        current.lease_token !== leaseToken
      )
        return { rowCount: 0 };
      this.outbox.delete(key);
      return { rowCount: 1 };
    }
    if (sql.startsWith('UPDATE tracker_provider_outbox')) {
      if (sql.includes('SET lease_token = ?')) {
        const [leaseToken, leaseUntil, uuid, providerId, id, updatedAt, now] =
          params;
        const key = `${uuid}\u0000${providerId}\u0000${id}`;
        const current = this.outbox.get(key);
        if (
          !current ||
          current.updated_at_ms !== Number(updatedAt) ||
          current.lease_until_ms > Number(now)
        )
          return { rowCount: 0 };
        current.lease_token = String(leaseToken);
        current.lease_until_ms = Number(leaseUntil);
        return { rowCount: 1 };
      }
      const [
        nextAttemptAt,
        errorCode,
        uuid,
        providerId,
        id,
        updatedAt,
        leaseToken,
      ] = sql.includes('last_error_code = ?')
        ? params
        : [params[0], 'provider_unavailable', ...params.slice(1)];
      const key = `${uuid}\u0000${providerId}\u0000${id}`;
      const current = this.outbox.get(key);
      if (
        !current ||
        current.updated_at_ms !== Number(updatedAt) ||
        current.lease_token !== leaseToken
      )
        return { rowCount: 0 };
      current.attempt_count += 1;
      current.next_attempt_at_ms = Number(nextAttemptAt);
      current.lease_token = null;
      current.lease_until_ms = 0;
      current.last_error_code = String(errorCode);
      return { rowCount: 1 };
    }
    if (sql.startsWith('DELETE FROM tracker_provider_records')) {
      const [uuid, providerId, id] = params;
      const removed = this.providerRows(
        String(uuid),
        String(providerId)
      ).delete(String(id));
      return { rowCount: removed ? 1 : 0 };
    }
    if (sql.startsWith('INSERT INTO tracker_provider_records')) {
      const [uuid, providerId, id, recordJson, updatedAt] = params;
      this.providerRows(String(uuid), String(providerId)).set(String(id), {
        record_id: String(id),
        record_json: String(recordJson),
        updated_at_ms: Number(updatedAt),
      });
      return { rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO tracker_provider_sync_state')) {
      const [uuid, providerId, checkpointAt] = params;
      const key = `${uuid}:${providerId}`;
      this.syncStates.set(key, Number(checkpointAt));
      return { rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO tracker_provider_facets')) {
      const [uuid, providerId, facetId, completedAt] = params;
      const key = `${uuid}\u0000${providerId}\u0000${facetId}`;
      const current = this.providerFacets.get(key);
      if (sql.includes('attempt_count')) {
        if (Number(completedAt) > 0) {
          this.providerFacets.set(key, {
            facet_id: String(facetId),
            completed_at_ms: Number(completedAt),
            attempt_count: 0,
            next_attempt_at_ms: 0,
            last_failure_reason: null,
            endpoint: null,
          });
        } else {
          const [, , , attemptCount, nextAttemptAt, reason, endpoint] = params;
          this.providerFacets.set(key, {
            facet_id: String(facetId),
            completed_at_ms: current?.completed_at_ms ?? 0,
            attempt_count: Number(attemptCount),
            next_attempt_at_ms: Number(nextAttemptAt),
            last_failure_reason: String(reason),
            endpoint: String(endpoint),
          });
        }
      } else {
        this.providerFacets.set(key, {
          facet_id: String(facetId),
          completed_at_ms: Number(completedAt),
          attempt_count: 0,
          next_attempt_at_ms: 0,
          last_failure_reason: null,
          endpoint: null,
        });
      }
      return { rowCount: 1 };
    }
    if (sql.startsWith('UPDATE tracker_provider_sync_state')) {
      const [checkpointAt, _updatedAt, uuid, providerId, expectedCheckpoint] =
        params;
      const key = `${uuid}:${providerId}`;
      if (this.syncStates.get(key) !== Number(expectedCheckpoint))
        return { rowCount: 0 };
      this.syncStates.set(key, Number(checkpointAt));
      return { rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO tracker_records')) {
      const [uuid, id, recordJson, updatedAt] = params;
      const rows = this.rows(String(uuid));
      const current = rows.get(String(id));
      if (!current || Number(updatedAt) > current.updated_at_ms) {
        rows.set(String(id), {
          record_id: String(id),
          record_json: String(recordJson),
          updated_at_ms: Number(updatedAt),
        });
        return { rowCount: 1 };
      }
      return { rowCount: 0 };
    }
    if (sql.startsWith('UPDATE tracker_records')) {
      const [recordJson, updatedAt, uuid, id, expectedJson] = params;
      const rows = this.rows(String(uuid));
      const current = rows.get(String(id));
      if (!current || current.record_json !== expectedJson)
        return { rowCount: 0 };
      rows.set(String(id), {
        ...current,
        record_json: String(recordJson),
        updated_at_ms: Number(updatedAt),
      });
      return { rowCount: 1 };
    }
    throw new Error(`Unexpected exec: ${sql}`);
  }

  async tx<T>(fn: (tx: DbDriver) => Promise<T>): Promise<T> {
    return fn(this as unknown as DbDriver);
  }
}

const servers: import('node:http').Server[] = [];

function createTestServer(
  options: {
    trackerProviders?: Record<string, { authRef?: string; enabled?: boolean }>;
    requestProviderApi?: (
      authRef: string,
      path: string,
      init: {
        method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
        body?: unknown;
        idempotencyKey?: string;
      }
    ) => Promise<{ data: unknown }>;
    trackerAdapters?: TrackerProviderAdapter[];
  } = {}
) {
  const database = new MemoryTrackerDb();
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/tracking/v1',
    createTrackerRouter({
      authenticate: async (uuid, password) =>
        password === `pw-${uuid}`
          ? { trackerProviders: options.trackerProviders }
          : null,
      database: () => database as unknown as DbDriver,
      requestProviderApi: options.requestProviderApi,
      trackerAdapters: options.trackerAdapters,
      rateLimiter: (_req, _res, next) => next(),
    })
  );
  app.use(errorMiddleware);
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Test server did not bind a TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v1/tracking/v1`,
    database,
  };
}

function auth(uuid: string, password = `pw-${uuid}`): string {
  return `Basic ${Buffer.from(`${uuid}:${password}`).toString('base64')}`;
}

async function responseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function record(
  id: string,
  updatedAt: number,
  state: 'in_progress' | 'watched' = 'in_progress'
): TrackerRecord {
  return {
    id,
    kind: 'episode',
    ids: { imdb: 'tt1234567' },
    title: 'Sample Show',
    seriesTitle: 'Sample Show',
    episodeTitle: 'Sample Episode',
    season: 2,
    episode: 4,
    state,
    positionMs: 42_000,
    durationMs: 1_800_000,
    updatedAt,
    origin: 'nuvio',
    revision: 0,
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
});

describe('AIOStreams tracker API', () => {
  it('accepts the server-issued encrypted addon password for secure native linking', async () => {
    const { baseUrl } = createTestServer();
    const encrypted = encryptString('pw-alice');
    assert.equal(encrypted.success, true);
    const response = await fetch(`${baseUrl}/snapshot`, {
      headers: { Authorization: auth('alice', encrypted.data!) },
    });
    assert.equal(response.status, 200);
  });

  it('requires valid account credentials on every route', async () => {
    const { baseUrl } = createTestServer();
    const missing = await fetch(`${baseUrl}/snapshot`);
    assert.equal(missing.status, 401);
    const invalid = await fetch(`${baseUrl}/snapshot`, {
      headers: { Authorization: auth('alice', 'wrong') },
    });
    assert.equal(invalid.status, 401);
  });

  it('isolates each account and applies monotonic last-write-wins merges', async () => {
    const { baseUrl } = createTestServer();
    const write = (uuid: string, value: ReturnType<typeof record>) =>
      fetch(`${baseUrl}/records`, {
        method: 'POST',
        headers: {
          Authorization: auth(uuid),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ records: [value] }),
      });
    assert.equal(
      (await write('alice', record('episode:tt1234567:2:4', 100))).status,
      200
    );
    const equalTimestamp = await write(
      'alice',
      record('episode:tt1234567:2:4', 100, 'watched')
    );
    assert.equal(
      (await responseJson<{ data: { changed: number } }>(equalTimestamp)).data
        .changed,
      0
    );
    assert.equal(
      (await write('alice', record('episode:tt1234567:2:4', 101, 'watched')))
        .status,
      200
    );

    const alice = await fetch(`${baseUrl}/snapshot`, {
      headers: { Authorization: auth('alice') },
    });
    const bob = await fetch(`${baseUrl}/snapshot`, {
      headers: { Authorization: auth('bob') },
    });
    assert.equal(
      (
        await responseJson<{ data: { records: Array<{ state: string }> } }>(
          alice
        )
      ).data.records[0].state,
      'watched'
    );
    assert.deepEqual(
      (await responseJson<{ data: { records: unknown[] } }>(bob)).data.records,
      []
    );
  });

  it('paginates with a stable compound cursor, including timestamp ties', async () => {
    const { baseUrl } = createTestServer();
    const response = await fetch(`${baseUrl}/records`, {
      method: 'POST',
      headers: {
        Authorization: auth('alice'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        records: [record('a', 200), record('b', 200), record('c', 201)],
      }),
    });
    assert.equal(response.status, 200);
    const firstResponse = await fetch(`${baseUrl}/snapshot?limit=2`, {
      headers: { Authorization: auth('alice') },
    });
    const first = (
      await responseJson<{
        data: {
          records: Array<{ id: string }>;
          hasMore: boolean;
          nextCursor: string;
        };
      }>(firstResponse)
    ).data;
    assert.deepEqual(
      first.records.map((item: { id: string }) => item.id),
      ['a', 'b']
    );
    assert.equal(first.hasMore, true);
    const secondResponse = await fetch(
      `${baseUrl}/snapshot?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
      {
        headers: { Authorization: auth('alice') },
      }
    );
    const second = (
      await responseJson<{
        data: {
          records: Array<{ id: string }>;
          hasMore: boolean;
          nextCursor: string | null;
        };
      }>(secondResponse)
    ).data;
    assert.deepEqual(
      second.records.map((item: { id: string }) => item.id),
      ['c']
    );
    assert.equal(second.hasMore, false);
    assert.equal(second.nextCursor, null);

    const invalidCursor = await fetch(
      `${baseUrl}/snapshot?cursor=not-a-cursor`,
      {
        headers: { Authorization: auth('alice') },
      }
    );
    assert.equal(invalidCursor.status, 400);
  });

  it('round-trips every supported tracker record state and its metadata', async () => {
    const { baseUrl } = createTestServer();
    const headers = {
      Authorization: auth('alice'),
      'Content-Type': 'application/json',
    };
    const states = [
      'in_progress',
      'watched',
      'watchlist',
      'favorite',
      'rated',
      'note',
      'comment',
    ] as const;
    const records = states.map((state, index) => ({
      id: `record-${state}`,
      kind: index === 0 ? 'episode' : 'movie',
      ids: { imdb: `tt123456${index}` },
      title: `Title ${index}`,
      seriesTitle: index === 0 ? 'Sample Show' : undefined,
      episodeTitle: index === 0 ? 'Sample Episode' : undefined,
      season: index === 0 ? 2 : undefined,
      episode: index === 0 ? 4 : undefined,
      state,
      positionMs: index === 0 ? 42_000 : undefined,
      durationMs: index === 0 ? 1_800_000 : undefined,
      rating: state === 'rated' ? 8.5 : undefined,
      text:
        state === 'note' || state === 'comment' ? `${state} body` : undefined,
      listId:
        state === 'watchlist' || state === 'favorite'
          ? 'favorites-list'
          : undefined,
      updatedAt: 500 + index,
      origin: 'nuvio',
    }));
    const write = await fetch(`${baseUrl}/records`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ records }),
    });
    assert.equal(write.status, 200);
    const snapshot = await fetch(`${baseUrl}/snapshot?limit=20`, { headers });
    const body = (
      await responseJson<{ data: { records: Array<Record<string, unknown>> } }>(
        snapshot
      )
    ).data.records;
    assert.deepEqual(body.map((item) => item.state).sort(), [...states].sort());
    assert.equal(body.find((item) => item.state === 'rated')?.rating, 8.5);
    assert.equal(body.find((item) => item.state === 'note')?.text, 'note body');
    assert.equal(
      body.find((item) => item.state === 'comment')?.text,
      'comment body'
    );
    assert.equal(
      body.find((item) => item.state === 'watchlist')?.listId,
      'favorites-list'
    );
    assert.equal(body.find((item) => item.state === 'in_progress')?.season, 2);
    const episode = body.find((item) => item.state === 'in_progress');
    assert.equal(episode?.seriesTitle, 'Sample Show');
    assert.equal(episode?.episodeTitle, 'Sample Episode');
  });

  it('fans merged Nuvio records out to enabled providers but never echoes imports', async () => {
    const providerCalls: Array<{
      authRef: string;
      path: string;
      body: unknown;
      idempotencyKey?: string;
    }> = [];
    const { baseUrl } = createTestServer({
      trackerProviders: {
        wetrakr: {
          authRef: '11111111-1111-4111-8111-111111111111',
          enabled: true,
        },
      },
      requestProviderApi: async (authRef, path, init) => {
        providerCalls.push({
          authRef,
          path,
          body: init.body,
          idempotencyKey: init.idempotencyKey,
        });
        return { data: { success: true } };
      },
    });
    const headers = {
      Authorization: auth('alice'),
      'Content-Type': 'application/json',
    };
    const merged = await fetch(`${baseUrl}/records`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ records: [record('movie:tt0468569', 700)] }),
    });
    assert.equal(merged.status, 200);
    assert.equal(providerCalls.length, 1);
    assert.equal(providerCalls[0].path, '/sync/tracking');
    assert.match(providerCalls[0].idempotencyKey ?? '', /^[a-f0-9]{64}$/);
    assert.equal(
      providerCalls[0].authRef,
      '11111111-1111-4111-8111-111111111111'
    );

    const echo = await fetch(`${baseUrl}/records`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        records: [
          {
            ...record('movie:tt0468569|favorite', 701),
            origin: 'wetrakr',
            state: 'favorite',
          },
        ],
      }),
    });
    assert.equal(echo.status, 200);
    assert.equal(providerCalls.length, 1);
  });

  it('does not delete a foreign provider comment ID through WeTrakr fan-out', async () => {
    const providerCalls: Array<{ path: string; method: string }> = [];
    const { baseUrl } = createTestServer({
      trackerProviders: {
        wetrakr: {
          authRef: '11111111-1111-4111-8111-111111111111',
          enabled: true,
        },
      },
      requestProviderApi: async (_authRef, path, init) => {
        providerCalls.push({ path, method: init.method });
        return { data: { success: true } };
      },
    });
    const headers = {
      Authorization: auth('alice'),
      'Content-Type': 'application/json',
    };
    const foreignCommentTombstone: TrackerRecord = {
      id: 'movie:imdb:tt0468569|comment:80055',
      kind: 'movie',
      ids: { imdb: 'tt0468569' },
      state: 'deleted',
      deletedState: 'comment',
      providerId: '80055',
      providerIdProvider: 'another-tracker',
      revision: 1,
      updatedAt: Date.now(),
      origin: 'nuvio',
    };

    const merged = await fetch(`${baseUrl}/records`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ records: [foreignCommentTombstone] }),
    });

    assert.equal(merged.status, 200);
    assert.deepEqual(providerCalls, []);
  });

  it('never fans out stale conflicts, but retries an exact canonical row after provider failure', async () => {
    const providerCalls: Array<{ path: string; body: unknown }> = [];
    let failFirst = true;
    const { baseUrl } = createTestServer({
      trackerProviders: {
        wetrakr: {
          authRef: '11111111-1111-4111-8111-111111111111',
          enabled: true,
        },
      },
      requestProviderApi: async (_authRef, path, init) => {
        providerCalls.push({ path, body: init.body });
        if (failFirst) {
          failFirst = false;
          throw new Error('temporary provider outage');
        }
        return { data: { success: true } };
      },
    });
    const headers = {
      Authorization: auth('alice'),
      'Content-Type': 'application/json',
    };
    const canonical = record('episode:imdb:tt1234567:s2:e4', 900, 'watched');

    const first = await fetch(`${baseUrl}/records`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ records: [canonical] }),
    });
    assert.equal(first.status, 503);

    const stale = await fetch(`${baseUrl}/records`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        records: [{ ...canonical, updatedAt: 800, state: 'in_progress' }],
      }),
    });
    assert.equal(stale.status, 503);
    assert.equal(providerCalls.length, 1);

    const retry = await fetch(`${baseUrl}/records`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ records: [canonical] }),
    });
    assert.equal(retry.status, 200);
    assert.equal(providerCalls.length, 2);
    assert.equal(providerCalls[1].path, providerCalls[0].path);
  });

  it('treats a changed watched timestamp as a real watch-date correction', async () => {
    let providerCalls = 0;
    const { baseUrl } = createTestServer({
      trackerProviders: {
        wetrakr: {
          authRef: '11111111-1111-4111-8111-111111111111',
          enabled: true,
        },
      },
      requestProviderApi: async () => {
        providerCalls += 1;
        return { data: { success: true } };
      },
    });
    const headers = {
      Authorization: auth('alice'),
      'Content-Type': 'application/json',
    };
    const canonical = record('episode:tt1234567:s2:e4', 950, 'watched');
    const first = await fetch(`${baseUrl}/records`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ records: [canonical] }),
    });
    assert.equal(first.status, 200);
    const callsAfterOriginWrite = providerCalls;
    const echo = await fetch(`${baseUrl}/records`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        records: [{ ...canonical, updatedAt: 999, origin: 'wetrakr' }],
      }),
    });
    assert.equal(echo.status, 200);
    const payload = await responseJson<{ data: { changed: number } }>(echo);
    assert.equal(payload.data.changed, 1);
    assert.equal(providerCalls, callsAfterOriginWrite);
  });

  it('fans notes, comments, and list membership through the account-scoped provider route', async () => {
    const providerCalls: Array<{
      path: string;
      method: string;
      body?: unknown;
      key?: string;
    }> = [];
    const { baseUrl } = createTestServer({
      trackerProviders: {
        wetrakr: {
          authRef: '11111111-1111-4111-8111-111111111111',
          enabled: true,
        },
      },
      requestProviderApi: async (_authRef, path, init) => {
        providerCalls.push({
          path,
          method: init.method,
          body: init.body,
          key: init.idempotencyKey,
        });
        return { data: { id: 80055, success: true } };
      },
    });
    const headers = {
      Authorization: auth('alice'),
      'Content-Type': 'application/json',
    };
    const records = [
      {
        id: 'movie:tt0468569|note',
        kind: 'movie',
        ids: { imdb: 'tt0468569' },
        title: 'The Dark Knight',
        state: 'note',
        text: 'Watch the IMAX cut.',
        spoiler: false,
        updatedAt: 1000,
        origin: 'nuvio',
        revision: 0,
      },
      {
        id: 'movie:tt0468569|comment',
        kind: 'movie',
        ids: { imdb: 'tt0468569' },
        title: 'The Dark Knight',
        state: 'comment',
        text: 'Still holds up.',
        spoiler: false,
        providerId: '80055',
        providerIdProvider: 'wetrakr',
        updatedAt: 1001,
        origin: 'nuvio',
        revision: 0,
      },
      {
        id: 'movie:tt0468569|list:42',
        kind: 'movie',
        ids: { imdb: 'tt0468569' },
        title: 'The Dark Knight',
        state: 'list',
        listId: '42',
        listIdProvider: 'wetrakr',
        listRank: 3,
        updatedAt: 1002,
        origin: 'nuvio',
        revision: 0,
      },
    ];
    const merged = await fetch(`${baseUrl}/records`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ records }),
    });
    assert.equal(merged.status, 200);
    assert.deepEqual(providerCalls.map(({ path }) => path).sort(), [
      '/notes',
      '/sync/comments',
      '/sync/lists/42/items',
    ]);
    assert.ok(
      providerCalls.every(
        (call) =>
          call.method === 'POST' && /^[a-f0-9]{64}$/.test(call.key ?? '')
      )
    );

    const deleted = await fetch(
      `${baseUrl}/records/${encodeURIComponent(records[1].id)}`,
      {
        method: 'DELETE',
        headers,
      }
    );
    assert.equal(deleted.status, 200);
    assert.equal(providerCalls.at(-1)?.method, 'DELETE');
    assert.equal(providerCalls.at(-1)?.path, '/sync/comments/80055');
    assert.match(providerCalls.at(-1)?.key ?? '', /^[a-f0-9]{64}$/);
  });

  it('fans live records and scrobbles to every enabled adapter and skips disabled providers', async () => {
    const events: Array<{
      provider: string;
      kind: string;
      state?: string;
      eventId?: string;
    }> = [];
    const adapter = (id: string): TrackerProviderAdapter => ({
      id,
      async pushRecords(_authRef, records) {
        events.push(
          ...records.map((item) => ({
            provider: id,
            kind: 'record',
            state: item.state,
          }))
        );
        return { synced: records.length, skipped: 0 };
      },
      async scrobble(_authRef, event) {
        events.push({
          provider: id,
          kind: `scrobble:${event.action}`,
          eventId: event.eventId,
        });
      },
    });
    const { baseUrl } = createTestServer({
      trackerProviders: {
        alpha: { authRef: 'alpha-auth', enabled: true },
        beta: { authRef: 'beta-auth', enabled: true },
        disabled: { authRef: 'disabled-auth', enabled: false },
      },
      trackerAdapters: [adapter('alpha'), adapter('beta'), adapter('disabled')],
    });
    const headers = {
      Authorization: auth('alice'),
      'Content-Type': 'application/json',
    };
    const records = await fetch(`${baseUrl}/records`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ records: [record('live-1', 1100)] }),
    });
    assert.equal(records.status, 200);
    const response = await responseJson<{
      data: { providerSync: { syncedProviders: string[] } };
    }>(records);
    assert.deepEqual(response.data.providerSync.syncedProviders.sort(), [
      'alpha',
      'beta',
    ]);
    assert.deepEqual(events.map((event) => event.provider).sort(), [
      'alpha',
      'beta',
    ]);

    const scrobble = await fetch(`${baseUrl}/scrobble`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        action: 'pause',
        progress: 25,
        media: { kind: 'movie', ids: { imdb: 'tt0468569' } },
      }),
    });
    assert.equal(scrobble.status, 200);
    const scrobbleEvents = events.filter(
      (event) => event.kind === 'scrobble:pause'
    );
    assert.deepEqual(scrobbleEvents.map((event) => event.provider).sort(), [
      'alpha',
      'beta',
    ]);
    assert.match(scrobbleEvents[0].eventId ?? '', /^[0-9a-f-]{36}$/i);
    assert.equal(scrobbleEvents[1].eventId, scrobbleEvents[0].eventId);
    assert.equal(
      events.some((event) => event.provider === 'disabled'),
      false
    );
  });

  it('uses each enabled adapter’s own API transport instead of routing every tracker through WeTrakr', async () => {
    const requests: Array<{ authRef: string; path: string; method: string }> =
      [];
    const provider: TrackerProviderAdapter = {
      id: 'independent-provider',
      requestApi: async (authRef, path, init) => {
        requests.push({ authRef, path, method: init.method });
        return { data: {}, headers: new Headers() };
      },
      async pushRecords(authRef, _records, requestApi) {
        await requestApi(authRef, '/provider/sync', { method: 'POST' });
        return { synced: 1, skipped: 0 };
      },
      async scrobble(authRef, _event, requestApi) {
        await requestApi(authRef, '/provider/scrobble', { method: 'POST' });
      },
    };
    const { baseUrl } = createTestServer({
      trackerProviders: {
        'independent-provider': {
          authRef: 'provider-owned-ref',
          enabled: true,
        },
      },
      trackerAdapters: [provider],
    });
    const headers = {
      Authorization: auth('alice'),
      'Content-Type': 'application/json',
    };
    const merged = await fetch(`${baseUrl}/records`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ records: [record('provider-transport', 2300)] }),
    });
    assert.equal(merged.status, 200);

    const scrobbled = await fetch(`${baseUrl}/scrobble`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        action: 'start',
        progress: 1,
        media: { kind: 'movie', ids: { imdb: 'tt0468569' } },
      }),
    });
    assert.equal(scrobbled.status, 200);
    assert.deepEqual(requests, [
      {
        authRef: 'provider-owned-ref',
        path: '/provider/sync',
        method: 'POST',
      },
      {
        authRef: 'provider-owned-ref',
        path: '/provider/scrobble',
        method: 'POST',
      },
    ]);
  });

  it('reports WeTrakr ignored scrobbles separately from successful provider writes', async () => {
    const { baseUrl } = createTestServer({
      trackerProviders: {
        wetrakr: { authRef: 'opaque-wetrakr-ref', enabled: true },
        beta: { authRef: 'beta-ref', enabled: true },
      },
      trackerAdapters: [
        weTrakrTrackerAdapter,
        {
          id: 'beta',
          async pushRecords() {
            return { synced: 0, skipped: 0 };
          },
          async scrobble() {},
        },
      ],
      requestProviderApi: async (_authRef, path) => {
        assert.equal(path, '/scrobble/start');
        return {
          data: {
            ignored: true,
            reason: `title could not be resolved ${'a'.repeat(40)}`,
          },
        };
      },
    });
    const response = await fetch(`${baseUrl}/scrobble`, {
      method: 'POST',
      headers: {
        Authorization: auth('alice'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'start',
        progress: 1,
        media: { kind: 'movie', title: 'Example', ids: { imdb: 'tt0468569' } },
      }),
    });
    assert.equal(response.status, 200);
    const result = await responseJson<{
      data: {
        syncedProviders: string[];
        ignoredProviders: Array<{ providerId: string; reason?: string }>;
      };
    }>(response);
    assert.deepEqual(result.data.syncedProviders, ['beta']);
    assert.deepEqual(result.data.ignoredProviders, [
      {
        providerId: 'wetrakr',
        reason: 'title could not be resolved [redacted]',
      },
    ]);
  });

  it('reports configured providers without adapters rather than pretending they synced', async () => {
    const { baseUrl } = createTestServer({
      trackerProviders: { future: { authRef: 'future-auth', enabled: true } },
      trackerAdapters: [],
    });
    const headers = {
      Authorization: auth('alice'),
      'Content-Type': 'application/json',
    };
    const saved = await fetch(`${baseUrl}/records`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ records: [record('canonical-only', 1200)] }),
    });
    assert.equal(saved.status, 200);
    const body = await responseJson<{
      data: {
        providerSync: {
          syncedProviders: string[];
          unsupportedProviders: string[];
        };
      };
    }>(saved);
    assert.deepEqual(body.data.providerSync.syncedProviders, []);
    assert.deepEqual(body.data.providerSync.unsupportedProviders, ['future']);

    const scrobble = await fetch(`${baseUrl}/scrobble`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        action: 'start',
        progress: 1,
        media: { kind: 'movie', ids: { imdb: 'tt0468569' } },
      }),
    });
    assert.equal(scrobble.status, 501);
    assert.deepEqual(
      (await responseJson<{ unsupportedProviders: string[] }>(scrobble))
        .unsupportedProviders,
      ['future']
    );
  });

  it('refreshes linked provider snapshots and deltas, then merges changes into the other enabled tracker', async () => {
    const pushed: Array<{ provider: string; ids: string[] }> = [];
    const suppliedCheckpoints: string[] = [];
    let journalPoll = 0;
    const wetrakr: TrackerProviderAdapter = {
      id: 'wetrakr',
      async pushRecords(_authRef, records) {
        pushed.push({ provider: 'wetrakr', ids: records.map(({ id }) => id) });
        return { synced: records.length, skipped: 0 };
      },
      async scrobble() {},
      async pullSnapshot() {
        return [
          { ...record('remote-existing', 1500, 'watched'), origin: 'wetrakr' },
        ];
      },
      async pullChanges(_authRef, checkpoint) {
        suppliedCheckpoints.push(checkpoint);
        journalPoll += 1;
        return {
          checkpoint:
            journalPoll === 1
              ? '2026-10-05T12:00:00.000Z'
              : journalPoll === 2
                ? '2026-10-05T11:59:59.000Z'
                : '2026-10-05T12:01:00.000Z',
          records:
            journalPoll === 1
              ? [
                  {
                    ...record('remote-change', 1600, 'watched'),
                    origin: 'wetrakr',
                  },
                ]
              : [],
        };
      },
    };
    const beta: TrackerProviderAdapter = {
      id: 'beta',
      async pushRecords(_authRef, records) {
        pushed.push({ provider: 'beta', ids: records.map(({ id }) => id) });
        return { synced: records.length, skipped: 0 };
      },
      async scrobble() {},
    };
    const { baseUrl } = createTestServer({
      trackerProviders: {
        wetrakr: { authRef: 'wetrakr-ref', enabled: true },
        beta: { authRef: 'beta-ref', enabled: true },
      },
      trackerAdapters: [wetrakr, beta],
    });
    const refreshed = await fetch(`${baseUrl}/refresh`, {
      method: 'POST',
      headers: { Authorization: auth('alice') },
    });
    assert.equal(refreshed.status, 200);
    const result = await responseJson<{
      data: { imported: number; syncedProviders: string[] };
    }>(refreshed);
    assert.equal(result.data.imported, 2);
    assert.deepEqual(result.data.syncedProviders.sort(), ['beta', 'wetrakr']);
    assert.ok(Number.isFinite(Date.parse(suppliedCheckpoints[0])));
    assert.ok(Date.now() - Date.parse(suppliedCheckpoints[0]) >= 4_000);
    assert.ok(Date.now() - Date.parse(suppliedCheckpoints[0]) < 60_000);
    assert.deepEqual(pushed, [
      { provider: 'beta', ids: ['remote-existing', 'remote-change'] },
    ]);

    await fetch(`${baseUrl}/refresh`, {
      method: 'POST',
      headers: { Authorization: auth('alice') },
    });
    await fetch(`${baseUrl}/refresh`, {
      method: 'POST',
      headers: { Authorization: auth('alice') },
    });
    assert.equal(suppliedCheckpoints[1], '2026-10-05T12:00:00.000Z');
    assert.equal(
      suppliedCheckpoints[2],
      '2026-10-05T11:59:59.000Z',
      'a delayed journal checkpoint must be allowed to move backward safely'
    );

    const snapshot = await fetch(`${baseUrl}/snapshot`, {
      headers: { Authorization: auth('alice') },
    });
    const records = await responseJson<{
      data: { records: Array<{ id: string }> };
    }>(snapshot);
    assert.deepEqual(
      records.data.records.map(({ id }) => id),
      ['remote-existing', 'remote-change']
    );
  });

  it('propagates a corrected Floppy completion date even when the watched state is unchanged', async () => {
    let watchedAt = Date.parse('2024-02-03T04:05:06.000Z');
    const downstreamDates: number[] = [];
    const floppy: TrackerProviderAdapter = {
      id: 'floppy',
      syncMode: 'snapshot',
      async pullSnapshot() {
        return [
          {
            ...record(
              'episode:imdb:tt1234567:s2e4|status',
              watchedAt,
              'watched'
            ),
            origin: 'floppy',
          },
        ];
      },
      async pushRecords(_authRef, records) {
        downstreamDates.push(
          ...records
            .filter(({ state }) => state === 'watched')
            .map(({ updatedAt }) => updatedAt)
        );
        return { synced: records.length, skipped: 0 };
      },
      async scrobble() {},
    };
    const beta: TrackerProviderAdapter = {
      id: 'beta',
      async pushRecords(_authRef, records) {
        downstreamDates.push(
          ...records
            .filter(({ state }) => state === 'watched')
            .map(({ updatedAt }) => updatedAt)
        );
        return { synced: records.length, skipped: 0 };
      },
      async scrobble() {},
    };
    const { baseUrl } = createTestServer({
      trackerProviders: {
        floppy: { authRef: 'floppy-ref', enabled: true },
        beta: { authRef: 'beta-ref', enabled: true },
      },
      trackerAdapters: [floppy, beta],
    });
    const refresh = () =>
      fetch(`${baseUrl}/refresh`, {
        method: 'POST',
        headers: { Authorization: auth('alice') },
      });

    assert.equal((await refresh()).status, 200);
    watchedAt = Date.parse('2025-03-04T05:06:07.000Z');
    assert.equal((await refresh()).status, 200);

    assert.ok(downstreamDates.includes(Date.parse('2025-03-04T05:06:07.000Z')));
    const snapshot = await fetch(`${baseUrl}/snapshot`, {
      headers: { Authorization: auth('alice') },
    });
    const body = await responseJson<{ data: { records: TrackerRecord[] } }>(
      snapshot
    );
    assert.equal(
      body.data.records.find(
        ({ id }) => id === 'episode:imdb:tt1234567:s2e4|status'
      )?.updatedAt,
      Date.parse('2025-03-04T05:06:07.000Z')
    );
  });

  it('uses WeTrakr full account history on first refresh and merges it through the real adapter', async () => {
    const requests: Array<{ authRef: string; path: string; method: string }> =
      [];
    const downstream: string[][] = [];
    const remoteMovie = {
      type: 'movie',
      ids: { imdb: 'tt7654321' },
      title: 'Existing Watched Movie',
      watched_at: '2024-01-02T03:04:05.000Z',
    };
    const requestProviderApi = async (
      authRef: string,
      path: string,
      init: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' }
    ) => {
      requests.push({ authRef, path, method: init.method });
      if (path.startsWith('/sync/tracking/watched/all'))
        return { data: [remoteMovie] };
      if (path.startsWith('/sync/journal'))
        return {
          data: { entries: [], visible_until: '2026-10-06T12:00:00.000Z' },
        };
      return { data: [] };
    };
    const downstreamAdapter: TrackerProviderAdapter = {
      id: 'downstream',
      async pushRecords(_authRef, records) {
        downstream.push(records.map(({ id }) => id));
        return { synced: records.length, skipped: 0 };
      },
      async scrobble() {},
    };
    const { baseUrl } = createTestServer({
      trackerProviders: {
        wetrakr: { authRef: 'server-held-wetrakr-ref', enabled: true },
        downstream: { authRef: 'downstream-ref', enabled: true },
      },
      requestProviderApi,
      trackerAdapters: [weTrakrTrackerAdapter, downstreamAdapter],
    });

    const refreshed = await fetch(`${baseUrl}/refresh`, {
      method: 'POST',
      headers: { Authorization: auth('alice') },
    });
    assert.equal(refreshed.status, 200);
    const result = await responseJson<{
      data: {
        imported: number;
        syncedProviders: string[];
        pulledProviders: string[];
      };
    }>(refreshed);
    assert.equal(result.data.imported, 1);
    assert.deepEqual(result.data.pulledProviders, ['wetrakr']);
    assert.deepEqual(result.data.syncedProviders, ['wetrakr', 'downstream']);
    assert.ok(
      requests.some(
        ({ authRef, path, method }) =>
          authRef === 'server-held-wetrakr-ref' &&
          method === 'GET' &&
          path.startsWith('/sync/tracking/watched/all')
      ),
      'first sync must import the existing watched-account snapshot'
    );
    assert.ok(
      requests.some(
        ({ authRef, path, method }) =>
          authRef === 'server-held-wetrakr-ref' &&
          method === 'GET' &&
          path.startsWith('/sync/journal')
      ),
      'first sync must also establish the incremental journal checkpoint'
    );
    assert.deepEqual(downstream, [['movie:imdb:tt7654321']]);
    assert.equal(
      requests.some(
        ({ authRef, method }) =>
          authRef === 'server-held-wetrakr-ref' && method !== 'GET'
      ),
      false,
      'a WeTrakr-origin snapshot must not echo a write back to WeTrakr'
    );
  });

  it('checkpoints the journal and retries only failed WeTrakr facets after a partial initial sync', async () => {
    let watchedReads = 0;
    let likesReads = 0;
    const journalCheckpoints: string[] = [];
    const pushedDownstream: string[][] = [];
    const requestProviderApi = async (
      _authRef: string,
      path: string,
      init: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' }
    ) => {
      if (init.method === 'GET' && path.startsWith('/sync/likes/all')) {
        likesReads += 1;
        throw Object.assign(new Error('private upstream body'), {
          status: 403,
          endpoint: 'likes_all',
          providerCode: 'PRIVATE',
        });
      }
      if (
        init.method === 'GET' &&
        path.startsWith('/sync/tracking/watched/all')
      ) {
        watchedReads += 1;
        return {
          data: [
            {
              type: 'movie',
              ids: { imdb: 'tt7654323' },
              title: 'Partial Snapshot Movie',
              watched_at: '2026-10-05T12:30:00.000Z',
            },
          ],
        };
      }
      if (init.method === 'GET' && path.startsWith('/sync/journal')) {
        journalCheckpoints.push(
          new URL(path, 'https://api.wetrakr.com').searchParams.get(
            'from_date'
          ) ?? ''
        );
        return {
          data: { entries: [], visible_until: '2026-10-06T12:00:00.000Z' },
        };
      }
      return { data: [] };
    };
    const downstream: TrackerProviderAdapter = {
      id: 'downstream',
      async pushRecords(_authRef, records) {
        pushedDownstream.push(records.map(({ id }) => id));
        return { synced: records.length, skipped: 0 };
      },
      async scrobble() {},
    };
    const { baseUrl } = createTestServer({
      trackerProviders: {
        wetrakr: { authRef: 'server-held-wetrakr-ref', enabled: true },
        downstream: { authRef: 'downstream-ref', enabled: true },
      },
      requestProviderApi,
      trackerAdapters: [weTrakrTrackerAdapter, downstream],
    });

    const refresh = () =>
      fetch(`${baseUrl}/refresh`, {
        method: 'POST',
        headers: { Authorization: auth('alice') },
      });
    const first = await refresh();
    assert.equal(first.status, 503);
    const firstResult = await responseJson<{
      data: {
        imported: number;
        syncedProviders: string[];
        pendingProviders: string[];
        pendingDetails: Array<{ providerId: string; endpoint?: string }>;
      };
    }>(first);
    assert.equal(firstResult.data.imported, 1);
    assert.deepEqual(firstResult.data.syncedProviders, ['downstream']);
    assert.deepEqual(firstResult.data.pendingProviders, ['wetrakr']);
    assert.deepEqual(firstResult.data.pendingDetails, [
      {
        providerId: 'wetrakr',
        stage: 'pull',
        reason: 'upstream_private',
        endpoint: 'likes_all',
      },
    ]);
    assert.deepEqual(pushedDownstream, [['movie:imdb:tt7654323']]);
    assert.equal(
      JSON.stringify(firstResult).includes('private upstream body'),
      false
    );

    const canonical = await fetch(`${baseUrl}/snapshot`, {
      headers: { Authorization: auth('alice') },
    });
    const canonicalBody = await responseJson<{
      data: { records: Array<{ id: string }> };
    }>(canonical);
    assert.deepEqual(
      canonicalBody.data.records.map(({ id }) => id),
      ['movie:imdb:tt7654323']
    );

    await refresh();
    assert.equal(
      likesReads,
      1,
      'a failed provider facet is reported pending but is not hammered during its retry cooldown'
    );
    assert.equal(
      watchedReads,
      1,
      'completed watched facets must not be downloaded again while likes retries'
    );
    assert.equal(journalCheckpoints.length, 2);
    assert.equal(
      journalCheckpoints[1],
      '2026-10-06T12:00:00.000Z',
      'the successful journal checkpoint advances despite an unavailable snapshot facet'
    );
  });

  it('never prunes missing records from a partial snapshot', async () => {
    let snapshotAttempt = 0;
    const provider: TrackerProviderAdapter = {
      id: 'snapshot-provider',
      syncMode: 'snapshot',
      async pushRecords() {
        return { synced: 0, skipped: 0 };
      },
      async scrobble() {},
      async pullSnapshot() {
        snapshotAttempt += 1;
        if (snapshotAttempt === 1) {
          return [
            {
              ...record('kept-from-first-snapshot', 2100, 'watched'),
              origin: 'snapshot-provider',
            },
          ];
        }
        return {
          records: [
            {
              ...record('new-visible-record', 2200, 'watched'),
              origin: 'snapshot-provider',
            },
          ],
          failures: [
            {
              endpoint: 'sync_tracking_watched_history_episodes',
              reason: 'invalid_history_cursor',
            },
          ],
        };
      },
    };
    const { baseUrl } = createTestServer({
      trackerProviders: {
        'snapshot-provider': { authRef: 'snapshot-auth', enabled: true },
      },
      trackerAdapters: [provider],
    });
    const refresh = () =>
      fetch(`${baseUrl}/refresh`, {
        method: 'POST',
        headers: { Authorization: auth('alice') },
      });

    assert.equal((await refresh()).status, 200);
    const partial = await refresh();
    assert.equal(partial.status, 503);
    const pending = await responseJson<{
      data: {
        pendingProviders: string[];
        syncedProviders: string[];
        pendingDetails: Array<{ reason: string; endpoint?: string }>;
      };
    }>(partial);
    assert.deepEqual(pending.data.pendingProviders, ['snapshot-provider']);
    assert.deepEqual(pending.data.syncedProviders, []);
    assert.deepEqual(pending.data.pendingDetails, [
      {
        providerId: 'snapshot-provider',
        stage: 'pull',
        reason: 'invalid_history_cursor',
        endpoint: 'sync_tracking_watched_history_episodes',
      },
    ]);

    const snapshot = await fetch(`${baseUrl}/snapshot`, {
      headers: { Authorization: auth('alice') },
    });
    const body = await responseJson<{
      data: { records: Array<{ id: string; state: string }> };
    }>(snapshot);
    assert.deepEqual(
      body.data.records.map(({ id, state }) => [id, state]),
      [
        ['kept-from-first-snapshot', 'watched'],
        ['new-visible-record', 'watched'],
      ]
    );
  });

  it('reports a safe stage and reason for a failed provider pull', async () => {
    const requestProviderApi = async () => {
      throw Object.assign(new Error('must not be returned to the client'), {
        status: 503,
      });
    };
    const { baseUrl } = createTestServer({
      trackerProviders: {
        wetrakr: { authRef: 'server-held-wetrakr-ref', enabled: true },
      },
      requestProviderApi,
      trackerAdapters: [weTrakrTrackerAdapter],
    });

    const response = await fetch(`${baseUrl}/refresh`, {
      method: 'POST',
      headers: { Authorization: auth('alice') },
    });
    assert.equal(response.status, 503);
    const result = await responseJson<{
      data: {
        pendingProviders: string[];
        pendingDetails: Array<{
          providerId: string;
          stage: string;
          reason: string;
        }>;
      };
    }>(response);
    assert.deepEqual(result.data.pendingProviders, ['wetrakr']);
    assert.deepEqual(result.data.pendingDetails, [
      {
        providerId: 'wetrakr',
        stage: 'pull',
        reason: 'upstream_unavailable',
      },
    ]);
    assert.equal(
      JSON.stringify(result).includes('must not be returned'),
      false
    );
  });

  it('reports a safe Floppy write status without exposing the upstream error', async () => {
    const sourceRecord = {
      ...record('seed-from-source', 2_500),
      origin: 'source',
    };
    const source: TrackerProviderAdapter = {
      id: 'source',
      async pushRecords() {
        return { synced: 0, skipped: 0 };
      },
      async scrobble() {},
      async pullSnapshot() {
        return [sourceRecord];
      },
    };
    const floppy: TrackerProviderAdapter = {
      id: 'floppy',
      async pushRecords() {
        throw new Error(
          'Floppy API request failed (400); record=episode-watched'
        );
      },
      async scrobble() {},
    };
    const { baseUrl } = createTestServer({
      trackerProviders: {
        source: { authRef: 'source-ref', enabled: true },
        floppy: { authRef: 'floppy-ref', enabled: true },
      },
      trackerAdapters: [source, floppy],
    });
    const response = await fetch(`${baseUrl}/refresh`, {
      method: 'POST',
      headers: { Authorization: auth('alice') },
    });
    assert.equal(response.status, 503);
    const result = await responseJson<{
      data: {
        pendingProviders: string[];
        pendingDetails: Array<{
          providerId: string;
          stage: string;
          reason: string;
        }>;
      };
    }>(response);
    assert.deepEqual(result.data.pendingProviders, ['floppy']);
    assert.deepEqual(result.data.pendingDetails, [
      {
        providerId: 'floppy',
        stage: 'write',
        reason: 'upstream_http_400_episode_watched',
      },
    ]);
    assert.equal(
      JSON.stringify(result).includes('Floppy API request failed'),
      false
    );
  });

  it('reports a safe Floppy snapshot HTTP status and allowlisted endpoint', async () => {
    const floppy: TrackerProviderAdapter = {
      id: 'floppy',
      async pushRecords() {
        return { synced: 0, skipped: 0 };
      },
      async scrobble() {},
      async pullSnapshot() {
        throw Object.assign(new Error('Floppy snapshot request failed'), {
          status: 404,
          endpoint: 'floppy_media_season',
        });
      },
    };
    const { baseUrl } = createTestServer({
      trackerProviders: {
        floppy: { authRef: 'server-held-floppy-ref', enabled: true },
      },
      trackerAdapters: [floppy],
    });
    const response = await fetch(`${baseUrl}/refresh`, {
      method: 'POST',
      headers: { Authorization: auth('alice') },
    });
    assert.equal(response.status, 503);
    const result = await responseJson<{
      data: {
        pendingDetails: Array<{
          providerId: string;
          stage: string;
          reason: string;
          endpoint?: string;
        }>;
      };
    }>(response);
    assert.deepEqual(result.data.pendingDetails, [
      {
        providerId: 'floppy',
        stage: 'pull',
        reason: 'upstream_http_404',
        endpoint: 'floppy_media_season',
      },
    ]);
  });

  it('isolates a failed Floppy record so successful records drain from the same batch', async () => {
    const source: TrackerProviderAdapter = {
      id: 'source',
      async pushRecords() {
        return { synced: 0, skipped: 0 };
      },
      async scrobble() {},
      async pullSnapshot() {
        return [
          { ...record('valid-floppy-write', 2_500), origin: 'source' },
          { ...record('invalid-floppy-write', 2_600), origin: 'source' },
        ];
      },
    };
    const attempted: string[] = [];
    const floppy: TrackerProviderAdapter = {
      id: 'floppy',
      async pushRecords() {
        return { synced: 0, skipped: 0 };
      },
      async pushRecord(_authRef, item) {
        attempted.push(item.id);
        if (item.id === 'invalid-floppy-write')
          throw new Error('Floppy API request failed (400)');
        return true;
      },
      async scrobble() {},
    };
    const { baseUrl } = createTestServer({
      trackerProviders: {
        source: { authRef: 'source-ref', enabled: true },
        floppy: { authRef: 'floppy-ref', enabled: true },
      },
      trackerAdapters: [source, floppy],
    });
    const refresh = () =>
      fetch(`${baseUrl}/refresh`, {
        method: 'POST',
        headers: { Authorization: auth('alice') },
      });

    const first = await refresh();
    assert.equal(first.status, 503);
    const firstBody = await responseJson<{
      data: { pendingDetails: Array<{ providerId: string; reason: string }> };
    }>(first);
    assert.deepEqual(firstBody.data.pendingDetails, [
      {
        providerId: 'floppy',
        stage: 'write',
        reason: 'upstream_http_400_episode_in_progress',
      },
    ]);

    const second = await refresh();
    assert.equal(second.status, 503);
    assert.deepEqual(attempted, [
      'valid-floppy-write',
      'invalid-floppy-write',
      'invalid-floppy-write',
    ]);
  });

  it('reports safe upstream HTTP status and allowlisted endpoint labels', async () => {
    const requestProviderApi = async () => {
      throw Object.assign(
        new Error('sensitive upstream body must stay private'),
        { status: 404, endpoint: 'sync_tracking_watched_all' }
      );
    };
    const { baseUrl } = createTestServer({
      trackerProviders: {
        wetrakr: { authRef: 'server-held-wetrakr-ref', enabled: true },
      },
      requestProviderApi,
      trackerAdapters: [weTrakrTrackerAdapter],
    });

    const response = await fetch(`${baseUrl}/refresh`, {
      method: 'POST',
      headers: { Authorization: auth('alice') },
    });
    assert.equal(response.status, 503);
    const result = await responseJson<{
      data: {
        pendingDetails: Array<{
          providerId: string;
          stage: string;
          reason: string;
          endpoint: string;
        }>;
      };
    }>(response);
    assert.deepEqual(result.data.pendingDetails, [
      {
        providerId: 'wetrakr',
        stage: 'pull',
        reason: 'upstream_http_404',
        endpoint: 'sync_tracking_watched_all',
      },
    ]);
    assert.equal(
      JSON.stringify(result).includes('sensitive upstream body'),
      false
    );
  });

  it('distinguishes upstream authentication failure from access denial without leaking details', async () => {
    for (const status of [401, 403]) {
      const requestProviderApi = async () => {
        throw Object.assign(new Error('private provider response body'), {
          status,
          endpoint: 'likes_all',
          ...(status === 403 ? { providerCode: 'PRIVATE' } : {}),
        });
      };
      const { baseUrl } = createTestServer({
        trackerProviders: {
          wetrakr: { authRef: 'server-held-wetrakr-ref', enabled: true },
        },
        requestProviderApi,
        trackerAdapters: [weTrakrTrackerAdapter],
      });
      const response = await fetch(`${baseUrl}/refresh`, {
        method: 'POST',
        headers: { Authorization: auth('alice') },
      });
      const result = await responseJson<{
        data: { pendingDetails: Array<{ reason: string; endpoint: string }> };
      }>(response);
      assert.equal(response.status, 503);
      assert.deepEqual(result.data.pendingDetails, [
        {
          providerId: 'wetrakr',
          stage: 'pull',
          reason: status === 403 ? 'upstream_private' : 'upstream_http_401',
          endpoint: 'likes_all',
        },
      ]);
      assert.equal(
        JSON.stringify(result).includes('private provider response body'),
        false
      );
    }
  });

  it('replays canonical initial WeTrakr records after downstream failure without re-fetching completed facets', async () => {
    let watchedSnapshotReads = 0;
    let downstreamAttempts = 0;
    const attemptedWrites: string[][] = [];
    const remoteMovie = {
      type: 'movie',
      ids: { imdb: 'tt7654322' },
      title: 'Initial Import Retry Movie',
      watched_at: '2024-01-03T03:04:05.000Z',
    };
    const requestProviderApi = async (_authRef: string, path: string) => {
      if (path.startsWith('/sync/tracking/watched/all')) {
        watchedSnapshotReads += 1;
        return { data: [remoteMovie] };
      }
      if (path.startsWith('/sync/journal'))
        return {
          data: { entries: [], visible_until: '2026-10-06T12:00:00.000Z' },
        };
      return { data: [] };
    };
    const downstreamAdapter: TrackerProviderAdapter = {
      id: 'downstream',
      async pushRecords(_authRef, records) {
        downstreamAttempts += 1;
        attemptedWrites.push(records.map(({ id }) => id));
        if (downstreamAttempts === 1)
          throw new Error('simulated downstream outage');
        return { synced: records.length, skipped: 0 };
      },
      async scrobble() {},
    };
    const { baseUrl } = createTestServer({
      trackerProviders: {
        wetrakr: { authRef: 'server-held-wetrakr-ref', enabled: true },
        downstream: { authRef: 'downstream-ref', enabled: true },
      },
      requestProviderApi,
      trackerAdapters: [weTrakrTrackerAdapter, downstreamAdapter],
    });

    const refresh = () =>
      fetch(`${baseUrl}/refresh`, {
        method: 'POST',
        headers: { Authorization: auth('alice') },
      });
    const first = await refresh();
    assert.equal(first.status, 503);
    const firstResult = await responseJson<{
      data: { pendingProviders: string[] };
    }>(first);
    assert.deepEqual(firstResult.data.pendingProviders, ['downstream']);

    const retry = await refresh();
    assert.equal(retry.status, 200);
    const retryResult = await responseJson<{
      data: { imported: number; pendingProviders: string[] };
    }>(retry);
    assert.equal(retryResult.data.imported, 0);
    assert.deepEqual(retryResult.data.pendingProviders, []);
    assert.equal(watchedSnapshotReads, 1);
    assert.deepEqual(attemptedWrites, [
      ['movie:imdb:tt7654322'],
      ['movie:imdb:tt7654322'],
    ]);
  });

  it('uses the destination adapter transport when refresh fans out merged records', async () => {
    const calls: Array<{ authRef: string; path: string; method: string }> = [];
    const source: TrackerProviderAdapter = {
      id: 'source',
      async pushRecords() {
        return { synced: 0, skipped: 0 };
      },
      async scrobble() {},
      async pullSnapshot() {
        return [
          { ...record('source-record', 2_100, 'watched'), origin: 'source' },
        ];
      },
    };
    const destination: TrackerProviderAdapter = {
      id: 'destination',
      requestApi: async (authRef, path, init) => {
        calls.push({ authRef, path, method: init.method });
        return { data: {} };
      },
      async pushRecords(authRef, records, requestApi) {
        await requestApi(authRef, '/destination/records', {
          method: 'POST',
          body: { records },
        });
        return { synced: records.length, skipped: 0 };
      },
      async scrobble() {},
    };
    const { baseUrl } = createTestServer({
      trackerProviders: {
        source: { authRef: 'source-ref', enabled: true },
        destination: { authRef: 'destination-ref', enabled: true },
      },
      // If the router accidentally uses its legacy/global WeTrakr transport,
      // fail locally instead of making a real network request.
      requestProviderApi: async () => {
        throw new Error('global transport must not receive destination writes');
      },
      trackerAdapters: [source, destination],
    });

    const refreshed = await fetch(`${baseUrl}/refresh`, {
      method: 'POST',
      headers: { Authorization: auth('alice') },
    });

    assert.equal(refreshed.status, 200);
    assert.deepEqual(calls, [
      {
        authRef: 'destination-ref',
        path: '/destination/records',
        method: 'POST',
      },
    ]);
  });

  it('continuously reconciles complete snapshot providers and propagates removals', async () => {
    const pushed: Array<{ provider: string; records: TrackerRecord[] }> = [];
    let snapshot: TrackerRecord[] = [
      { ...record('snapshot-watchlist', 2100), state: 'watchlist' as const },
    ];
    const source: TrackerProviderAdapter = {
      id: 'snapshot-source',
      syncMode: 'snapshot',
      async pushRecords(_authRef, records) {
        pushed.push({ provider: 'snapshot-source', records });
        return { synced: records.length, skipped: 0 };
      },
      async scrobble() {},
      async pullSnapshot() {
        return snapshot;
      },
    };
    const destination: TrackerProviderAdapter = {
      id: 'destination',
      async pushRecords(_authRef, records) {
        pushed.push({ provider: 'destination', records });
        return { synced: records.length, skipped: 0 };
      },
      async scrobble() {},
    };
    const { baseUrl } = createTestServer({
      trackerProviders: {
        'snapshot-source': { authRef: 'source-auth', enabled: true },
        destination: { authRef: 'destination-auth', enabled: true },
      },
      trackerAdapters: [source, destination],
    });
    const headers = { Authorization: auth('alice') };
    const refresh = () =>
      fetch(`${baseUrl}/refresh`, { method: 'POST', headers });

    const first = await refresh();
    assert.equal(first.status, 200);
    assert.deepEqual(
      pushed.at(-1)?.records.map(({ id }) => id),
      ['snapshot-watchlist']
    );

    const unchanged = await refresh();
    assert.equal(unchanged.status, 200);
    assert.equal(pushed.length, 1, 'unchanged snapshots must not echo forever');

    snapshot = [];
    const removed = await refresh();
    assert.equal(removed.status, 200);
    assert.deepEqual(
      pushed.at(-1)?.records.map(({ id, state }) => ({ id, state })),
      [{ id: 'snapshot-watchlist', state: 'deleted' }]
    );

    const afterRemoval = await refresh();
    assert.equal(afterRemoval.status, 200);
    assert.equal(pushed.length, 2, 'a removal is emitted once after commit');
  });

  it('repairs a stale snapshot source from the newer canonical winner', async () => {
    let snapshot: TrackerRecord[] = [
      { ...record('shared-progress', 2500), state: 'watchlist' as const },
    ];
    const repaired: TrackerRecord[] = [];
    const source: TrackerProviderAdapter = {
      id: 'snapshot-source',
      syncMode: 'snapshot',
      async pushRecords(_authRef, records) {
        repaired.push(...records);
        return { synced: records.length, skipped: 0 };
      },
      async scrobble() {},
      async pullSnapshot() {
        return snapshot;
      },
    };
    const { baseUrl } = createTestServer({
      trackerProviders: {
        'snapshot-source': { authRef: 'source-auth', enabled: true },
      },
      trackerAdapters: [source],
    });
    const headers = {
      Authorization: auth('alice'),
      'Content-Type': 'application/json',
    };
    const refresh = () =>
      fetch(`${baseUrl}/refresh`, { method: 'POST', headers });

    assert.equal((await refresh()).status, 200);
    const newer = {
      ...record('shared-progress', 3500, 'watched'),
      origin: 'nuvio',
    };
    const localChange = await fetch(`${baseUrl}/records`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ records: [newer] }),
    });
    assert.equal(localChange.status, 200);
    repaired.length = 0;

    snapshot = [record('shared-progress', 2400, 'in_progress')];
    const reconciled = await refresh();

    assert.equal(reconciled.status, 200);
    assert.equal(repaired.length, 1);
    assert.equal(repaired[0].state, 'watched');
    assert.equal(repaired[0].updatedAt, 3500);
  });

  it('retries snapshot deltas after fan-out failure without advancing observed state', async () => {
    let destinationFails = true;
    let sourceCalls = 0;
    const pushed: string[][] = [];
    const source: TrackerProviderAdapter = {
      id: 'snapshot-source',
      syncMode: 'snapshot',
      async pushRecords() {
        return { synced: 0, skipped: 0 };
      },
      async scrobble() {},
      async pullSnapshot() {
        sourceCalls += 1;
        return [record('snapshot-retry', 2200, 'watched')];
      },
    };
    const destination: TrackerProviderAdapter = {
      id: 'destination',
      async pushRecords(_authRef, records) {
        pushed.push(records.map(({ id }) => id));
        if (destinationFails) throw new Error('temporary destination outage');
        return { synced: records.length, skipped: 0 };
      },
      async scrobble() {},
    };
    const { baseUrl } = createTestServer({
      trackerProviders: {
        'snapshot-source': { authRef: 'source-auth', enabled: true },
        destination: { authRef: 'destination-auth', enabled: true },
      },
      trackerAdapters: [source, destination],
    });
    const headers = { Authorization: auth('alice') };

    const first = await fetch(`${baseUrl}/refresh`, {
      method: 'POST',
      headers,
    });
    assert.equal(first.status, 503);
    destinationFails = false;
    const retry = await fetch(`${baseUrl}/refresh`, {
      method: 'POST',
      headers,
    });
    assert.equal(retry.status, 200);
    assert.equal(sourceCalls, 2);
    assert.deepEqual(pushed, [['snapshot-retry'], ['snapshot-retry']]);
  });

  it('continues provider fan-out after an adapter failure and reports only the failed provider for retry', async () => {
    const called: string[] = [];
    const adapter = (id: string, fails: boolean): TrackerProviderAdapter => ({
      id,
      async pushRecords() {
        called.push(id);
        if (fails) throw new Error('private provider response');
        return { synced: 1, skipped: 0 };
      },
      async scrobble() {},
    });
    const { baseUrl } = createTestServer({
      trackerProviders: {
        alpha: { authRef: 'alpha-auth', enabled: true },
        beta: { authRef: 'beta-auth', enabled: true },
      },
      trackerAdapters: [adapter('alpha', true), adapter('beta', false)],
    });
    const response = await fetch(`${baseUrl}/records`, {
      method: 'POST',
      headers: {
        Authorization: auth('alice'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ records: [record('fanout-1', 1300)] }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(called.sort(), ['alpha', 'beta']);
    const body = await responseJson<{
      data: {
        providerSync: { pendingProviders: string[]; syncedProviders: string[] };
      };
    }>(response);
    assert.deepEqual(body.data.providerSync.pendingProviders, ['alpha']);
    assert.deepEqual(body.data.providerSync.syncedProviders, ['beta']);
    assert.equal(
      JSON.stringify(body).includes('private provider response'),
      false
    );
  });

  it('advances the source checkpoint after durable queueing and retries failed provider writes', async () => {
    const sourceRecord = {
      ...record('replayed-change', 1800, 'watched'),
      origin: 'wetrakr',
    };
    const pullCheckpoints: string[] = [];
    const pushed: string[][] = [];
    let destinationFails = true;
    let unavailablePulls = 0;
    const source: TrackerProviderAdapter = {
      id: 'wetrakr',
      async pushRecords() {
        return { synced: 0, skipped: 0 };
      },
      async scrobble() {},
      async pullSnapshot() {
        return [];
      },
      async pullChanges(_authRef, checkpoint) {
        pullCheckpoints.push(checkpoint);
        return {
          records: pullCheckpoints.length === 1 ? [sourceRecord] : [],
          checkpoint: '2026-10-05T12:00:00.000Z',
        };
      },
    };
    const destination: TrackerProviderAdapter = {
      id: 'beta',
      async pushRecords(_authRef, records) {
        pushed.push(records.map(({ id }) => id));
        if (destinationFails) throw new Error('temporary provider outage');
        return { synced: records.length, skipped: 0 };
      },
      async scrobble() {},
    };
    const intermittentlyUnavailable: TrackerProviderAdapter = {
      id: 'gamma',
      async pushRecords() {
        return { synced: 0, skipped: 0 };
      },
      async scrobble() {},
      async pullSnapshot() {
        return [];
      },
      async pullChanges() {
        unavailablePulls += 1;
        if (unavailablePulls === 1) throw new Error('temporary source outage');
        return { records: [], checkpoint: '2026-10-05T12:00:00.000Z' };
      },
    };
    const { baseUrl } = createTestServer({
      trackerProviders: {
        wetrakr: { authRef: 'wetrakr-auth', enabled: true },
        beta: { authRef: 'beta-auth', enabled: true },
        gamma: { authRef: 'gamma-auth', enabled: true },
      },
      trackerAdapters: [source, destination, intermittentlyUnavailable],
    });
    const headers = { Authorization: auth('alice') };

    const first = await fetch(`${baseUrl}/refresh`, {
      method: 'POST',
      headers,
    });
    assert.equal(first.status, 503);
    const firstResult = await responseJson<{
      data: { pendingProviders: string[] };
    }>(first);
    assert.deepEqual(firstResult.data.pendingProviders, ['gamma', 'beta']);

    destinationFails = false;
    const retry = await fetch(`${baseUrl}/refresh`, {
      method: 'POST',
      headers,
    });
    assert.equal(retry.status, 200);
    assert.equal(
      pullCheckpoints.length,
      2,
      'the source is polled again from its committed checkpoint'
    );
    assert.equal(
      pullCheckpoints[1],
      '2026-10-05T12:00:00.000Z',
      'durable queueing advances this source even when another provider pull fails'
    );
    assert.deepEqual(pushed, [['replayed-change'], ['replayed-change']]);
  });

  it('reports provider record types that an adapter could not represent during refresh', async () => {
    const source: TrackerProviderAdapter = {
      id: 'source',
      async pushRecords() {
        return { synced: 0, skipped: 0 };
      },
      async scrobble() {},
      async pullSnapshot() {
        return [
          {
            ...record('limited-facet', 1900),
            state: 'liked',
            origin: 'source',
          },
        ];
      },
      async pullChanges() {
        return { records: [], checkpoint: '2026-10-05T12:00:00.000Z' };
      },
    };
    const limited: TrackerProviderAdapter = {
      id: 'limited',
      async pushRecords(_authRef, records) {
        return { synced: 0, skipped: records.length };
      },
      async scrobble() {},
    };
    const { baseUrl } = createTestServer({
      trackerProviders: {
        source: { authRef: 'source-auth', enabled: true },
        limited: { authRef: 'limited-auth', enabled: true },
      },
      trackerAdapters: [source, limited],
    });
    const response = await fetch(`${baseUrl}/refresh`, {
      method: 'POST',
      headers: { Authorization: auth('alice') },
    });

    assert.equal(response.status, 200);
    const result = await responseJson<{
      data: {
        unsupportedWrites: Array<{ providerId: string; skipped: number }>;
      };
    }>(response);
    assert.deepEqual(result.data.unsupportedWrites, [
      { providerId: 'limited', skipped: 1 },
    ]);
  });

  it('routes deleted tombstones to generic adapters that do not define provider-specific deletion', async () => {
    const deletedStates: string[] = [];
    const generic: TrackerProviderAdapter = {
      id: 'generic',
      async pushRecords(_authRef, records) {
        deletedStates.push(...records.map(({ state }) => state));
        return { synced: records.length, skipped: 0 };
      },
      async scrobble() {},
    };
    const { baseUrl } = createTestServer({
      trackerProviders: { generic: { authRef: 'generic-auth', enabled: true } },
      trackerAdapters: [generic],
    });
    const headers = {
      Authorization: auth('alice'),
      'Content-Type': 'application/json',
    };
    const created = await fetch(`${baseUrl}/records`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        records: [record('generic-delete', 1400, 'watched')],
      }),
    });
    assert.equal(created.status, 200);
    const deleted = await fetch(`${baseUrl}/records/generic-delete`, {
      method: 'DELETE',
      headers,
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(deletedStates, ['watched', 'deleted']);
  });

  it('stores WeTrakr rate-limit cooldowns on durable writes without losing records', async () => {
    const adapter: TrackerProviderAdapter = {
      id: 'wetrakr',
      async pushRecords() {
        throw new WeTrakrRateLimitError(45_000, 'sync_tracking_watched_all');
      },
      async scrobble() {},
    };
    const { baseUrl, database } = createTestServer({
      trackerProviders: { wetrakr: { authRef: 'opaque-ref', enabled: true } },
      trackerAdapters: [adapter],
    });
    const before = Date.now();
    const response = await fetch(`${baseUrl}/records`, {
      method: 'POST',
      headers: {
        Authorization: auth('alice'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ records: [record('rate-limited-write', 1400)] }),
    });
    const after = Date.now();
    assert.equal(response.status, 503);
    const [queued] = database.inspectOutbox();
    assert.equal(queued?.record_id, 'rate-limited-write');
    assert.equal(queued?.last_error_code, 'rate_limited');
    assert.ok((queued?.next_attempt_at_ms ?? 0) >= before + 45_000);
    assert.ok((queued?.next_attempt_at_ms ?? Infinity) <= after + 45_000);
  });

  it('retains merged records and reports retryable provider failure', async () => {
    const { baseUrl } = createTestServer({
      trackerProviders: {
        wetrakr: {
          authRef: '11111111-1111-4111-8111-111111111111',
          enabled: true,
        },
      },
      requestProviderApi: async () => {
        throw new Error('upstream unavailable');
      },
    });
    const headers = {
      Authorization: auth('alice'),
      'Content-Type': 'application/json',
    };
    const response = await fetch(`${baseUrl}/records`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ records: [record('movie:tt0468569', 800)] }),
    });
    assert.equal(response.status, 503);
    const snapshot = await fetch(`${baseUrl}/snapshot`, { headers });
    const body = await responseJson<{
      data: { records: Array<{ id: string }> };
    }>(snapshot);
    assert.equal(body.data.records[0].id, 'movie:tt0468569');
  });

  it('retries a failed live write during refresh even when the provider has no new delta', async () => {
    let failWrite = true;
    const pushed: string[][] = [];
    const provider: TrackerProviderAdapter = {
      id: 'retryable',
      async pushRecords(_authRef, records) {
        pushed.push(records.map(({ id }) => id));
        if (failWrite) throw new Error('private provider outage');
        return { synced: records.length, skipped: 0 };
      },
      async scrobble() {},
      async pullChanges() {
        return { records: [], checkpoint: '2026-10-06T12:00:00.000Z' };
      },
    };
    const { baseUrl } = createTestServer({
      trackerProviders: {
        retryable: { authRef: 'retryable-auth', enabled: true },
      },
      trackerAdapters: [provider],
    });
    const headers = {
      Authorization: auth('alice'),
      'Content-Type': 'application/json',
    };
    const write = await fetch(`${baseUrl}/records`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        records: [record('durable-outbox', 1700, 'watched')],
      }),
    });
    assert.equal(write.status, 503);
    const failed = await responseJson<{
      data: { providerSync: { pendingProviders: string[] } };
    }>(write);
    assert.deepEqual(failed.data.providerSync.pendingProviders, ['retryable']);

    failWrite = false;
    const refresh = await fetch(`${baseUrl}/refresh`, {
      method: 'POST',
      headers: { Authorization: auth('alice') },
    });
    assert.equal(refresh.status, 200);
    const result = await responseJson<{
      data: { syncedProviders: string[]; pendingProviders: string[] };
    }>(refresh);
    assert.deepEqual(result.data.syncedProviders, ['retryable']);
    assert.deepEqual(result.data.pendingProviders, []);
    assert.deepEqual(pushed, [['durable-outbox'], ['durable-outbox']]);
  });

  it('forwards native player scrobbles through AIOStreams without exposing provider tokens', async () => {
    const providerCalls: Array<{
      authRef: string;
      path: string;
      body: unknown;
      idempotencyKey?: string;
    }> = [];
    const { baseUrl } = createTestServer({
      trackerProviders: {
        wetrakr: {
          authRef: '11111111-1111-4111-8111-111111111111',
          enabled: true,
        },
      },
      requestProviderApi: async (authRef, path, init) => {
        providerCalls.push({
          authRef,
          path,
          body: init.body,
          idempotencyKey: init.idempotencyKey,
        });
        return { data: { action: 'start', progress: 12.5 } };
      },
    });
    const scrobbleBody = JSON.stringify({
      eventId: 'player-event-123',
      action: 'start',
      progress: 12.5,
      media: {
        kind: 'movie',
        title: 'The Dark Knight',
        year: 2008,
        ids: { imdb: 'tt0468569' },
      },
    });
    const response = await fetch(`${baseUrl}/scrobble`, {
      method: 'POST',
      headers: {
        Authorization: auth('alice'),
        'Content-Type': 'application/json',
      },
      body: scrobbleBody,
    });
    assert.equal(response.status, 200);
    assert.equal(providerCalls.length, 1);
    assert.equal(providerCalls[0].path, '/scrobble/start');
    assert.equal(providerCalls[0].idempotencyKey, 'player-event-123');
    assert.deepEqual(providerCalls[0].body, {
      movie: {
        title: 'The Dark Knight',
        year: 2008,
        ids: { imdb: 'tt0468569' },
      },
      progress: 12.5,
    });
    assert.equal(
      JSON.stringify(await response.json()).includes('accessToken'),
      false
    );

    const retried = await fetch(`${baseUrl}/scrobble`, {
      method: 'POST',
      headers: {
        Authorization: auth('alice'),
        'Content-Type': 'application/json',
      },
      body: scrobbleBody,
    });
    assert.equal(retried.status, 200);
    assert.equal(providerCalls.length, 1, 'a delivered event is deduplicated');

    const invalidEpisode = await fetch(`${baseUrl}/scrobble`, {
      method: 'POST',
      headers: {
        Authorization: auth('alice'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'start',
        progress: 5,
        media: {
          kind: 'show',
          ids: { imdb: 'tt0903747' },
          episode: { number: 1 },
        },
      }),
    });
    assert.equal(invalidEpisode.status, 400);
    assert.equal(providerCalls.length, 1);
  });

  it('durably retries failed live scrobbles during refresh and deduplicates delivery', async () => {
    let attempts = 0;
    const events: string[] = [];
    const adapter: TrackerProviderAdapter = {
      id: 'retry-scrobble',
      async pushRecords() {
        return { synced: 0, skipped: 0 };
      },
      async scrobble(_authRef, event) {
        attempts += 1;
        events.push(event.eventId);
        if (attempts === 1) throw new Error('temporary provider outage');
      },
    };
    const { baseUrl } = createTestServer({
      trackerProviders: {
        'retry-scrobble': { authRef: 'opaque-ref', enabled: true },
      },
      trackerAdapters: [adapter],
    });
    const body = JSON.stringify({
      eventId: 'stable-player-event',
      action: 'pause',
      progress: 42,
      media: { kind: 'movie', ids: { imdb: 'tt0468569' } },
    });
    const first = await fetch(`${baseUrl}/scrobble`, {
      method: 'POST',
      headers: {
        Authorization: auth('alice'),
        'Content-Type': 'application/json',
      },
      body,
    });
    assert.equal(first.status, 503);
    assert.deepEqual(events, ['stable-player-event']);

    const refresh = await fetch(`${baseUrl}/refresh`, {
      method: 'POST',
      headers: { Authorization: auth('alice') },
    });
    assert.equal(refresh.status, 200);
    assert.deepEqual(events, ['stable-player-event', 'stable-player-event']);

    const duplicate = await fetch(`${baseUrl}/scrobble`, {
      method: 'POST',
      headers: {
        Authorization: auth('alice'),
        'Content-Type': 'application/json',
      },
      body,
    });
    assert.equal(duplicate.status, 200);
    assert.equal(events.length, 2, 'a delivered event is not replayed');
  });

  it('turns deletes into idempotent tombstones and rejects malformed records', async () => {
    const { baseUrl } = createTestServer();
    const headers = {
      Authorization: auth('alice'),
      'Content-Type': 'application/json',
    };
    const malformed = await fetch(`${baseUrl}/records`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ records: [{ id: 'bad', kind: 'nonsense' }] }),
    });
    assert.equal(malformed.status, 400);

    await fetch(`${baseUrl}/records`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ records: [record('to-delete', 300)] }),
    });
    const removed = await fetch(`${baseUrl}/records/to-delete`, {
      method: 'DELETE',
      headers,
    });
    assert.equal(removed.status, 200);
    const snapshot = await fetch(`${baseUrl}/snapshot`, { headers });
    const tombstone = (
      await responseJson<{ data: { records: Array<{ state: string }> } }>(
        snapshot
      )
    ).data.records[0];
    assert.equal(tombstone.state, 'deleted');
    const repeated = await fetch(`${baseUrl}/records/to-delete`, {
      method: 'DELETE',
      headers,
    });
    assert.equal(repeated.status, 200);
    assert.equal(
      (await fetch(`${baseUrl}/records/missing`, { method: 'DELETE', headers }))
        .status,
      404
    );
  });
});
