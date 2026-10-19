import { useEffect, useState } from 'react';
import { useUserData } from '@/context/userData';
import { Alert } from '../../../ui/alert';
import { Button } from '../../../ui/button';

type ApiResult = {
  success?: boolean;
  authRef?: string;
  data?: {
    imported?: number;
    syncedProviders?: string[];
    pendingProviders?: string[];
  };
  error?: string | { message?: string };
  detail?: string;
};

async function request<T extends ApiResult>(
  path: string,
  uuid: string | null,
  password: string | null,
  init?: RequestInit
): Promise<T> {
  if (!uuid || !password)
    throw new Error('Sign in to this AIOStreams account first.');
  const response = await fetch(`/api/v1/floppy${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${btoa(`${uuid}:${password}`)}`,
      ...(init?.headers ?? {}),
    },
  });
  const payload = (await response.json()) as T;
  if (!response.ok) {
    const message = typeof payload.error === 'string'
      ? payload.error
      : payload.error?.message ?? payload.detail;
    throw new Error(message || `AIOStreams request failed (${response.status})`);
  }
  return payload;
}

export function FloppyTrackerCard() {
  const { userData, setUserData, uuid, password } = useUserData();
  const provider = userData.trackerProviders?.floppy;
  const authRef = provider?.authRef;
  const enabled = provider?.enabled !== false;
  const [baseUrl, setBaseUrl] = useState(
    provider?.baseUrl ?? 'https://floppy.deepascension.net'
  );
  const [apiToken, setApiToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setBaseUrl(provider?.baseUrl ?? 'https://floppy.deepascension.net');
    setApiToken('');
  }, [uuid, provider?.baseUrl]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await request<ApiResult>('/link', uuid, password, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, apiToken }),
      });
      if (!result.authRef) throw new Error('Floppy did not return an account link.');
      const normalizedBaseUrl = new URL(baseUrl.trim()).toString().replace(/\/$/, '');
      setUserData((previous) => ({
        ...previous,
        trackerProviders: {
          ...previous.trackerProviders,
          floppy: { enabled: true, authRef: result.authRef, baseUrl: normalizedBaseUrl },
        },
      }));
      setApiToken('');
      setMessage('Floppy is connected to this AIOStreams profile. Tracker refresh will merge its library, ratings, history and resume positions with your other enabled providers.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not connect Floppy.');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!authRef) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await request(`/link/${encodeURIComponent(authRef)}`, uuid, password, {
        method: 'DELETE',
      });
      setUserData((previous) => {
        const trackerProviders = { ...previous.trackerProviders };
        delete trackerProviders.floppy;
        return { ...previous, trackerProviders };
      });
      setMessage('Floppy was disconnected from this AIOStreams profile.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not disconnect Floppy.');
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    setError(null);
    setMessage(null);
    try {
      const result = await fetch('/api/v1/tracking/v1/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { Authorization: `Basic ${btoa(`${uuid}:${password}`)}` },
      });
      const payload = (await result.json()) as ApiResult;
      if (!result.ok || !payload.success)
        throw new Error(
          payload.data?.pendingProviders?.length
            ? `Sync is waiting for: ${payload.data.pendingProviders.join(', ')}`
            : typeof payload.error === 'string'
              ? payload.error
              : 'AIOStreams could not complete the merged tracker refresh.'
        );
      setMessage(`Merged ${payload.data?.imported ?? 0} tracker changes from the enabled providers.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Floppy sync failed.');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <section className="rounded-lg border border-gray-700 bg-gray-900/40 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-500/15 font-bold text-indigo-300">F</span>
          <div>
            <h3 className="font-semibold">Floppy</h3>
            <p className="text-sm text-gray-400">Official Floppy REST API · merged tracker</p>
          </div>
        </div>
        {authRef && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) =>
                setUserData((previous) => ({
                  ...previous,
                  trackerProviders: {
                    ...previous.trackerProviders,
                    floppy: { ...previous.trackerProviders?.floppy, enabled: event.target.checked },
                  },
                }))
              }
            />
            Enabled
          </label>
        )}
      </div>

      {authRef ? (
        <div className="space-y-3">
          <p className="text-sm text-green-300">Connected to {provider?.baseUrl ?? 'Floppy'} for this AIOStreams profile.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" intent="primary" onClick={() => void syncNow()} disabled={syncing || !enabled} loading={syncing}>
              Sync all trackers
            </Button>
            <Button type="button" intent="gray-outline" onClick={() => void disconnect()} disabled={busy} loading={busy}>
              Disconnect
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <label className="block space-y-1 text-sm">
            <span>Floppy server URL</span>
            <input
              type="url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://floppy.example.com"
              autoComplete="url"
              className="w-full rounded-md border border-gray-700 bg-gray-950 px-3 py-2"
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>Floppy API token</span>
            <input
              type="password"
              value={apiToken}
              onChange={(event) => setApiToken(event.target.value)}
              placeholder="Paste the token from Floppy → Settings → Integrations"
              autoComplete="new-password"
              className="w-full rounded-md border border-gray-700 bg-gray-950 px-3 py-2"
            />
          </label>
          <p className="text-xs text-gray-400">The token is encrypted in AIOStreams server storage and scoped to this profile; it is not added to addon URLs or config exports.</p>
          <Button type="button" intent="primary" onClick={() => void connect()} disabled={busy || !apiToken.trim()} loading={busy}>
            Connect Floppy
          </Button>
        </div>
      )}

      {error && <Alert intent="alert">{error}</Alert>}
      {message && <Alert intent="success">{message}</Alert>}
    </section>
  );
}
