import assert from 'node:assert/strict';
import test from 'node:test';
import type { ParsedStream } from '../db/schemas.js';
import { isOnDemandUsenetStream } from './filterer.js';

function candidate(overrides: Partial<ParsedStream>): ParsedStream {
  return {
    id: 'candidate',
    addon: {} as ParsedStream['addon'],
    type: 'debrid',
    proxied: false,
    nzbUrl: 'https://indexer.example/release.nzb',
    service: { id: 'deepbrid', cached: false },
    ...overrides,
  } as ParsedStream;
}

test('recognises explicitly playable queued Usenet results', () => {
  assert.equal(
    isOnDemandUsenetStream(
      candidate({
        otherBehaviorHints: { aioOnDemandPlayable: true },
      })
    ),
    true
  );
});

test('does not exempt ordinary uncached or torrent results', () => {
  assert.equal(isOnDemandUsenetStream(candidate({})), false);
  assert.equal(
    isOnDemandUsenetStream(
      candidate({
        type: 'debrid',
        nzbUrl: undefined,
        torrent: { infoHash: 'abc' },
        otherBehaviorHints: { aioOnDemandPlayable: true },
      })
    ),
    false
  );
});
