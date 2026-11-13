import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@aiostreams/ui/button';
import {
  getDeepbridAccountInsights,
  deleteDeepbridProfileHistory,
  getDeepbridProfileHistory,
  getDeepbridProfileMetrics,
  getDeepbridProfileTorrents,
  deleteDeepbridProfileTorrents,
  addDeepbridProfileTorrent,
  addDeepbridProfileTorrentFile,
  addDeepbridProfileNzb,
  getDeepbridProfileUploadDetails,
  resolveDeepbridProfileFolder,
  runDeepbridProfileSelfTest,
} from '@/lib/api';
import {
  createDeepbridDiagnosticExport,
  downloadDeepbridDiagnosticExport,
} from './deepbrid-diagnostics';

const PAGE_SIZE = 50;

export function DeepbridHistoryManager({
  profileId,
  sessionOwner,
}: {
  profileId: string;
  sessionOwner: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [torrentsOpen, setTorrentsOpen] = React.useState(false);
  const [kind, setKind] = React.useState<'downloads' | 'uploads'>('downloads');
  const [page, setPage] = React.useState(0);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const [selectedTorrents, setSelectedTorrents] = React.useState<Set<string>>(
    () => new Set()
  );
  const [torrentMagnet, setTorrentMagnet] = React.useState('');
  const [torrentAddBusy, setTorrentAddBusy] = React.useState(false);
  const [torrentFile, setTorrentFile] = React.useState<File>();
  const [torrentFileAddBusy, setTorrentFileAddBusy] = React.useState(false);
  const torrentInputRef = React.useRef<HTMLInputElement>(null);
  const [nzbFile, setNzbFile] = React.useState<File>();
  const [nzbAddBusy, setNzbAddBusy] = React.useState(false);
  const nzbInputRef = React.useRef<HTMLInputElement>(null);
  const [inspectedUploadId, setInspectedUploadId] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);
  const [selfTestBusy, setSelfTestBusy] = React.useState(false);
  const [metricsOpen, setMetricsOpen] = React.useState(false);
  const [insightsOpen, setInsightsOpen] = React.useState(false);
  const [folderLink, setFolderLink] = React.useState('');
  const [folderBusy, setFolderBusy] = React.useState(false);
  const [folderFiles, setFolderFiles] = React.useState<
    Awaited<ReturnType<typeof resolveDeepbridProfileFolder>>['files'] | null
  >(null);
  const [selfTest, setSelfTest] = React.useState<Awaited<
    ReturnType<typeof runDeepbridProfileSelfTest>
  > | null>(null);
  const queryClient = useQueryClient();
  React.useEffect(
    () => () => {
      void queryClient.removeQueries({
        queryKey: ['profile-deepbrid-history', sessionOwner, profileId],
      });
      void queryClient.removeQueries({
        queryKey: ['profile-deepbrid-upload', sessionOwner, profileId],
      });
      void queryClient.removeQueries({
        queryKey: ['profile-deepbrid-metrics', sessionOwner, profileId],
      });
      void queryClient.removeQueries({
        queryKey: ['profile-deepbrid-insights', sessionOwner, profileId],
      });
      void queryClient.removeQueries({
        queryKey: ['profile-deepbrid-torrents', sessionOwner, profileId],
      });
    },
    [queryClient, profileId, sessionOwner]
  );

  const queryKey = [
    'profile-deepbrid-history',
    sessionOwner,
    profileId,
    kind,
    page,
  ] as const;
  const history = useQuery({
    queryKey,
    queryFn: () =>
      getDeepbridProfileHistory(profileId, {
        kind,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
    enabled: open,
    retry: false,
  });
  const uploadDetails = useQuery({
    queryKey: [
      'profile-deepbrid-upload',
      sessionOwner,
      profileId,
      inspectedUploadId,
    ],
    queryFn: () =>
      getDeepbridProfileUploadDetails(profileId, inspectedUploadId!),
    enabled: open && kind === 'uploads' && Boolean(inspectedUploadId),
    retry: false,
  });
  const metrics = useQuery({
    queryKey: ['profile-deepbrid-metrics', sessionOwner, profileId],
    queryFn: () => getDeepbridProfileMetrics(profileId),
    enabled: metricsOpen,
    staleTime: 10_000,
    retry: false,
  });
  const insights = useQuery({
    queryKey: ['profile-deepbrid-insights', sessionOwner, profileId],
    queryFn: ({ signal }) => getDeepbridAccountInsights(profileId, { signal }),
    enabled: insightsOpen,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const torrents = useQuery({
    queryKey: ['profile-deepbrid-torrents', sessionOwner, profileId],
    queryFn: () => getDeepbridProfileTorrents(profileId),
    enabled: torrentsOpen,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const changeKind = (next: 'downloads' | 'uploads') => {
    setKind(next);
    setPage(0);
    setSelected(new Set());
    setInspectedUploadId(undefined);
  };

  const deleteSelected = async () => {
    const ids = [...selected];
    if (
      ids.length === 0 ||
      !window.confirm(
        `Delete ${ids.length} selected ${kind === 'uploads' ? 'NZB upload' : 'download'} history entr${ids.length === 1 ? 'y' : 'ies'} from this profile's Deepbrid account? This cannot be undone.`
      )
    ) {
      return;
    }

    setBusy(true);
    try {
      const result = await deleteDeepbridProfileHistory(profileId, kind, ids);
      setSelected(new Set());
      await queryClient.invalidateQueries({
        queryKey: ['profile-deepbrid-history', sessionOwner, profileId],
      });
      toast.success(
        `Deleted ${result.deleted} selected history entr${result.deleted === 1 ? 'y' : 'ies'}`
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Could not delete selected Deepbrid history'
      );
    } finally {
      setBusy(false);
    }
  };

  const deleteSelectedTorrents = async () => {
    const ids = [...selectedTorrents];
    if (
      ids.length === 0 ||
      !window.confirm(
        `Permanently delete ${ids.length} selected cloud torrent${ids.length === 1 ? '' : 's'} from this profile's Deepbrid account? This cannot be undone.`
      )
    ) {
      return;
    }

    setBusy(true);
    try {
      const result = await deleteDeepbridProfileTorrents(profileId, ids);
      setSelectedTorrents(new Set());
      await queryClient.invalidateQueries({
        queryKey: ['profile-deepbrid-torrents', sessionOwner, profileId],
      });
      toast.success(`Deleted ${result.deleted} selected cloud torrent(s)`);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Could not delete the selected cloud torrents'
      );
    } finally {
      setBusy(false);
    }
  };

  const addTorrent = async () => {
    const magnet = torrentMagnet.trim();
    if (!magnet || torrentAddBusy) return;
    setTorrentAddBusy(true);
    try {
      await addDeepbridProfileTorrent(profileId, magnet);
      setTorrentMagnet('');
      await queryClient.invalidateQueries({
        queryKey: ['profile-deepbrid-torrents', sessionOwner, profileId],
      });
      toast.success('Torrent submitted to Deepbrid');
    } catch {
      toast.error('Could not submit this magnet link to Deepbrid');
    } finally {
      setTorrentAddBusy(false);
    }
  };

  const addTorrentFile = async () => {
    if (!torrentFile || torrentFileAddBusy) return;
    setTorrentFileAddBusy(true);
    try {
      await addDeepbridProfileTorrentFile(profileId, torrentFile);
      setTorrentFile(undefined);
      if (torrentInputRef.current) torrentInputRef.current.value = '';
      await queryClient.invalidateQueries({
        queryKey: ['profile-deepbrid-torrents', sessionOwner, profileId],
      });
      toast.success('Torrent file submitted to Deepbrid');
    } catch {
      toast.error('Could not submit this torrent file to Deepbrid');
    } finally {
      setTorrentFileAddBusy(false);
    }
  };

  const addNzb = async () => {
    if (!nzbFile || nzbAddBusy) return;
    setNzbAddBusy(true);
    try {
      const result = await addDeepbridProfileNzb(profileId, nzbFile);
      setNzbFile(undefined);
      if (nzbInputRef.current) nzbInputRef.current.value = '';
      await queryClient.invalidateQueries({
        queryKey: ['profile-deepbrid-history', sessionOwner, profileId],
      });
      if (result.id) setInspectedUploadId(result.id);
      toast.success(
        `NZB submitted to Deepbrid · ${result.files.length} file(s) found`
      );
    } catch {
      toast.error('Could not submit this NZB file to Deepbrid');
    } finally {
      setNzbAddBusy(false);
    }
  };

  const runSelfTest = async () => {
    setSelfTestBusy(true);
    try {
      const result = await runDeepbridProfileSelfTest(profileId);
      setSelfTest(result);
      toast[result.overall === 'passed' ? 'success' : 'error'](
        result.overall === 'passed'
          ? 'Deepbrid self-test passed'
          : 'Deepbrid self-test found an issue'
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Could not run Deepbrid self-test'
      );
    } finally {
      setSelfTestBusy(false);
    }
  };

  const resolveFolder = async () => {
    setFolderBusy(true);
    setFolderFiles(null);
    try {
      const result = await resolveDeepbridProfileFolder(profileId, folderLink);
      setFolderFiles(result.files);
      toast.success(`Resolved ${result.files.length} folder file(s)`);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Could not resolve this Deepbrid folder'
      );
    } finally {
      setFolderBusy(false);
    }
  };

  const entries = history.data?.entries ?? [];
  const hasNextPage = history.data?.hasNext ?? false;

  return (
    <section className="border-t border-[--subtle] pt-4 mt-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="font-semibold">Deepbrid account history</h3>
          <p className="text-sm text-[--muted]">
            Browse this profile&apos;s download and NZB upload records. Only
            individually selected records can be removed; clear-all is not
            available here. Upload pages reflect the provider&apos;s current
            returned snapshot.
          </p>
        </div>
        <Button
          intent="gray-subtle"
          rounded
          size="sm"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {open ? 'Hide history' : 'Manage history'}
        </Button>
        <Button
          intent="gray-subtle"
          rounded
          size="sm"
          onClick={() => setTorrentsOpen((value) => !value)}
          aria-expanded={torrentsOpen}
        >
          {torrentsOpen ? 'Hide cloud torrents' : 'Cloud torrent status'}
        </Button>
        <Button
          intent="gray-subtle"
          rounded
          size="sm"
          loading={selfTestBusy}
          disabled={selfTestBusy}
          onClick={runSelfTest}
        >
          Run self-test
        </Button>
      </div>

      {selfTest ? (
        <div
          role="status"
          className="space-y-2 rounded-md border border-[--subtle] p-3 mt-3"
        >
          <div className="font-medium">Self-test: {selfTest.overall}</div>
          <div className="text-sm text-[--muted]">
            Account: {selfTest.account.status}
            {selfTest.account.failureKind
              ? ` · ${selfTest.account.failureKind}`
              : ''}
            {' · '}
            {selfTest.account.durationMs} ms
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {selfTest.checks.map((check) => (
              <li key={check.id}>
                {check.id}: {check.status} ({check.durationMs} ms)
              </li>
            ))}
          </ul>
          <p className="text-xs text-[--muted]">
            Runs one read-only account status check and local rate-limit/parser
            tests. No account identifiers or credentials are returned.
          </p>
        </div>
      ) : null}

      {metrics.data ? (
        <div className="mt-3">
          <Button
            intent="gray-subtle"
            rounded
            size="sm"
            onClick={() =>
              downloadDeepbridDiagnosticExport(
                createDeepbridDiagnosticExport({
                  metrics: metrics.data!,
                  selfTest,
                })
              )
            }
          >
            Export redacted diagnostics
          </Button>
          <p className="mt-1 text-xs text-[--muted]">
            Exports aggregate timings and local check results only. Account
            identifiers, credentials, URLs, filenames, and search terms are
            excluded.
          </p>
        </div>
      ) : null}

      <div className="mt-3 rounded-md border border-[--subtle] p-3">
        <div className="font-medium">Resolve a supported folder link</div>
        <p className="mt-1 text-xs text-[--muted]">
          Deepbrid currently documents Terabox, Mega, and Gofile folders.
          Results show video candidates only as candidates; playback is not
          verified here. Signed links are kept server-side.
        </p>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            className="min-w-0 flex-1 rounded border border-[--subtle] bg-transparent px-3 py-2 text-sm"
            type="url"
            value={folderLink}
            onChange={(event) => setFolderLink(event.target.value)}
            placeholder="https://…"
            aria-label="Deepbrid-supported folder URL"
            maxLength={2048}
          />
          <Button
            intent="gray-subtle"
            rounded
            size="sm"
            loading={folderBusy}
            disabled={folderBusy || !folderLink.trim()}
            onClick={resolveFolder}
          >
            Resolve folder
          </Button>
        </div>
        {folderFiles ? (
          <ul className="mt-3 divide-y divide-[--subtle] rounded-md border border-[--subtle]">
            {folderFiles.length === 0 ? (
              <li className="p-3 text-sm text-[--muted]">
                No files were returned by Deepbrid.
              </li>
            ) : (
              folderFiles.map((file, index) => (
                <li key={`${file.name}:${index}`} className="p-3 text-sm">
                  <div className="break-words font-medium">{file.name}</div>
                  <div className="text-xs text-[--muted]">
                    {file.sizeHuman || 'Size unknown'} ·{' '}
                    {file.playableCandidate
                      ? 'video candidate — not playback-verified'
                      : file.status === 'non-video'
                        ? 'not a video file'
                        : 'unavailable or unsupported'}
                  </div>
                </li>
              ))
            )}
          </ul>
        ) : null}
      </div>

      <div className="mt-3">
        <Button
          intent="gray-subtle"
          rounded
          size="sm"
          onClick={() => setInsightsOpen((value) => !value)}
          aria-expanded={insightsOpen}
        >
          {insightsOpen
            ? 'Hide account usage & limits'
            : 'Account usage & limits'}
        </Button>
        {insightsOpen ? (
          <div className="mt-3 rounded-md border border-[--subtle] p-3">
            {insights.isLoading ? (
              <p className="text-sm text-[--muted]">Loading account usage…</p>
            ) : insights.isError ? (
              <p role="alert" className="text-sm text-red-400">
                Could not load Deepbrid account usage.
              </p>
            ) : insights.data ? (
              <>
                <p className="text-xs text-[--muted]">
                  Account plan: {insights.data.plan}.
                </p>
                {insights.data.accountDetails.status === 'available' ? (
                  <div className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                    <Metric
                      label="Subscription expires"
                      value={
                        insights.data.accountDetails.data.expiration ?? '—'
                      }
                    />
                    <Metric
                      label="Max downloads"
                      value={
                        insights.data.accountDetails.data.maxDownloads ?? '—'
                      }
                    />
                    <Metric
                      label="Max connections"
                      value={
                        insights.data.accountDetails.data.maxConnections ?? '—'
                      }
                    />
                    <Metric
                      label="Fidelity points"
                      value={
                        insights.data.accountDetails.data.fidelityPoints ?? '—'
                      }
                    />
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-[--muted]">
                    Account details unavailable (
                    {insights.data.accountDetails.reason}).
                  </p>
                )}
                {insights.data.stats.status === 'available' ? (
                  <>
                    <div className="font-medium">Account usage</div>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                      <Metric
                        label="Downloads"
                        value={insights.data.stats.data.downloads ?? '—'}
                      />
                      <Metric
                        label="Bandwidth"
                        value={
                          insights.data.stats.data.bandwidthDisplay ??
                          formatDeepbridBytes(
                            insights.data.stats.data.bandwidthBytes
                          )
                        }
                      />
                      <Metric
                        label="Torrents"
                        value={insights.data.stats.data.torrents ?? '—'}
                      />
                      <Metric
                        label="Remote transfers"
                        value={insights.data.stats.data.remote ?? '—'}
                      />
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-[--muted]">
                    Usage stats unavailable ({insights.data.stats.reason}).
                  </p>
                )}

                <div className="mt-4 font-medium">API key activity</div>
                {insights.data.apiKeyActivity.status === 'available' ? (
                  <div className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                    <Metric
                      label="Requests"
                      value={
                        insights.data.apiKeyActivity.data.totalRequests ?? '—'
                      }
                    />
                    <Metric
                      label="Links generated"
                      value={
                        insights.data.apiKeyActivity.data.totalLinks ?? '—'
                      }
                    />
                    <Metric
                      label="Last used"
                      value={
                        insights.data.apiKeyActivity.data.lastUsedAt ?? '—'
                      }
                    />
                  </div>
                ) : (
                  <p className="mt-1 text-sm text-[--muted]">
                    API key activity unavailable (
                    {insights.data.apiKeyActivity.reason}).
                  </p>
                )}
                {insights.data.apiKeyActivity.status === 'available' ? (
                  <p className="mt-1 text-xs text-[--muted]">
                    Created:{' '}
                    {insights.data.apiKeyActivity.data.createdAt ?? 'unknown'}
                    {' · '}Last rotated:{' '}
                    {insights.data.apiKeyActivity.data.regeneratedAt ??
                      'not provided'}
                  </p>
                ) : null}

                <div className="mt-4 font-medium">Recent API devices</div>
                {insights.data.apiKeyDevices.status === 'unavailable' ? (
                  <p className="mt-1 text-sm text-[--muted]">
                    Device activity unavailable (
                    {insights.data.apiKeyDevices.reason}).
                  </p>
                ) : insights.data.apiKeyDevices.data.devices.length === 0 ? (
                  <p className="mt-1 text-sm text-[--muted]">
                    No API device activity was returned.
                  </p>
                ) : (
                  <ul className="mt-2 divide-y divide-[--subtle] rounded-md border border-[--subtle]">
                    {insights.data.apiKeyDevices.data.devices.map(
                      (device, index) => (
                        <li
                          key={`${device.deviceName ?? 'device'}:${device.lastSeenAt ?? index}`}
                          className="p-2 text-sm"
                        >
                          <div className="font-medium">
                            {device.deviceName ?? 'Unnamed client'}
                            {device.requestCount !== undefined
                              ? ` · ${device.requestCount} requests`
                              : ''}
                          </div>
                          {device.userAgent ? (
                            <div className="break-all text-xs text-[--muted]">
                              {device.userAgent}
                            </div>
                          ) : null}
                          <div className="text-xs text-[--muted]">
                            Last seen: {device.lastSeenAt ?? 'unknown'}
                            {device.firstSeenAt
                              ? ` · First seen: ${device.firstSeenAt}`
                              : ''}
                          </div>
                        </li>
                      )
                    )}
                  </ul>
                )}
                {insights.data.apiKeyDevices.status === 'available' &&
                insights.data.apiKeyDevices.data.truncated ? (
                  <p className="mt-2 text-xs text-[--muted]">
                    Showing up to 50 device records
                    {insights.data.apiKeyDevices.data.total !== undefined
                      ? ` of ${insights.data.apiKeyDevices.data.total}`
                      : ''}
                    .
                  </p>
                ) : null}

                <div className="mt-4 font-medium">
                  Supported host availability
                </div>
                {insights.data.hostStatus.status === 'unavailable' ? (
                  <p className="mt-1 text-sm text-[--muted]">
                    Host status unavailable ({insights.data.hostStatus.reason}).
                  </p>
                ) : insights.data.hostStatus.data.hosts.length === 0 ? (
                  <p className="mt-1 text-sm text-[--muted]">
                    Deepbrid returned no host status entries.
                  </p>
                ) : (
                  <ul className="mt-2 grid grid-cols-1 gap-1 rounded-md border border-[--subtle] p-2 text-sm sm:grid-cols-2">
                    {insights.data.hostStatus.data.hosts.map((host) => (
                      <li
                        key={host.domain}
                        className="flex min-w-0 justify-between gap-2"
                      >
                        <span className="truncate">{host.domain}</span>
                        <span
                          className={
                            host.online ? 'text-green-400' : 'text-amber-400'
                          }
                        >
                          {host.status}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {insights.data.hostStatus.status === 'available' &&
                insights.data.hostStatus.data.truncated ? (
                  <p className="mt-2 text-xs text-[--muted]">
                    The provider returned more host rows than the safe display
                    cap; some entries are omitted.
                  </p>
                ) : null}

                <div className="mt-4 font-medium">
                  Official Deepbrid app versions
                </div>
                {insights.data.officialApps.status === 'unavailable' ? (
                  <p className="mt-1 text-sm text-[--muted]">
                    App catalog unavailable ({insights.data.officialApps.reason}
                    ).
                  </p>
                ) : !insights.data.officialApps.data.apps.length ? (
                  <p className="mt-1 text-sm text-[--muted]">
                    Deepbrid returned no app version entries.
                  </p>
                ) : (
                  <ul className="mt-2 grid grid-cols-1 gap-1 rounded-md border border-[--subtle] p-2 text-sm sm:grid-cols-2">
                    {insights.data.officialApps.data.apps.map((app) => (
                      <li
                        key={app.id}
                        className="flex min-w-0 justify-between gap-2"
                      >
                        <span className="truncate">{app.name}</span>
                        <span className="shrink-0 text-[--muted]">
                          {app.version ?? 'version unknown'}
                          {app.date ? ` · ${app.date}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {insights.data.officialApps.status === 'available' &&
                insights.data.officialApps.data.truncated ? (
                  <p className="mt-2 text-xs text-[--muted]">
                    Some app entries were omitted by the safe display cap.
                  </p>
                ) : null}
                <p className="mt-1 text-xs text-[--muted]">
                  Version metadata only; install URLs and WebDAV entries are
                  intentionally omitted.
                </p>

                <div className="mt-4 font-medium">Daily hoster limits</div>
                {insights.data.limits.status === 'unavailable' ? (
                  <p className="mt-1 text-sm text-[--muted]">
                    Limits unavailable ({insights.data.limits.reason}).
                  </p>
                ) : !insights.data.limits.data.hosters.length ? (
                  <p className="mt-1 text-sm text-[--muted]">
                    No per-hoster limits were returned
                    {insights.data.limits.data.enabled === false
                      ? ' (limits are disabled for this account)'
                      : ''}
                    .
                  </p>
                ) : (
                  <ul className="mt-2 divide-y divide-[--subtle] rounded-md border border-[--subtle]">
                    {insights.data.limits.data.hosters.map((limit) => (
                      <li
                        key={`${limit.domain}:${limit.type}`}
                        className="flex flex-wrap justify-between gap-2 p-2 text-sm"
                      >
                        <span className="font-medium">{limit.domain}</span>
                        <span className="text-[--muted]">
                          {limit.type === 'bandwidth'
                            ? `${limit.usedDisplay ?? formatDeepbridBytes(limit.used)} / ${limit.limitDisplay ?? formatDeepbridBytes(limit.limit)} used · ${limit.remainingDisplay ?? formatDeepbridBytes(limit.remaining)} left`
                            : `${limit.used} / ${limit.limit} links used · ${limit.remaining} left`}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {insights.data.limits.status === 'available' &&
                insights.data.limits.data.hostersTruncated ? (
                  <p className="mt-2 text-xs text-[--muted]">
                    Showing the first 300 hoster rows; the provider returned
                    more than the display safety cap.
                  </p>
                ) : null}
                <p className="mt-2 text-xs text-[--muted]">
                  Read-only aggregate data for this profile&apos;s own linked
                  Deepbrid account. No API key, account email, IP address, or
                  download links are shown. Reset:{' '}
                  {insights.data.limits.status === 'available'
                    ? (insights.data.limits.data.reset ?? 'not provided')
                    : 'unknown'}
                  .
                </p>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="mt-3">
        <Button
          intent="gray-subtle"
          rounded
          size="sm"
          onClick={() => setMetricsOpen((value) => !value)}
          aria-expanded={metricsOpen}
        >
          {metricsOpen ? 'Hide Finder latency' : 'Finder latency'}
        </Button>
        {metricsOpen ? (
          <div className="mt-3 rounded-md border border-[--subtle] p-3">
            {metrics.isLoading ? (
              <p className="text-sm text-[--muted]">Loading local metrics…</p>
            ) : metrics.isError ? (
              <p role="alert" className="text-sm text-red-400">
                {metrics.error instanceof Error
                  ? metrics.error.message
                  : 'Could not load Finder metrics.'}
              </p>
            ) : metrics.data ? (
              <>
                <div className="font-medium">Finder search latency</div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                  <Metric
                    label="Cold fetch p50"
                    value={`${metrics.data.search.p50Ms} ms`}
                  />
                  <Metric
                    label="Cold fetch p95"
                    value={`${metrics.data.search.p95Ms} ms`}
                  />
                  <Metric
                    label="Measured searches"
                    value={metrics.data.search.samples}
                  />
                  <Metric
                    label="Warm cache p50"
                    value={`${metrics.data.search.warmP50Ms} ms`}
                  />
                  <Metric
                    label="Warm cache p95"
                    value={`${metrics.data.search.warmP95Ms} ms`}
                  />
                  <Metric
                    label="Warm samples"
                    value={metrics.data.search.warmSamples}
                  />
                  <Metric
                    label="Cache hits"
                    value={metrics.data.search.freshCacheHits}
                  />
                  <Metric
                    label="Queue wait p95"
                    value={`${metrics.data.queue.p95Ms} ms`}
                  />
                  <Metric
                    label="Rate limited"
                    value={metrics.data.rateLimitedResponses}
                  />
                  <Metric
                    label="Transport failures"
                    value={metrics.data.transportFailures}
                  />
                  <Metric
                    label="Coalesced requests"
                    value={metrics.data.search.coalescedRequests}
                  />
                </div>
                <p className="mt-2 text-xs text-[--muted]">
                  Process-local aggregate since service start; no search text,
                  result names, URLs, or credentials are retained here.
                </p>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      {torrentsOpen ? (
        <div className="mt-3 rounded-md border border-[--subtle] p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="font-medium">Deepbrid cloud torrents</div>
              <p className="mt-1 text-xs text-[--muted]">
                Select specific entries to remove them. Signed links, hashes,
                and file details are never returned to the dashboard.
              </p>
            </div>
            <Button
              intent="gray-subtle"
              rounded
              size="sm"
              disabled={selectedTorrents.size === 0 || busy}
              loading={busy}
              onClick={deleteSelectedTorrents}
            >
              Delete selected ({selectedTorrents.size})
            </Button>
          </div>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              className="min-w-0 flex-1 rounded border border-[--subtle] bg-transparent px-3 py-2 text-sm"
              type="text"
              value={torrentMagnet}
              onChange={(event) => setTorrentMagnet(event.target.value)}
              placeholder="magnet:?xt=urn:btih:…"
              aria-label="Torrent magnet link"
              autoComplete="off"
              maxLength={8_192}
            />
            <Button
              intent="gray-subtle"
              rounded
              size="sm"
              loading={torrentAddBusy}
              disabled={!torrentMagnet.trim() || torrentAddBusy}
              onClick={addTorrent}
            >
              Add magnet
            </Button>
          </div>
          <div className="flex flex-col gap-2 rounded-md border border-[--subtle] p-3 sm:flex-row sm:items-center">
            <label className="min-w-0 flex-1 text-sm">
              <span className="mb-1 block font-medium">
                Or submit a .torrent file (max 16 MB)
              </span>
              <input
                ref={torrentInputRef}
                type="file"
                accept=".torrent,application/x-bittorrent"
                aria-label="Torrent file to submit to Deepbrid"
                disabled={torrentFileAddBusy}
                onChange={(event) =>
                  setTorrentFile(event.currentTarget.files?.[0])
                }
                className="block w-full text-sm"
              />
            </label>
            <Button
              intent="gray-subtle"
              rounded
              size="sm"
              loading={torrentFileAddBusy}
              disabled={!torrentFile || torrentFileAddBusy}
              onClick={addTorrentFile}
            >
              Submit torrent file
            </Button>
          </div>
          {torrents.isLoading ? (
            <p className="mt-2 text-sm text-[--muted]">
              Loading torrent status…
            </p>
          ) : torrents.isError ? (
            <p role="alert" className="mt-2 text-sm text-red-400">
              Could not load cloud torrent status. Deepbrid may require a
              Premium account for this endpoint.
            </p>
          ) : torrents.data?.torrents.length ? (
            <ul className="mt-2 divide-y divide-[--subtle] rounded-md border border-[--subtle]">
              {torrents.data.torrents.map((torrent) => (
                <li key={torrent.id} className="flex gap-3 p-3">
                  <input
                    type="checkbox"
                    checked={selectedTorrents.has(torrent.id)}
                    onChange={(event) =>
                      setSelectedTorrents((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(torrent.id);
                        else next.delete(torrent.id);
                        return next;
                      })
                    }
                    aria-label={`Select ${torrent.title || `torrent ${torrent.id}`} for deletion`}
                    className="mt-1 accent-indigo-500"
                  />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 break-words font-medium">
                        {torrent.title || `Torrent ${torrent.id}`}
                      </div>
                      <span className="rounded bg-[--subtle] px-2 py-1 text-xs">
                        {torrent.status.replaceAll('_', ' ')}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[--muted]">
                      {torrent.progress !== undefined
                        ? `Progress ${torrent.progress}%`
                        : null}
                      {torrent.size ? formatDeepbridBytes(torrent.size) : null}
                      {torrent.seeders !== undefined
                        ? `${torrent.seeders} seeders`
                        : null}
                      {torrent.speed || null}
                    </div>
                    {torrent.progress !== undefined ? (
                      <progress
                        className="h-2 w-full accent-indigo-500"
                        max={100}
                        value={torrent.progress}
                        aria-label={`${torrent.title || 'Torrent'} progress`}
                      />
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-[--muted]">
              No cloud torrents were returned.
            </p>
          )}
        </div>
      ) : null}

      {open ? (
        <div className="space-y-3 mt-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              intent={kind === 'downloads' ? 'white' : 'gray-subtle'}
              rounded
              size="sm"
              onClick={() => changeKind('downloads')}
              aria-pressed={kind === 'downloads'}
            >
              Downloads
            </Button>
            <Button
              intent={kind === 'uploads' ? 'white' : 'gray-subtle'}
              rounded
              size="sm"
              onClick={() => changeKind('uploads')}
              aria-pressed={kind === 'uploads'}
            >
              NZB uploads
            </Button>
            <span className="text-sm text-[--muted]">Page {page + 1}</span>
            <div className="flex-1" />
            <Button
              intent="gray-subtle"
              rounded
              size="sm"
              disabled={selected.size === 0 || busy}
              loading={busy}
              onClick={deleteSelected}
            >
              Delete selected ({selected.size})
            </Button>
          </div>

          {kind === 'uploads' ? (
            <div className="flex flex-col gap-2 rounded-md border border-[--subtle] p-3 sm:flex-row sm:items-center">
              <label className="min-w-0 flex-1 text-sm">
                <span className="mb-1 block font-medium">
                  Submit an NZB file
                </span>
                <input
                  ref={nzbInputRef}
                  type="file"
                  accept=".nzb,application/x-nzb,application/xml,text/xml"
                  aria-label="NZB file to submit to Deepbrid"
                  disabled={nzbAddBusy}
                  onChange={(event) =>
                    setNzbFile(event.currentTarget.files?.[0])
                  }
                  className="block w-full text-sm"
                />
              </label>
              <Button
                intent="gray-subtle"
                rounded
                size="sm"
                loading={nzbAddBusy}
                disabled={!nzbFile || nzbAddBusy}
                onClick={addNzb}
              >
                Submit NZB
              </Button>
            </div>
          ) : null}

          {history.isLoading ? (
            <p className="text-sm text-[--muted]">Loading account history…</p>
          ) : history.isError ? (
            <p role="alert" className="text-sm text-red-400">
              {history.error instanceof Error
                ? history.error.message
                : 'Could not load Deepbrid history.'}
            </p>
          ) : entries.length === 0 ? (
            <p className="text-sm text-[--muted]">No entries on this page.</p>
          ) : (
            <ul className="divide-y divide-[--subtle] rounded-md border border-[--subtle]">
              {entries.map((entry) => (
                <li
                  key={`${kind}:${entry.id}`}
                  className="flex items-start gap-3 p-3"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(entry.id)}
                    onChange={(event) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(entry.id);
                        else next.delete(entry.id);
                        return next;
                      })
                    }
                    aria-label={`Select ${entry.filename || `record ${entry.id}`}`}
                    className="mt-1 accent-indigo-500"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="break-words font-medium">
                      {entry.filename || `Record ${entry.id}`}
                    </div>
                    <div className="text-xs text-[--muted]">
                      ID {entry.id}
                      {entry.size ? ` · ${entry.size}` : ''}
                      {entry.date ? ` · ${entry.date}` : ''}
                    </div>
                  </div>
                  {kind === 'uploads' ? (
                    <Button
                      intent="gray-subtle"
                      rounded
                      size="sm"
                      aria-expanded={inspectedUploadId === entry.id}
                      onClick={() =>
                        setInspectedUploadId((current) =>
                          current === entry.id ? undefined : entry.id
                        )
                      }
                    >
                      {inspectedUploadId === entry.id
                        ? 'Hide files'
                        : 'Inspect'}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {kind === 'uploads' && inspectedUploadId ? (
            <section
              aria-live="polite"
              className="space-y-2 rounded-md border border-[--subtle] p-3"
            >
              <div className="font-medium">
                NZB contents ·{' '}
                {uploadDetails.data?.title || `Upload ${inspectedUploadId}`}
              </div>
              {uploadDetails.isLoading ? (
                <p className="text-sm text-[--muted]">Inspecting upload…</p>
              ) : uploadDetails.isError ? (
                <p role="alert" className="text-sm text-red-400">
                  Could not inspect this upload.
                </p>
              ) : uploadDetails.data ? (
                <>
                  <p className="text-sm text-[--muted]">
                    Archive status: {uploadDetails.data.archive.status}
                    {uploadDetails.data.archive.missingVolumeNumbers.length
                      ? ` · missing volume indices: ${uploadDetails.data.archive.missingVolumeNumbers.join(', ')}`
                      : ''}
                    {uploadDetails.data.archive.unreachableArchiveCount
                      ? ` · ${uploadDetails.data.archive.unreachableArchiveCount} unreachable archive file(s)`
                      : ''}
                  </p>
                  {uploadDetails.data.files.length ? (
                    <ul className="divide-y divide-[--subtle] rounded-md border border-[--subtle]">
                      {uploadDetails.data.files.map((file, index) => (
                        <li
                          key={`${file.name}:${index}`}
                          className="flex flex-wrap justify-between gap-2 p-2 text-sm"
                        >
                          <span className="break-all">{file.name}</span>
                          <span className="text-[--muted]">
                            {file.kind} · {file.status}
                            {file.sizeHuman ? ` · ${file.sizeHuman}` : ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-[--muted]">
                      No file entries were returned for this upload.
                    </p>
                  )}
                  <p className="text-xs text-[--muted]">
                    Provider links and raw failure details are intentionally
                    hidden.
                  </p>
                </>
              ) : null}
            </section>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button
              intent="gray-subtle"
              rounded
              size="sm"
              disabled={page === 0 || busy}
              onClick={() => {
                setPage((value) => Math.max(0, value - 1));
                setSelected(new Set());
                setInspectedUploadId(undefined);
              }}
            >
              Previous
            </Button>
            <Button
              intent="gray-subtle"
              rounded
              size="sm"
              disabled={!hasNextPage || busy || history.isLoading}
              onClick={() => {
                setPage((value) => value + 1);
                setSelected(new Set());
                setInspectedUploadId(undefined);
              }}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded bg-[--subtle]/30 p-2">
      <div className="text-[11px] text-[--muted]">{label}</div>
      <div className="font-medium tabular-nums">{value}</div>
    </div>
  );
}

function formatDeepbridBytes(value?: number): string {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    return '—';
  }
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let size = value;
  let unit = 'B';
  for (const nextUnit of units) {
    size /= 1024;
    unit = nextUnit;
    if (size < 1024) break;
  }
  return `${size.toFixed(2)} ${unit}`;
}
