import { api } from './api';

export interface TorboxDeviceFlowView {
  flowId: string;
  flowSecret?: string;
  userCode: string;
  verificationUrl: string;
  friendlyVerificationUrl?: string;
  expiresAt: number;
  status:
    | 'waiting'
    | 'authorized'
    | 'connected'
    | 'expired'
    | 'cancelled'
    | 'failed';
  token?: string;
  settings?: Record<string, unknown>;
  error?: string;
}

export async function startTorboxDeviceFlow() {
  return api<TorboxDeviceFlowView>('POST /torbox/device/start');
}

export async function pollTorboxDeviceFlow(flowId: string, flowSecret: string) {
  return api<TorboxDeviceFlowView>('POST /torbox/device/status', {
    body: { flowId, flowSecret },
  });
}

export async function cancelTorboxDeviceFlow(
  flowId: string,
  flowSecret: string
) {
  return api<TorboxDeviceFlowView>('POST /torbox/device/cancel', {
    body: { flowId, flowSecret },
  });
}

export async function validateTorboxToken(token: string) {
  return api<{ settings: Record<string, unknown> }>('POST /torbox/validate', {
    body: { token },
  });
}

export async function updateTorboxSettings(
  token: string,
  settings: Record<string, boolean>
) {
  return api<{ settings: Record<string, unknown> }>('PUT /torbox/settings', {
    body: { token, settings },
  });
}
