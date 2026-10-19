import { z } from 'zod';

/** Provider-neutral, credential-free record shared by Nuvio and AIOStreams. */
export const TrackerRecordSchema = z.object({
  id: z.string().trim().min(1).max(220),
  kind: z.enum(['movie', 'series', 'episode', 'person', 'list', 'comment']),
  ids: z.record(z.string(), z.string().trim().min(1).max(160)).default({}),
  title: z.string().trim().max(500).optional(),
  /** Parent series title for episode records; keeps episode title separate. */
  seriesTitle: z.string().trim().max(500).optional(),
  /** Episode-specific title, independent of the parent series title. */
  episodeTitle: z.string().trim().max(500).optional(),
  season: z.number().int().min(0).max(500).optional(),
  episode: z.number().int().min(0).max(10000).optional(),
  state: z.enum([
    'in_progress',
    'watched',
    'watchlist',
    'favorite',
    'rated',
    'note',
    'comment',
    'waiting',
    'paused',
    'dropped',
    'ignored',
    'list',
    'liked',
    'play',
    'deleted',
  ]),
  positionMs: z.number().int().min(0).max(31_536_000_000).optional(),
  durationMs: z.number().int().min(0).max(31_536_000_000).optional(),
  rating: z.number().min(0).max(10).optional(),
  text: z.string().max(10_000).optional(),
  listId: z.string().trim().max(220).optional(),
  /** Identifies the provider that owns a provider-specific custom-list ID. */
  listIdProvider: z.string().trim().min(1).max(80).optional(),
  listName: z.string().trim().max(200).optional(),
  listRank: z.number().int().min(0).max(1_000_000).optional(),
  /** Optional one-word reaction attached to a WeTrakr comment. */
  reaction: z.string().trim().max(80).optional(),
  providerId: z.string().trim().max(220).optional(),
  /** Identifies which provider owns `providerId`; prevents cross-provider deletes. */
  providerIdProvider: z.string().trim().min(1).max(80).optional(),
  parentId: z.string().trim().max(220).optional(),
  spoiler: z.boolean().optional(),
  deletedState: z
    .enum([
      'in_progress',
      'watched',
      'watchlist',
      'favorite',
      'rated',
      'note',
      'comment',
      'waiting',
      'paused',
      'dropped',
      'ignored',
      'list',
      'liked',
      'play',
    ])
    .optional(),
  updatedAt: z.number().int().positive(),
  origin: z.string().trim().min(1).max(80),
  revision: z.number().int().min(0).default(0),
});

export type TrackerRecord = z.infer<typeof TrackerRecordSchema>;
export const TrackerBatchSchema = z.object({
  records: z.array(TrackerRecordSchema).min(1).max(200),
});

/** Monotonic last-write-wins; equal timestamps keep the current value to prevent sync ping-pong. */
export function mergeTrackerRecord(
  current: TrackerRecord | null,
  incoming: TrackerRecord
): TrackerRecord {
  if (!current || incoming.updatedAt > current.updatedAt) return incoming;
  return current;
}

/** Create a deletion marker that wins over the record it replaces. */
export function makeTrackerTombstone(
  record: TrackerRecord,
  origin: string,
  nowEpochMs = Date.now()
): TrackerRecord {
  if (record.state === 'deleted') return record;
  return TrackerRecordSchema.parse({
    ...record,
    state: 'deleted',
    deletedState: record.deletedState ?? record.state,
    updatedAt: Math.max(nowEpochMs, record.updatedAt + 1),
    origin,
    revision: record.revision + 1,
  });
}

export type TrackerCursor = { updatedAt: number; id: string };

/** Opaque keyset cursor includes the record id so timestamp ties cannot skip items. */
export function parseTrackerCursor(value: unknown): TrackerCursor | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512)
    return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8')
    ) as Partial<TrackerCursor>;
    if (
      !Number.isSafeInteger(decoded.updatedAt) ||
      Number(decoded.updatedAt) < 1
    )
      return null;
    if (
      typeof decoded.id !== 'string' ||
      decoded.id.length < 1 ||
      decoded.id.length > 220
    )
      return null;
    return { updatedAt: Number(decoded.updatedAt), id: decoded.id };
  } catch {
    return null;
  }
}

export function makeTrackerCursor(cursor: TrackerCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}
