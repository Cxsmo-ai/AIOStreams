import { useEffect, useState } from 'react';
import { SiTrakt } from 'react-icons/si';
import { useUserData } from '@/context/userData';
import { Alert } from '@aiostreams/ui/alert';
import { Button } from '@aiostreams/ui/button';

type DeviceFlow = {
  state: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  interval: number;
};

type LinkResponse = {
  state: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

type LinkStatus =
  | { status: 'pending'; retryAfter?: number }
  | { status: 'authorized'; authRef: string }
  | { status: 'error'; error?: string };

async function request<T>(
  path: string,
  uuid: string | null,
  password: string | null,
  init?: RequestInit,
  tracking = false
): Promise<T> {
  if (!uuid || !password) throw new Error('Sign in to this AIOStreams account first.');
  const response = await fetch(
    `${tracking ? '/api/v1/tracking/v1' : '/api/v1/trakt'}${path}`,
    {
      credentials: 'include',
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${btoa(`${uuid}:${password}`)}`,
        ...(init?.headers ?? {}),
      },
    }
  );
  const payload = (await response.json()) as T & {
    error?: { message?: string } | string;
    detail?: string;
  };
  if (!response.ok) {
    const message = typeof payload.error === 'string'
      ? payload.error
      : payload.error?.message ?? payload.detail;
    throw new Error(message || `AIOStreams request failed (${response.status})`);
  }
  return payload;
}

export function TraktTrackerCard() {
  const { userData, setUserData, uuid, password } = useUserData();
  const authRef = userData.trackerProviders?.trakt?.authRef;
  const enabled = userData.trackerProviders?.trakt?.enabled !== false;
  const [flow, setFlow] = useState<DeviceFlow | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState('urn:ietf:wg:oauth:2.0:oob');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setClientId('');
    setClientSecret('');
    setRedirectUri('urn:ietf:wg:oauth:2.0:oob');
  }, [uuid]);

  useEffect(() => {
    if (!flow) return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      try {
        const result = await request<LinkStatus>(
          `/link/status/${encodeURIComponent(flow.state)}`,
          uuid,
          password
        );
        if (cancelled) return;
        if (result.status === 'authorized') {
          setUserData((previous) => ({
            ...previous,
            trackerProviders: {
              ...previous.trackerProviders,
              trakt: { authRef: result.authRef, enabled: true },
            },
          }));
          setMessage('Trakt is linked to this saved AIOStreams configuration. Playback events and enabled tracker records now merge through AIOStreams.');
          setClientSecret('');
          setFlow(null);
          return;
        }
        if (result.status === 'error') {
          setError(result.error || 'Trakt authorization failed.');
          setFlow(null);
          return;
        }
        timer = window.setTimeout(poll, Math.max(2, result.retryAfter || flow.interval) * 1000);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Trakt link failed.');
          setFlow(null);
        }
      }
    };
    timer = window.setTimeout(poll, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [flow, password, setUserData, uuid]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await request<LinkResponse>('/link/device', uuid, password, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, clientSecret, redirectUri }),
      });
      setFlow({ ...result, expiresAt: Date.now() + result.expiresIn * 1000 });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start Trakt authorization.');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!authRef) return;
    setBusy(true);
    setError(null);
    try {
      await request(`/link/${encodeURIComponent(authRef)}`, uuid, password, { method: 'DELETE' });
      setUserData((previous) => {
        const trackerProviders = { ...previous.trackerProviders };
        delete trackerProviders.trakt;
        return { ...previous, trackerProviders };
      });
      setMessage('Trakt was disconnected.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not disconnect Trakt.');
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = (next: boolean) => {
    setUserData((previous) => ({
      ...previous,
      trackerProviders: {
        ...previous.trackerProviders,
        trakt: { ...previous.trackerProviders?.trakt, enabled: next },
      },
    }));
  };

  const syncNow = async () => {
    setSyncing(true);
    setError(null);
    setMessage(null);
    try {
      const response = await request<{ success?: boolean; data?: { imported?: number; pendingProviders?: string[]; unsupportedProviders?: string[]; unsupportedWrites?: Array<{ providerId: string; skipped: number }> } }>(
        '/refresh', uuid, password, { method: 'POST' }, true
      );
      const data = response.data;
      if (!response.success || !data) throw new Error('AIOStreams returned an incomplete tracker refresh result.');
      const pending = data.pendingProviders ?? [];
      const unsupported = data.unsupportedProviders ?? [];
      const unsupportedWrites = data.unsupportedWrites ?? [];
      setMessage(
        `Merged ${data.imported ?? 0} changed records. ${pending.length ? `Pending: ${pending.join(', ')}. ` : ''}${unsupported.length ? `No adapter: ${unsupported.join(', ')}. ` : ''}${unsupportedWrites.length ? `Some provider-specific states are not representable: ${unsupportedWrites.map((item) => `${item.providerId} (${item.skipped})`).join(', ')}.` : ''}`
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Tracker refresh failed.');
    } finally {
      setSyncing(false);
    }
  };

  const secondsLeft = flow ? Math.max(0, Math.ceil((flow.expiresAt - now) / 1000)) : 0;

  return (
    <section className="space-y-4 rounded-xl border border-[--border] bg-[--surface] p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-500/10 text-red-400 ring-1 ring-red-400/20">
              <SiTrakt className="h-5 w-5" />
            </span>
            <h3 className="text-lg font-semibold">Trakt</h3>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-[--muted]">
            Use this configuration’s Trakt app registration. Credentials are sent only to this AIOStreams server for linking and are kept in its encrypted tracker token; they are never saved in the shareable config.
          </p>
        </div>
      </div>

      <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span>Trakt client ID</span>
          <input autoComplete="off" className="w-full rounded-md border border-[--border] bg-[--surface] px-3 py-2" value={clientId} onChange={(event) => setClientId(event.target.value)} />
        </label>
        <label className="space-y-1 text-sm">
          <span>Trakt client secret</span>
          <input autoComplete="new-password" type="password" className="w-full rounded-md border border-[--border] bg-[--surface] px-3 py-2" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} />
        </label>
        <label className="space-y-1 text-sm sm:col-span-2">
          <span>Redirect URI registered with Trakt</span>
          <input autoComplete="off" className="w-full rounded-md border border-[--border] bg-[--surface] px-3 py-2" value={redirectUri} onChange={(event) => setRedirectUri(event.target.value)} />
        </label>
      </div>
      {!flow && <Button type="button" onClick={connect} loading={busy} disabled={!clientId.trim() || !clientSecret.trim() || !redirectUri.trim()}>{authRef ? 'Relink with these app credentials' : 'Connect Trakt'}</Button>}

      {error && <Alert intent="alert">{error}</Alert>}
      {message && <Alert intent="success">{message}</Alert>}

      {flow && (
        <div className="max-w-xl space-y-3 rounded-lg border border-[--border] bg-[--subtle] p-4">
          <p className="text-sm text-[--muted]">Approve this connection on Trakt. The code expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}.</p>
          <div className="rounded-md bg-[--surface] p-4 text-center">
            <p className="text-xs uppercase tracking-wide text-[--muted]">Device code</p>
            <p className="mt-1 font-mono text-3xl font-bold tracking-[0.2em]">{flow.userCode}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={() => window.open(flow.verificationUri, '_blank', 'noopener,noreferrer')}>Open Trakt approval</Button>
            <span className="text-sm text-[--muted]">Waiting for approval…</span>
            <Button type="button" intent="gray-outline" onClick={() => setFlow(null)}>Cancel</Button>
          </div>
        </div>
      )}

      {authRef && !flow && (
        <div className="flex flex-wrap items-center gap-3">
          <Alert intent="success">Trakt is linked; {enabled ? 'live sync is enabled.' : 'live sync is paused.'}</Alert>
          <Button type="button" intent={enabled ? 'gray-outline' : 'primary-outline'} onClick={() => setEnabled(!enabled)}>{enabled ? 'Pause live sync' : 'Enable live sync'}</Button>
          <Button type="button" onClick={syncNow} loading={syncing}>Refresh / merge now</Button>
          <Button type="button" intent="gray-outline" onClick={disconnect} loading={busy}>Disconnect</Button>
        </div>
      )}
      <p className="text-xs text-[--muted]">Each saved AIOStreams configuration uses its own app credentials. The secret is submitted only during device linking and then retained inside the encrypted server-side token record so Trakt refresh continues to work. Unsupported tracker-specific features are reported instead of silently claimed as synced.</p>
    </section>
  );
}
