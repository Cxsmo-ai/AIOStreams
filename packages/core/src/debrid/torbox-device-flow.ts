import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { TorboxClient, type TorboxUserSettings } from './torbox-client.js';

export type TorboxDeviceFlowStatus =
  | 'waiting'
  | 'authorized'
  | 'connected'
  | 'expired'
  | 'cancelled'
  | 'failed';

interface TorboxDeviceFlowRecord {
  flowId: string;
  verifierHash: Buffer;
  deviceCode?: string;
  userCode: string;
  verificationUrl: string;
  friendlyVerificationUrl?: string;
  intervalMs: number;
  expiresAt: number;
  nextPollAt: number;
  status: TorboxDeviceFlowStatus;
  token?: string;
  settings?: TorboxUserSettings;
  error?: string;
}

export interface TorboxDeviceFlowView {
  flowId: string;
  flowSecret?: string;
  userCode: string;
  verificationUrl: string;
  friendlyVerificationUrl?: string;
  expiresAt: number;
  status: TorboxDeviceFlowStatus;
  token?: string;
  settings?: TorboxUserSettings;
  error?: string;
}

function verifierHash(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export class TorboxDeviceFlowService {
  private readonly flows = new Map<string, TorboxDeviceFlowRecord>();

  constructor(
    private readonly client = new TorboxClient(),
    private readonly now: () => number = Date.now,
    private readonly maxFlows = 1000
  ) {}

  private cleanup(): void {
    const now = this.now();
    for (const [id, flow] of this.flows) {
      if (flow.expiresAt + 60_000 < now) this.flows.delete(id);
    }
    while (this.flows.size >= this.maxFlows) {
      const oldest = this.flows.keys().next().value;
      if (!oldest) break;
      this.flows.delete(oldest);
    }
  }

  private getOwned(flowId: string, flowSecret: string): TorboxDeviceFlowRecord {
    const flow = this.flows.get(flowId);
    const supplied = verifierHash(flowSecret);
    if (!flow || !timingSafeEqual(flow.verifierHash, supplied)) {
      throw new Error('TorBox device flow not found');
    }
    return flow;
  }

  private view(
    flow: TorboxDeviceFlowRecord,
    options?: { flowSecret?: string; includeToken?: boolean }
  ): TorboxDeviceFlowView {
    return {
      flowId: flow.flowId,
      flowSecret: options?.flowSecret,
      userCode: flow.userCode,
      verificationUrl: flow.verificationUrl,
      friendlyVerificationUrl: flow.friendlyVerificationUrl,
      expiresAt: flow.expiresAt,
      status: flow.status,
      token: options?.includeToken ? flow.token : undefined,
      settings: flow.settings,
      error: flow.error,
    };
  }

  async start(): Promise<TorboxDeviceFlowView> {
    this.cleanup();
    const started = await this.client.startDeviceAuthorization('AIOStreams');
    const flowId = randomUUID();
    const flowSecret = randomBytes(32).toString('base64url');
    const flow: TorboxDeviceFlowRecord = {
      flowId,
      verifierHash: verifierHash(flowSecret),
      deviceCode: started.deviceCode,
      userCode: started.userCode,
      verificationUrl: started.verificationUrl,
      friendlyVerificationUrl: started.friendlyVerificationUrl,
      intervalMs: started.intervalMs,
      expiresAt: started.expiresAt,
      nextPollAt: this.now(),
      status: 'waiting',
    };
    this.flows.set(flowId, flow);
    return this.view(flow, { flowSecret });
  }

  async status(
    flowId: string,
    flowSecret: string
  ): Promise<TorboxDeviceFlowView> {
    const flow = this.getOwned(flowId, flowSecret);
    const now = this.now();
    if (flow.status === 'waiting' && now >= flow.expiresAt) {
      flow.status = 'expired';
      flow.deviceCode = undefined;
    }
    if (
      flow.status === 'waiting' &&
      flow.deviceCode &&
      now >= flow.nextPollAt
    ) {
      flow.nextPollAt = now + flow.intervalMs;
      try {
        const result = await this.client.pollDeviceAuthorization(
          flow.deviceCode
        );
        if (result.status === 'authorized') {
          flow.status = 'authorized';
          const account = await this.client.getUserSettings(result.token);
          flow.token = result.token;
          flow.settings = account.settings;
          flow.deviceCode = undefined;
          flow.status = 'connected';
        }
      } catch (error) {
        flow.status = 'failed';
        flow.deviceCode = undefined;
        flow.error =
          error instanceof Error
            ? error.message
            : 'TorBox authorization failed';
      }
    }
    return this.view(flow, { includeToken: flow.status === 'connected' });
  }

  cancel(flowId: string, flowSecret: string): TorboxDeviceFlowView {
    const flow = this.getOwned(flowId, flowSecret);
    flow.status = 'cancelled';
    flow.deviceCode = undefined;
    flow.token = undefined;
    return this.view(flow);
  }
}

export const torboxDeviceFlows = new TorboxDeviceFlowService();
