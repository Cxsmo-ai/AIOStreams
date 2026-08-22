import assert from 'node:assert/strict';
import test from 'node:test';
import { constants } from '../../utils/index.js';
import {
  deduplicateLibraryItems,
  type CatalogItem,
} from './catalog.js';

const item = (overrides: Partial<CatalogItem>): CatalogItem => ({
  id: '1',
  name: 'Big Buck Bunny 1080p WEB-DL',
  status: 'cached',
  serviceId: constants.TORBOX_SERVICE,
  serviceCredential: 'test',
  itemType: 'torrent',
  ...overrides,
});

test('library dedupe collapses duplicate provider rows', () => {
  const result = deduplicateLibraryItems([
    item({ id: '1', size: 1_000, files: [] }),
    item({ id: '2', size: 1_000, files: [{ id: 1, name: 'video.mkv' }] }),
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, '2');
});

test('library dedupe keeps different release sizes', () => {
  const result = deduplicateLibraryItems([
    item({ id: '1', size: 1_000 }),
    item({ id: '2', size: 2_000 }),
  ]);

  assert.equal(result.length, 2);
});

test('library dedupe collapses equal hashes even when names differ', () => {
  const result = deduplicateLibraryItems([
    item({ id: '1', hash: 'ABC123', name: 'Release A', size: 1_000 }),
    item({ id: '2', hash: 'abc123', name: 'Release B', size: 1_000 }),
  ]);

  assert.equal(result.length, 1);
});
