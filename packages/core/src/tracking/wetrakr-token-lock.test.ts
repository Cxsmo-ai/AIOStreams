import assert from 'node:assert/strict';
import test from 'node:test';
import { withWeTrakrTokenLock } from './wetrakr-token-lock.js';

test('same-account refresh and unlink mutations serialize, while other accounts proceed', async () => {
  let beginFirst!: () => void;
  let releaseFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    beginFirst = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const order: string[] = [];

  const refresh = withWeTrakrTokenLock('account-a', async () => {
    order.push('refresh-start');
    beginFirst();
    await firstGate;
    order.push('refresh-save');
  });
  await firstStarted;

  const unlink = withWeTrakrTokenLock('account-a', async () => {
    order.push('unlink-delete');
  });
  const otherAccount = withWeTrakrTokenLock('account-b', async () => {
    order.push('other-account');
  });
  await otherAccount;

  assert.deepEqual(order, ['refresh-start', 'other-account']);
  releaseFirst();
  await Promise.all([refresh, unlink]);
  assert.deepEqual(order, [
    'refresh-start',
    'other-account',
    'refresh-save',
    'unlink-delete',
  ]);
});
