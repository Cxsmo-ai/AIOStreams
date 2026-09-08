import { useEffect, useMemo, useState } from 'react';
import { Alert } from '../../../ui/alert';
import { Button } from '../../../ui/button';
import { Modal } from '../../../ui/modal';

interface FloatplaneDeviceFlow {
  state: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  interval: number;
}

interface Props {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  values: Record<string, any>;
  onSubmit: (values: Record<string, any>) => void;
  onClose: () => void;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/floatplane${path}`, {
    credentials: 'include',
    ...init,
    headers: { Accept: 'application/json', ...(init?.headers || {}) },
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(data.error || `Floatplane request failed (${response.status})`);
  }
  return data;
}

function remaining(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function FloatplaneServiceModal({
  open,
  onOpenChange,
  values,
  onSubmit,
  onClose,
}: Props) {
  const [localValues, setLocalValues] = useState<Record<string, any>>({});
  const [flow, setFlow] = useState<FloatplaneDeviceFlow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!open) return;
    setLocalValues(values);
    setFlow(null);
    setError(null);
    setNow(Date.now());
  }, [open, values]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open || !flow || Date.now() >= flow.expiresAt) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await request<
          | { status: 'pending'; retryAfter?: number }
          | { status: 'authorized'; authRef: string }
          | { status: 'error'; error?: string }
        >(`/link/status/${encodeURIComponent(flow.state)}`);
        if (cancelled) return;
        if (result.status === 'authorized') {
          // The reference is intentionally opaque. The real tokens remain in
          // the server-side encrypted store and are never copied to a URL.
          onSubmit({ ...localValues, authRef: result.authRef });
          return;
        }
        if (result.status === 'error') {
          setError(result.error || 'Floatplane authorization failed');
          setFlow(null);
          return;
        }
        window.setTimeout(poll, Math.max(2, result.retryAfter || flow.interval) * 1000);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Floatplane link failed');
          setFlow(null);
        }
      }
    };
    const timer = window.setTimeout(poll, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, flow, localValues, onSubmit]);

  const connected = typeof localValues.authRef === 'string' && localValues.authRef.length > 0;
  const expiresIn = useMemo(
    () => (flow ? remaining(flow.expiresAt, now) : '0:00'),
    [flow, now]
  );

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await request<{
        state: string;
        userCode: string;
        verificationUri: string;
        expiresIn: number;
        interval: number;
      }>('/link/device', { method: 'POST' });
      setFlow({
        ...result,
        expiresAt: Date.now() + result.expiresIn * 1000,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to start link');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Configure Floatplane">
      <div className="space-y-4">
        {error && <Alert intent="alert">{error}</Alert>}

        {!connected && !flow && (
          <div className="space-y-3 text-center">
            <p className="text-sm text-[--muted]">
              Link Floatplane with its official device-code flow. No token or
              signed video URL is copied into your addon configuration.
            </p>
            <Button type="button" onClick={connect} loading={busy}>
              Connect Floatplane
            </Button>
          </div>
        )}

        {flow && (
          <div className="space-y-3 text-center">
            <p className="text-sm text-[--muted]">
              Open Floatplane, approve this device, then return here.
            </p>
            <div className="rounded-lg border border-[--border] bg-[--subtle] p-4">
              <p className="text-xs text-[--muted]">Device code</p>
              <div className="mt-1 text-4xl font-mono font-bold tracking-[0.25em]">
                {flow.userCode}
              </div>
            </div>
            <Button
              type="button"
              onClick={() => window.open(flow.verificationUri, '_blank', 'noopener,noreferrer')}
            >
              Open Floatplane verification
            </Button>
            <p className="text-xs break-all text-[--muted]">{flow.verificationUri}</p>
            <p className="text-sm">Waiting for authorization…</p>
            <p className="text-xs text-[--muted]">Expires in {expiresIn}</p>
            <Button
              type="button"
              intent="primary-outline"
              onClick={() => setFlow(null)}
            >
              Cancel
            </Button>
          </div>
        )}

        {connected && !flow && (
          <>
            <Alert intent="success">✓ Floatplane Connected</Alert>
            <p className="text-sm text-[--muted]">
              This account is stored as an encrypted server-side reference and
              is available to Floatplane addons generated from this config.
            </p>
            <div className="flex gap-2">
              <Button type="button" intent="primary-outline" onClick={connect}>
                Relink
              </Button>
              <Button
                type="button"
                intent="gray-outline"
                onClick={() => onSubmit({ ...localValues, authRef: undefined })}
              >
                Disconnect
              </Button>
            </div>
          </>
        )}

        {!flow && (
          <Button type="button" className="w-full" intent="primary-outline" onClick={onClose}>
            Close
          </Button>
        )}
      </div>
    </Modal>
  );
}
