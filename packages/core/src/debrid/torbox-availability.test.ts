import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resetTorboxAvailabilityLanesForTests,
  runTorboxAvailabilityLimited,
} from './torbox.js';

test.beforeEach(() => resetTorboxAvailabilityLanesForTests());

test('serializes TorBox availability work across service instances sharing a credential', async () => {
  let active = 0;
  let maxActive = 0;
  const order: number[] = [];
  const run = (value: number) =>
    runTorboxAvailabilityLimited(
      'shared-token',
      async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(value);
        active--;
        return value;
      },
      0
    );

  const values = await Promise.all([run(1), run(2), run(3)]);
  assert.deepEqual(values, [1, 2, 3]);
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(maxActive, 1);
});
