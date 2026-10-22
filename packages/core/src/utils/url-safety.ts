import { isIP } from 'node:net';

function parseIpv4(host: string): number | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = ((value << 8) | octet) >>> 0;
  }
  return value;
}

function ipv4(address: string): number {
  return parseIpv4(address)!;
}

const BLOCKED_IPV4_RANGES: Array<[number, number]> = [
  [ipv4('0.0.0.0'), 8],
  [ipv4('10.0.0.0'), 8],
  [ipv4('100.64.0.0'), 10],
  [ipv4('127.0.0.0'), 8],
  [ipv4('169.254.0.0'), 16],
  [ipv4('172.16.0.0'), 12],
  [ipv4('192.168.0.0'), 16],
  // IANA special-purpose, documentation, benchmarking and non-unicast space.
  // These ranges are not suitable destinations for user-controlled HTTP fetches.
  [ipv4('192.0.0.0'), 24],
  [ipv4('192.0.2.0'), 24],
  [ipv4('192.88.99.0'), 24],
  [ipv4('198.18.0.0'), 15],
  [ipv4('198.51.100.0'), 24],
  [ipv4('203.0.113.0'), 24],
  [ipv4('224.0.0.0'), 4],
  [ipv4('240.0.0.0'), 4],
];

// IANA marks these anycast destinations as globally reachable despite their
// containing the otherwise non-global 192.0.0.0/24 protocol-assignment block.
const ALLOWED_IPV4_EXCEPTIONS = new Set([
  ipv4('192.0.0.9'),
  ipv4('192.0.0.10'),
]);

function isBlockedIpv4Value(value: number): boolean {
  if (ALLOWED_IPV4_EXCEPTIONS.has(value)) return false;
  return BLOCKED_IPV4_RANGES.some(([base, prefix]) => {
    const mask = (-1 << (32 - prefix)) >>> 0;
    return (value & mask) >>> 0 === (base & mask) >>> 0;
  });
}

function isBlockedIpv4(host: string): boolean {
  const value = parseIpv4(host);
  return value !== null && isBlockedIpv4Value(value);
}

function parseIpv6(host: string): bigint | null {
  if (isIP(host) !== 6) return null;
  let input = host;
  const lastColon = input.lastIndexOf(':');
  const dotted = input.slice(lastColon + 1);
  if (dotted.includes('.')) {
    const v4 = parseIpv4(dotted);
    if (v4 === null) return null;
    input = `${input.slice(0, lastColon)}:${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const halves = input.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half: string) =>
    half ? half.split(':').map((part) => parseInt(part, 16)) : [];
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? '');
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill(0), ...right];
  if (
    groups.length !== 8 ||
    groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)
  )
    return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n);
}

function inIpv6Range(value: bigint, base: bigint, prefix: number): boolean {
  const mask = ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
  return (value & mask) === (base & mask);
}

const BLOCKED_IPV6_RANGES: Array<[bigint, number]> = [
  [0n, 96], // unspecified, loopback, and deprecated IPv4-compatible space
  [0x0064ff9b000100000000000000000000n, 48], // local-use NAT64
  [0x01000000000000000000000000000000n, 64], // discard-only
  [0x20010db8000000000000000000000000n, 32], // documentation
  [0x20020000000000000000000000000000n, 16], // deprecated 6to4
  [0x3fff0000000000000000000000000000n, 20], // documentation
  [0x5f000000000000000000000000000000n, 16], // SRv6 segment identifiers
  [0xfc000000000000000000000000000000n, 7], // unique-local
  [0xfe800000000000000000000000000000n, 10], // link-local
  [0xfec00000000000000000000000000000n, 10], // deprecated site-local
  [0xff000000000000000000000000000000n, 8], // multicast
  [0x01000000000000010000000000000000n, 64], // dummy IPv6 prefix
];

const IETF_PROTOCOL_ASSIGNMENTS = 0x20010000000000000000000000000000n;
const GLOBALLY_REACHABLE_IETF_EXCEPTIONS: Array<[bigint, number]> = [
  [0x20010001000000000000000000000001n, 128], // PCP Anycast
  [0x20010001000000000000000000000002n, 128], // TURN Anycast
  [0x20010001000000000000000000000003n, 128], // DNS-SD Anycast
  [0x20010003000000000000000000000000n, 32], // AMT
  [0x20010004011200000000000000000000n, 48], // AS112-v6
  [0x20010020000000000000000000000000n, 28], // ORCHIDv2
  [0x20010030000000000000000000000000n, 28], // Drone Remote ID
];

function isBlockedIpv6(host: string): boolean {
  const value = parseIpv6(host);
  if (value === null) return true;

  // IPv4-mapped IPv6 (including the URL parser's compressed hex form).
  if (inIpv6Range(value, 0xffffn << 32n, 96)) {
    return isBlockedIpv4Value(Number(value & 0xffffffffn));
  }

  // The IANA parent prefix is non-global except for more-specific allocations.
  if (inIpv6Range(value, IETF_PROTOCOL_ASSIGNMENTS, 23)) {
    return !GLOBALLY_REACHABLE_IETF_EXCEPTIONS.some(([base, prefix]) =>
      inIpv6Range(value, base, prefix)
    );
  }

  return BLOCKED_IPV6_RANGES.some(([base, prefix]) =>
    inIpv6Range(value, base, prefix)
  );
}

export function isBlockedAddress(address: string): boolean {
  const host = address.replace(/^\[|\]$/g, '').toLowerCase();
  return host.includes(':') ? isBlockedIpv6(host) : isBlockedIpv4(host);
}

/**
 * http(s) only and no private, special-purpose, non-unicast, link-local or
 * documentation IP targets. DNS-resolved addresses are checked separately by
 * the connection guard; this function checks literal IPs and local hostnames.
 */
export function isUnsafeRemoteUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return true;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.includes(':')) return isBlockedIpv6(host);
  return isBlockedIpv4(host);
}
