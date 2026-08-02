/**
 * EBML (Matroska) primitives for the serve-path hole-fill transform. Each
 * element is `ID vint + size vint + payload`; a vint's length comes from its
 * first byte's leading-bit mask, so a 0x00 first byte is invalid.
 */

export const EBML_HEADER_ID = 0x1a45dfa3;
export const SEGMENT_ID = 0x18538067;
export const CLUSTER_ID = 0x1f43b675;
export const BLOCKGROUP_ID = 0xa0;
export const SIMPLE_BLOCK_ID = 0xa3;
export const BLOCK_ID = 0xa1;
export const TIMESTAMP_ID = 0xe7;
export const CRC32_ID = 0xbf;
export const VOID_ID = 0xec;

/** Masters the tracker descends into; every other master is skipped by size. */
export const DESCEND_MASTERS: ReadonlySet<number> = new Set([
  SEGMENT_ID,
  CLUSTER_ID,
  BLOCKGROUP_ID,
]);

/** Length (1..maxLen) of a vint from its first byte; -1 when no mask bit set. */
export function vintLen(firstByte: number, maxLen: number): number {
  for (let len = 1; len <= maxLen; len++) {
    if (firstByte & (0x80 >> (len - 1))) return len;
  }
  return -1;
}

/**
 * Element ID at `pos`, keeping its length-descriptor prefix (Cluster reads
 * back as 0x1f43b675). Null on an invalid 1..4-byte vint or short buffer.
 */
export function readElementId(
  buf: Buffer,
  pos: number
): { id: number; len: number } | null {
  if (pos >= buf.length) return null;
  const len = vintLen(buf[pos], 4);
  if (len < 0 || pos + len > buf.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + buf[pos + i];
  return { id, len };
}

/**
 * Element size vint at `pos`, marker bit stripped. `unknown` is set for the
 * reserved all-value-bits-1 ("unknown size") encoding. Null on an invalid
 * 1..8-byte vint or short buffer.
 */
export function readElementSize(
  buf: Buffer,
  pos: number
): { size: number; len: number; unknown: boolean } | null {
  if (pos >= buf.length) return null;
  const len = vintLen(buf[pos], 8);
  if (len < 0 || pos + len > buf.length) return null;
  let size = buf[pos] & (0xff >> len);
  let allOnes = size === 0xff >> len;
  for (let i = 1; i < len; i++) {
    const b = buf[pos + i];
    size = size * 256 + b;
    if (b !== 0xff) allOnes = false;
  }
  return { size, len, unknown: allOnes };
}

/**
 * Void element header (`0xEC` + size vint) whose total span (header + payload)
 * is exactly `span` bytes. The caller writes the payload separately. Throws
 * when `span < 2` or it is unencodable within 8 size bytes.
 */
export function encodeVoidHeader(span: number): Buffer {
  if (span < 2) throw new Error(`void span ${span} < 2`);
  for (let sizeLen = 1; sizeLen <= 8; sizeLen++) {
    const payload = span - 1 - sizeLen;
    if (payload < 0) continue;
    // All-ones value is reserved for "unknown size"; cap one below it.
    const max = 2 ** (7 * sizeLen) - 2;
    if (payload > max) continue;
    const out = Buffer.allocUnsafe(1 + sizeLen);
    out[0] = VOID_ID;
    let v = payload;
    for (let i = sizeLen; i >= 1; i--) {
      out[i] = v & 0xff;
      v = Math.floor(v / 256);
    }
    // Set the length-marker bit on the first size byte.
    out[1] |= 0x80 >> (sizeLen - 1);
    return out;
  }
  throw new Error(`unencodable void span ${span}`);
}
