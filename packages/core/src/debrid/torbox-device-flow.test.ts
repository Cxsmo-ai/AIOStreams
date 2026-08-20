import assert from 'node:assert/strict';
import test from 'node:test';
import { TorboxDeviceFlowService } from './torbox-device-flow.js';

test('keeps the device code server-side and enforces flow ownership', async () => {
  let now = 1_000;
  let polls = 0;
  const client = {
    async startDeviceAuthorization() {
      return {
        deviceCode: 'server-only-device-code',
        userCode: 'ABCD-1234',
        verificationUrl: 'https://torbox.app/link',
        friendlyVerificationUrl: 'torbox.app/link',
        intervalMs: 5_000,
        expiresAt: 61_000,
      };
    },
    async pollDeviceAuthorization() {
      polls += 1;
      return { status: 'waiting' as const };
    },
    async getUserSettings() {
      throw new Error('not authorized');
    },
  };
  const flows = new TorboxDeviceFlowService(client as any, () => now);
  const started = await flows.start();
  assert.equal((started as any).deviceCode, undefined);
  assert.ok(started.flowSecret);
  await assert.rejects(
    flows.status(started.flowId, 'wrong-secret'),
    /not found/
  );
  await flows.status(started.flowId, started.flowSecret!);
  await flows.status(started.flowId, started.flowSecret!);
  assert.equal(polls, 1, 'poll interval must be enforced server-side');
  now += 5_000;
  await flows.status(started.flowId, started.flowSecret!);
  assert.equal(polls, 2);
});

test('returns a token only after authorization and account validation', async () => {
  const client = {
    async startDeviceAuthorization() {
      return {
        deviceCode: 'device-code',
        userCode: 'CODE',
        verificationUrl: 'https://torbox.app/link',
        intervalMs: 1_000,
        expiresAt: 99_000,
      };
    },
    async pollDeviceAuthorization() {
      return { status: 'authorized' as const, token: 'validated-token' };
    },
    async getUserSettings(token: string) {
      assert.equal(token, 'validated-token');
      return {
        user: { id: 1 },
        settings: {
          stremio_wait_for_download_torrent: true,
          stremio_wait_for_download_usenet: false,
        },
      };
    },
  };
  const flows = new TorboxDeviceFlowService(client as any, () => 1_000);
  const started = await flows.start();
  const connected = await flows.status(started.flowId, started.flowSecret!);
  assert.equal(connected.status, 'connected');
  assert.equal(connected.token, 'validated-token');
  assert.equal(connected.settings?.stremio_wait_for_download_torrent, true);
  const cancelled = flows.cancel(started.flowId, started.flowSecret!);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.token, undefined);
});

test('expires an unapproved flow without polling TorBox again', async () => {
  let polls = 0;
  const client = {
    async startDeviceAuthorization() {
      return {
        deviceCode: 'device-code',
        userCode: 'CODE',
        verificationUrl: 'https://torbox.app/link',
        intervalMs: 1_000,
        expiresAt: 500,
      };
    },
    async pollDeviceAuthorization() {
      polls += 1;
      return { status: 'waiting' as const };
    },
  };
  const flows = new TorboxDeviceFlowService(client as any, () => 1_000);
  const started = await flows.start();
  const status = await flows.status(started.flowId, started.flowSecret!);
  assert.equal(status.status, 'expired');
  assert.equal(status.token, undefined);
  assert.equal(polls, 0);
});
