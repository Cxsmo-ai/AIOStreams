import { useEffect, useMemo, useState } from 'react';
import { LANGUAGES } from '../../../../../../core/src/utils/constants';
import { Alert } from '../../../ui/alert';
import { Button } from '../../../ui/button';
import { Modal } from '../../../ui/modal';
import { Switch } from '../../../ui/switch';
import TemplateOption from '../../../shared/template-option';
import {
  cancelTorboxDeviceFlow,
  pollTorboxDeviceFlow,
  startTorboxDeviceFlow,
  updateTorboxSettings,
  validateTorboxToken,
  type TorboxDeviceFlowView,
} from '@/lib/torbox-api';

interface Props {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  values: Record<string, any>;
  onSubmit: (values: Record<string, any>) => void;
  onClose: () => void;
}

const languageOptions = LANGUAGES.map((language) => ({
  label: language,
  value: language,
}));

function bool(value: unknown, fallback = false): boolean {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return fallback;
}

function mmss(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

export function TorboxServiceModal({
  open,
  onOpenChange,
  values,
  onSubmit,
  onClose,
}: Props) {
  const [localValues, setLocalValues] = useState<Record<string, any>>({});
  const [flow, setFlow] = useState<TorboxDeviceFlowView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!open) return;
    setLocalValues({
      playbackQuality: 'native',
      audioLanguage: 'auto',
      subtitleLanguage: 'off',
      ...values,
    });
    setFlow(null);
    setError(null);
  }, [open, values]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (
      !open ||
      flow?.status !== 'waiting' ||
      !flow.flowSecret ||
      Date.now() >= flow.expiresAt
    ) {
      return;
    }
    const timer = window.setInterval(async () => {
      try {
        const next = await pollTorboxDeviceFlow(flow.flowId, flow.flowSecret!);
        setFlow((current) => ({
          ...next,
          flowSecret: current?.flowSecret,
        }));
        if (next.status === 'connected' && next.token) {
          const settings = next.settings ?? {};
          setLocalValues((current) => ({
            ...current,
            apiKey: next.token,
            credentialSource: 'device_code',
            torrentCacheAndPlay: String(
              settings.stremio_wait_for_download_torrent ?? false
            ),
            usenetCacheAndPlay: String(
              settings.stremio_wait_for_download_usenet ?? false
            ),
            appendFilename: String(settings.append_filename_to_links ?? false),
          }));
        } else if (next.status !== 'waiting') {
          setError(
            next.error || 'TorBox authorization expired or was cancelled'
          );
          setFlow(null);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Connection failed');
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [open, flow?.flowId, flow?.flowSecret, flow?.status, flow?.expiresAt]);

  const connected =
    typeof localValues.apiKey === 'string' && localValues.apiKey;
  const expiresIn = useMemo(
    () => (flow ? mmss(flow.expiresAt - now) : '00:00'),
    [flow, now]
  );

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      setFlow(await startTorboxDeviceFlow());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Connection failed');
    } finally {
      setBusy(false);
    }
  };

  const refreshSettings = async () => {
    if (!localValues.apiKey) return;
    setBusy(true);
    try {
      const result = await validateTorboxToken(localValues.apiKey);
      setLocalValues((current) => ({
        ...current,
        torrentCacheAndPlay: String(
          result.settings.stremio_wait_for_download_torrent ?? false
        ),
        usenetCacheAndPlay: String(
          result.settings.stremio_wait_for_download_usenet ?? false
        ),
        appendFilename: String(
          result.settings.append_filename_to_links ?? false
        ),
      }));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Validation failed');
    } finally {
      setBusy(false);
    }
  };

  const setRemoteToggle = async (
    field: 'torrentCacheAndPlay' | 'usenetCacheAndPlay',
    apiField:
      | 'stremio_wait_for_download_torrent'
      | 'stremio_wait_for_download_usenet',
    value: boolean
  ) => {
    if (!localValues.apiKey) return;
    const previous = localValues[field];
    setLocalValues((current) => ({ ...current, [field]: String(value) }));
    try {
      await updateTorboxSettings(localValues.apiKey, { [apiField]: value });
    } catch (cause) {
      setLocalValues((current) => ({ ...current, [field]: previous }));
      setError(cause instanceof Error ? cause.message : 'Update failed');
    }
  };

  const cancelFlow = async () => {
    if (flow?.flowSecret) {
      await cancelTorboxDeviceFlow(flow.flowId, flow.flowSecret).catch(
        () => {}
      );
    }
    setFlow(null);
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Configure TorBox">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (connected && flow?.status !== 'waiting') onSubmit(localValues);
        }}
      >
        {error && <Alert intent="alert">{error}</Alert>}

        {!connected && !flow && (
          <div className="space-y-3 text-center">
            <p className="text-sm text-[--muted]">Status: Not Connected</p>
            <Button type="button" onClick={connect} loading={busy}>
              Connect TorBox
            </Button>
          </div>
        )}

        {flow && flow.status === 'waiting' && (
          <div className="space-y-3 text-center">
            <p className="text-sm text-[--muted]">Enter this code on TorBox:</p>
            <div className="text-4xl font-mono font-bold tracking-[0.25em]">
              {flow.userCode}
            </div>
            <Button
              type="button"
              onClick={() =>
                window.open(
                  flow.verificationUrl,
                  '_blank',
                  'noopener,noreferrer'
                )
              }
            >
              Open TorBox
            </Button>
            <p className="text-xs break-all text-[--muted]">
              {flow.friendlyVerificationUrl || flow.verificationUrl}
            </p>
            <p className="text-sm">Waiting for authorization…</p>
            <p className="text-xs text-[--muted]">Expires in {expiresIn}</p>
            <Button type="button" intent="primary-outline" onClick={cancelFlow}>
              Cancel
            </Button>
          </div>
        )}

        {connected && flow?.status !== 'waiting' && (
          <>
            <Alert intent="success">✓ TorBox Connected</Alert>
            <div className="space-y-3 rounded-[--radius-md] border p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm">Torrent Cache &amp; Play</span>
                <Switch
                  value={bool(localValues.torrentCacheAndPlay)}
                  onValueChange={(value) =>
                    setRemoteToggle(
                      'torrentCacheAndPlay',
                      'stremio_wait_for_download_torrent',
                      value
                    )
                  }
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm">Usenet Cache &amp; Play</span>
                <Switch
                  value={bool(localValues.usenetCacheAndPlay)}
                  onValueChange={(value) =>
                    setRemoteToggle(
                      'usenetCacheAndPlay',
                      'stremio_wait_for_download_usenet',
                      value
                    )
                  }
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm">Append Filename to Native Links</span>
                <Switch
                  value={bool(localValues.appendFilename)}
                  onValueChange={(value) =>
                    setLocalValues((current) => ({
                      ...current,
                      appendFilename: String(value),
                    }))
                  }
                />
              </div>
            </div>

            <TemplateOption
              option={{
                id: 'playbackQuality',
                name: 'TorBox Playback Quality',
                description: '1080p and 720p use TorBox streaming.',
                type: 'select',
                required: false,
                options: [
                  { label: 'Native', value: 'native' },
                  { label: '1080p', value: '1080p' },
                  { label: '720p', value: '720p' },
                ],
              }}
              value={localValues.playbackQuality}
              onChange={(value) =>
                setLocalValues((current) => ({
                  ...current,
                  playbackQuality: value,
                }))
              }
            />
            <TemplateOption
              option={{
                id: 'audioLanguage',
                name: 'Preferred Audio',
                description:
                  'Explicit languages fall back to Native if missing.',
                type: 'select',
                required: false,
                options: [{ label: 'Auto', value: 'auto' }, ...languageOptions],
              }}
              value={localValues.audioLanguage}
              onChange={(value) =>
                setLocalValues((current) => ({
                  ...current,
                  audioLanguage: value,
                }))
              }
            />
            <TemplateOption
              option={{
                id: 'subtitleLanguage',
                name: 'Preferred Subtitles',
                description:
                  'Image-only subtitles fall back to the complete Native file.',
                type: 'select',
                required: false,
                options: [
                  { label: 'Off', value: 'off' },
                  { label: 'Auto', value: 'auto' },
                  ...languageOptions,
                ],
              }}
              value={localValues.subtitleLanguage}
              onChange={(value) =>
                setLocalValues((current) => ({
                  ...current,
                  subtitleLanguage: value,
                }))
              }
            />

            <Alert intent="info">
              If TorBox streaming cannot provide an explicitly selected audio or
              text subtitle track, the original Native TorBox file is used.
            </Alert>
            <div className="flex gap-2">
              <Button type="button" intent="primary-outline" onClick={connect}>
                Reconnect
              </Button>
              <Button
                type="button"
                intent="primary-outline"
                onClick={() => {
                  setLocalValues((current) => ({
                    playbackQuality: current.playbackQuality || 'native',
                    audioLanguage: current.audioLanguage || 'auto',
                    subtitleLanguage: current.subtitleLanguage || 'off',
                  }));
                  setFlow(null);
                }}
              >
                Disconnect
              </Button>
              <Button
                type="button"
                intent="gray-outline"
                onClick={refreshSettings}
              >
                Refresh
              </Button>
            </div>
          </>
        )}

        <div className="flex gap-2">
          <Button
            type="button"
            className="w-full"
            intent="primary-outline"
            onClick={onClose}
          >
            Close
          </Button>
          <Button
            type="submit"
            className="w-full"
            disabled={!connected || flow?.status === 'waiting'}
          >
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
