import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@aiostreams/ui/button';
import {
  deleteDeepbridProfileHistory,
  getDeepbridProfileHistory,
  getDeepbridProfileMetrics,
  getDeepbridProfileUploadDetails,
  resolveDeepbridProfileFolder,
  runDeepbridProfileSelfTest,
} from '@/lib/api';

const PAGE_SIZE = 50;

export function DeepbridHistoryManager({
  profileId,
  sessionOwner,
}: {
  profileId: string;
  sessionOwner: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [kind, setKind] = React.useState<'downloads' | 'uploads'>('downloads');
  const [page, setPage] = React.useState(0);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const [inspectedUploadId, setInspectedUploadId] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);
  const [selfTestBusy, setSelfTestBusy] = React.useState(false);
  const [metricsOpen, setMetricsOpen] = React.useState(false);
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
            Runs one read-only account check and local rate-limit/parser tests.
            No account identifiers or credentials are returned.
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
