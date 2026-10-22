import assert from 'node:assert/strict';
import test from 'node:test';
import { isBlockedAddress, isUnsafeRemoteUrl } from './url-safety.js';

test('blocks IPv4 special-purpose and non-unicast destinations', () => {
  for (const address of [
    '0.1.2.3',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.0.0.1',
    '192.0.2.1',
    '192.88.99.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
  ]) {
    assert.equal(
      isBlockedAddress(address),
      true,
      `${address} should be blocked`
    );
    assert.equal(isUnsafeRemoteUrl(`http://${address}/`), true);
  }
  assert.equal(isBlockedAddress('192.0.0.9'), false);
  assert.equal(isBlockedAddress('192.0.0.10'), false);
  assert.equal(isBlockedAddress('::ffff:192.0.0.9'), false);
  assert.equal(isBlockedAddress('::ffff:192.0.0.10'), false);
});

test('blocks non-global IPv6 special-purpose destinations', () => {
  for (const address of [
    '::',
    '::1',
    '::192.168.1.1',
    '64:ff9b:1::1',
    '100::1',
    '2001::1',
    '2001:2::1',
    '2001:10::1',
    '2001:100::1',
    '2001:db8::1',
    '2002::1',
    '3fff::1',
    '5f00::1',
    '100:0:0:1::1',
    'fc00::1',
    'fe80::1',
    'fec0::1',
    'ff02::1',
  ]) {
    assert.equal(
      isBlockedAddress(address),
      true,
      `${address} should be blocked`
    );
    assert.equal(isUnsafeRemoteUrl(`http://[${address}]/`), true);
  }
});

test('checks IPv4-mapped IPv6 against the embedded IPv4 address', () => {
  assert.equal(isBlockedAddress('::ffff:192.168.1.1'), true);
  assert.equal(isBlockedAddress('::ffff:c0a8:101'), true);
  assert.equal(isBlockedAddress('::ffff:8.8.8.8'), false);
});

test('continues allowing ordinary public IPs and rejects non-HTTP schemes', () => {
  assert.equal(isUnsafeRemoteUrl('https://8.8.8.8/health'), false);
  assert.equal(isUnsafeRemoteUrl('https://[2606:4700:4700::1111]/'), false);
  // These allocations are explicitly globally reachable in the IANA registry.
  assert.equal(isBlockedAddress('2001:1::1'), false);
  assert.equal(isBlockedAddress('2001:1::2'), false);
  assert.equal(isBlockedAddress('2001:1::3'), false);
  assert.equal(isBlockedAddress('2001:3::1'), false);
  assert.equal(isBlockedAddress('2001:4:112::1'), false);
  assert.equal(isBlockedAddress('2001:20::1'), false);
  assert.equal(isBlockedAddress('2001:30::1'), false);
  assert.equal(isUnsafeRemoteUrl('file:///etc/passwd'), true);
});
