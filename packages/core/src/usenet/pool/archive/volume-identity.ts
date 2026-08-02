/**
 * Content-derived RAR volume identity, for sets whose FILENAMES carry no volume
 * scheme: fully obfuscated posts leave a random extension-less stem in both the
 * subject and the yEnc name and ship no PAR2, so name-based grouping
 * ({@link ./archive-volume.js}) places nothing and the archive is never opened.
 * Each volume still names its inner file and flags its place in the split
 * chain, which is enough to rebuild the set.
 *
 * RAR only: split-7z volumes past `.7z.001` carry no header at all.
 */
import type { ArchiveSetSpec } from './open/sets.js';
import type { RandomAccess } from './random-access.js';
import { parseRar4Block } from './rar/rar4.js';
import { parseRar5Block } from './rar/rar5.js';
import { scanSignature } from './rar/scan.js';
import type { VolumeCtx } from './rar/types.js';

/**
 * Blocks to walk before giving up on the volume's first file header: a volume
 * opens with its main header and at most a few service records.
 */
const MAX_IDENTITY_BLOCKS = 16;

/**
 * Backstop for a head-only parse: the volume range is bounded at the head's
 * length so every window lands inside it, and EOF here catches anything that
 * would still have reached past. Identification must never fetch.
 */
const NO_COLD_READS: RandomAccess = {
  size: () => 0,
  readAt: async () => Buffer.alloc(0),
};

export interface RarVolumeIdentity {
  version: 4 | 5;
  /** Inner path from this volume's first file header. */
  innerName: string;
  /** Inner file's total decoded size; identical across the set's volumes. */
  innerSize: number;
  /**
   * Ordinal from the volume's main header. RAR5 only: RAR4 states its ordinal
   * in the end-of-archive record at the volume's tail, which the probe does not
   * fetch, so RAR4 sets fall back to NZB order (as they already did when
   * grouped by name).
   */
  volumeNumber?: number;
  isFirstVolume: boolean;
  /** The inner file began in an earlier volume (RAR4 `LHD_SPLIT_BEFORE`). */
  continuedFromPrevious: boolean;
  /** The inner file runs on into the next volume (RAR4 `LHD_SPLIT_AFTER`). */
  continuesInNext: boolean;
}

/**
 * Read a volume's identity out of its probed head. Returns undefined when the
 * head is not a RAR volume, its headers are encrypted, or no file header sits
 * within the probed prefix.
 */
export async function identifyRarVolume(
  head: Buffer
): Promise<RarVolumeIdentity | undefined> {
  const sig = scanSignature(head, 0);
  if (!sig) return undefined;
  const ctx: VolumeCtx = {
    range: { start: 0, end: head.length },
    head,
    perVolume: true,
  };

  let abs = sig.dataStart;
  let volumeNumber: number | undefined;
  let isFirstVolume = false;
  for (let i = 0; i < MAX_IDENTITY_BLOCKS && abs < head.length; i++) {
    const res =
      sig.version === 5
        ? await parseRar5Block(NO_COLD_READS, ctx, abs)
        : await parseRar4Block(NO_COLD_READS, ctx, abs);
    if (!res) return undefined;
    if (res.kind === 'end') return undefined;
    if (res.kind === 'other') {
      // Header encryption hides the inner name.
      if (res.headerCrypt) return undefined;
      if (res.archiveVolumeNumber !== undefined) {
        volumeNumber = res.archiveVolumeNumber;
      }
      if (res.archiveIsFirstVolume !== undefined) {
        isFirstVolume = res.archiveIsFirstVolume;
      }
      if (res.next <= abs) return undefined;
      abs = res.next;
      continue;
    }
    if (res.file.isDir) {
      if (res.next <= abs) return undefined;
      abs = res.next;
      continue;
    }
    return {
      version: sig.version,
      innerName: res.file.name,
      innerSize: res.file.unpSize,
      volumeNumber,
      isFirstVolume,
      continuedFromPrevious: !res.file.first,
      continuesInNext: !res.file.last,
    };
  }
  return undefined;
}

export interface IdentifiedFile {
  /** NZB file index. */
  index: number;
  identity: RarVolumeIdentity;
}

/** Order that satisfies the header ordinals, or null when they don't resolve one. */
function orderByVolumeNumber(
  members: IdentifiedFile[]
): IdentifiedFile[] | null {
  // A first volume states ordinal 0 by omitting the field.
  const ordinalOf = (m: IdentifiedFile): number | undefined =>
    m.identity.volumeNumber ?? (m.identity.isFirstVolume ? 0 : undefined);
  const withOrdinal = members.map((m) => ({ m, n: ordinalOf(m) }));
  if (withOrdinal.some((x) => x.n === undefined)) return null;
  const sorted = withOrdinal.sort((a, b) => a.n! - b.n!);
  // Ordinals must be a gapless run, else a volume is missing or duplicated and
  // the concatenation would be silently wrong.
  const base = sorted[0].n!;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].n !== base + i) return null;
  }
  return sorted.map((x) => x.m);
}

/**
 * Whether the members form one complete split chain: it starts once, ends once,
 * and every volume between continues it. This is the membership proof, so
 * anything short of it drops the group rather than guessing.
 */
function isCompleteChain(ordered: IdentifiedFile[]): boolean {
  return ordered.every((m, i) => {
    const { continuedFromPrevious, continuesInNext } = m.identity;
    return (
      continuedFromPrevious === i > 0 &&
      continuesInNext === i < ordered.length - 1
    );
  });
}

/**
 * Rebuild RAR sets from volume identities. Callers pass only the files that
 * name-based grouping could not place, so this never competes with it.
 *
 * Members are keyed on the inner file they carry, which every volume of a split
 * RAR repeats, then ordered by the ordinals the volumes state where they all
 * have one and by NZB position otherwise.
 */
export function groupByVolumeIdentity(
  files: IdentifiedFile[]
): ArchiveSetSpec[] {
  const byInner = new Map<string, IdentifiedFile[]>();
  for (const f of files) {
    const key = `${f.identity.innerName}\0${f.identity.innerSize}`;
    const group = byInner.get(key);
    if (group) group.push(f);
    else byInner.set(key, [f]);
  }

  const sets: ArchiveSetSpec[] = [];
  for (const group of byInner.values()) {
    const byPosition = [...group].sort((a, b) => a.index - b.index);
    const ordered = orderByVolumeNumber(group) ?? byPosition;
    if (!isCompleteChain(ordered)) continue;
    // A lone volume must claim to BE a whole archive, else a middle volume of a
    // set whose inner files don't span volumes passes the chain test alone.
    if (ordered.length === 1 && !ordered[0].identity.isFirstVolume) continue;
    // More than one volume claiming to be the first means two archives got
    // merged on a shared inner name (reposts, fills).
    if (ordered.filter((m) => m.identity.isFirstVolume).length > 1) continue;
    sets.push({
      kind: 'rar',
      index: ordered[0].index,
      memberIndices: ordered.map((m) => m.index),
    });
  }
  return sets;
}
