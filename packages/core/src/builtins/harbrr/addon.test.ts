import assert from 'node:assert/strict';
import test from 'node:test';
import { collectHarbrrResultsUntilDeadline } from './deadline.js';
import { expandHarbrrQueries } from './query-utils.js';

test('adds a countryless fallback for disambiguated TV release queries', () => {
  assert.deepEqual(
    expandHarbrrQueries(['The Mentalist US S01', 'The Mentalist S01E04']),
    [
      'The Mentalist US S01',
      'The Mentalist S01',
      'The Mentalist S01E04',
    ]
  );
});

test('keeps legitimate country tokens and duplicate queries safe', () => {
  assert.deepEqual(
    expandHarbrrQueries(['Us S01', 'Us S01', 'The Mentalist']),
    ['Us S01', 'S01', 'The Mentalist']
  );
});

test('returns completed Harbrr query results without waiting for a slow alias', async () => {
  let releaseSlow: (() => void) | undefined;
  const slow = new Promise<number[]>((resolve) => {
    releaseSlow = () => resolve([3]);
  });
  const errors: unknown[] = [];

  const results = await collectHarbrrResultsUntilDeadline(
    [Promise.resolve([1, 2]), slow],
    10,
    (error) => errors.push(error)
  );

  assert.deepEqual(results, [1, 2]);
  assert.deepEqual(errors, []);
  releaseSlow?.();
});

test('keeps successful Harbrr results when another query fails', async () => {
  const errors: unknown[] = [];
  const results = await collectHarbrrResultsUntilDeadline(
    [Promise.resolve([1]), Promise.reject(new Error('query failed'))],
    1_000,
    (error) => errors.push(error)
  );

  assert.deepEqual(results, [1]);
  assert.equal(errors.length, 1);
});

test('preserves query order when requests finish out of order', async () => {
  let resolveFirst!: (value: number[]) => void;
  const first = new Promise<number[]>((resolve) => {
    resolveFirst = resolve;
  });

  const resultsPromise = collectHarbrrResultsUntilDeadline(
    [first, Promise.resolve([2])],
    1_000
  );
  resolveFirst([1]);

  assert.deepEqual(await resultsPromise, [1, 2]);
});
