import { useEffect, useState } from 'react';
import { useUserData } from '@/context/userData';
import { Alert } from '@aiostreams/ui/alert';
import { Button } from '@aiostreams/ui/button';
import { TraktTrackerCard } from './trakt-tracker';
import { FloppyTrackerCard } from './floppy-tracker';
import {
  catalogItems,
  catalogPoster,
  makeCatalogTrackerRecord,
  makeCatalogTrackerTombstone,
  makeListMembershipRecord,
  trackerActionErrorMessage,
  type CatalogTrackerMutation,
  type WeTrakrCatalogItem,
} from './tracker-provider-data';

interface DeviceLinkFlow {
  state: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  interval: number;
}

type LinkStatus =
  | { status: 'pending'; retryAfter?: number }
  | { status: 'authorized'; authRef: string }
  | { status: 'error'; error?: string };

interface LinkStart extends Omit<DeviceLinkFlow, 'expiresAt'> {
  expiresIn: number;
}

interface TrackerRefreshResult {
  success?: boolean;
  data?: {
    imported: number;
    syncedProviders: string[];
    pendingProviders: string[];
    unsupportedProviders: string[];
    unsupportedWrites?: Array<{ providerId: string; skipped: number }>;
  };
}

type AccountView =
  | 'lists'
  | 'history'
  | 'list-items'
  | 'progress'
  | 'playing'
  | 'waiting'
  | 'planning'
  | 'dropped'
  | 'paused'
  | 'ignored'
  | 'ratings'
  | 'favorites'
  | 'likes'
  | 'notes'
  | 'comments';

const accountViewTitles: Record<AccountView, string> = {
  lists: 'Custom lists',
  history: 'Watched history',
  'list-items': 'List items',
  progress: 'Watching / progress',
  playing: 'Playing',
  waiting: 'Waiting',
  planning: 'Planning',
  dropped: 'Dropped',
  paused: 'Paused',
  ignored: 'Ignored',
  ratings: 'Ratings',
  favorites: 'Favorites',
  likes: 'Likes',
  notes: 'Notes',
  comments: 'Comments',
};

interface AccountPageResult {
  data: unknown;
  pagination?: { pageCount?: number; itemCount?: number };
}

async function apiRequest<T>(
  path: string,
  uuid: string | null,
  password: string | null,
  init?: RequestInit,
  basePath = '/api/v1/wetrakr'
): Promise<T> {
  if (!uuid || !password)
    throw new Error('Sign in to your AIOStreams account first');
  const authorization = `Basic ${btoa(`${uuid}:${password}`)}`;
  const response = await fetch(`${basePath}${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      ...(init?.headers ?? {}),
    },
  });
  const payload = (await response.json()) as T & {
    error?: { message?: string } | string;
    detail?: string;
    data?: { pendingProviders?: string[] };
  };
  if (!response.ok) {
  const errorText =
      typeof payload.error === 'string'
        ? payload.error
        : payload.error?.message;
    const pending = payload.data?.pendingProviders;
    const pendingText = pending?.length
      ? ` Waiting for: ${pending.join(', ')}.`
      : '';
    throw new Error(
      trackerActionErrorMessage(
        new Error(
          `${errorText || payload.detail || `AIOStreams request failed (${response.status})`}${pendingText}`
        ),
        `AIOStreams request failed (${response.status})`
      )
    );
  }
  return payload;
}

function remaining(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function listItemMediaType(item: WeTrakrCatalogItem): string {
  const type = String(
    item.type ?? item.media_type ?? item.mediaType ?? ''
  ).toLowerCase();
  if (type) return type;
  if (item.movie) return 'movie';
  if (item.show || item.series) return 'show';
  if (item.person) return 'person';
  return '';
}

function WeTrakrTrackerCard() {
  const { userData, setUserData, uuid, password } = useUserData();
  const authRef = userData.trackerProviders?.wetrakr?.authRef;
  const trackerEnabled = userData.trackerProviders?.wetrakr?.enabled !== false;
  const [flow, setFlow] = useState<DeviceLinkFlow | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [syncSummary, setSyncSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogType, setCatalogType] = useState('movie');
  const [catalogSection, setCatalogSection] = useState('trending');
  const [catalogResults, setCatalogResults] = useState<WeTrakrCatalogItem[]>(
    []
  );
  const [catalogDetail, setCatalogDetail] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [catalogDetailBusy, setCatalogDetailBusy] = useState(false);
  const [catalogMessage, setCatalogMessage] = useState<string | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [accountView, setAccountView] = useState<AccountView | null>(null);
  const [historyTarget, setHistoryTarget] = useState<'movies' | 'episodes'>(
    'episodes'
  );
  const [accountItems, setAccountItems] = useState<WeTrakrCatalogItem[]>([]);
  const [accountPage, setAccountPage] = useState(1);
  const [accountPageCount, setAccountPageCount] = useState<number | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const [selectedList, setSelectedList] = useState<WeTrakrCatalogItem | null>(
    null
  );
  const [membershipLists, setMembershipLists] = useState<WeTrakrCatalogItem[]>(
    []
  );
  const [membershipPickerOpen, setMembershipPickerOpen] = useState(false);
  const [membershipListId, setMembershipListId] = useState('');
  const [membershipBusy, setMembershipBusy] = useState(false);
  const [membershipMessage, setMembershipMessage] = useState<string | null>(
    null
  );
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setClientId('');
    setClientSecret('');
  }, [uuid]);

  useEffect(() => {
    if (!flow) return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      try {
        const result = await apiRequest<LinkStatus>(
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
              wetrakr: { enabled: true, authRef: result.authRef },
            },
          }));
          setClientSecret('');
          setFlow(null);
          return;
        }
        if (result.status === 'error') {
          setError(result.error || 'WeTrakr authorization failed');
          setFlow(null);
          return;
        }
        timer = window.setTimeout(
          poll,
          Math.max(2, result.retryAfter || flow.interval) * 1000
        );
      } catch (cause) {
        if (!cancelled) {
          setError(
            cause instanceof Error ? cause.message : 'WeTrakr link failed'
          );
          setFlow(null);
        }
      }
    };
    timer = window.setTimeout(poll, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [flow, setUserData, uuid, password]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiRequest<LinkStart>(
        '/link/device',
        uuid,
        password,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientId, ...(clientSecret ? { clientSecret } : {}) }),
        }
      );
      setFlow({ ...result, expiresAt: Date.now() + result.expiresIn * 1000 });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not start WeTrakr link'
      );
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!authRef) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/link/${encodeURIComponent(authRef)}`, uuid, password, {
        method: 'DELETE',
      });
      setUserData((previous) => {
        const trackerProviders = { ...previous.trackerProviders };
        delete trackerProviders.wetrakr;
        return { ...previous, trackerProviders };
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not remove WeTrakr link'
      );
    } finally {
      setBusy(false);
    }
  };

  const setTrackerEnabled = (enabled: boolean) => {
    setUserData((previous) => ({
      ...previous,
      trackerProviders: {
        ...previous.trackerProviders,
        wetrakr: {
          ...previous.trackerProviders?.wetrakr,
          enabled,
        },
      },
    }));
  };

  const syncNow = async () => {
    setSyncing(true);
    setError(null);
    setSyncSummary(null);
    try {
      // Use the shared refresh/fan-out route, not the WeTrakr-only import
      // endpoint. This merges every enabled provider through the canonical
      // AIOStreams ledger and retries source deltas safely on partial failure.
      const result = await apiRequest<TrackerRefreshResult>(
        '/refresh',
        uuid,
        password,
        { method: 'POST' },
        '/api/v1/tracking/v1'
      );
      const data = result.data;
      if (!result.success || !data)
        throw new Error(
          'AIOStreams returned an incomplete tracker refresh result'
        );
      if (data.pendingProviders.length)
        throw new Error(
          `Sync is waiting for: ${data.pendingProviders.join(', ')}`
        );
      const synced = data.syncedProviders.length
        ? data.syncedProviders.join(', ')
        : 'AIOStreams ledger';
      const unsupported = data.unsupportedProviders.length
        ? ` Unsupported adapters: ${data.unsupportedProviders.join(', ')}.`
        : '';
      const unsupportedWrites = data.unsupportedWrites ?? [];
      const skipped = unsupportedWrites.length
        ? ` Not yet supported: ${unsupportedWrites
            .map(({ providerId, skipped: count }) => `${providerId} (${count})`)
            .join(', ')}.`
        : '';
      setSyncSummary(
        `Merged ${data.imported} new or updated records through AIOStreams. Updated: ${synced}.${unsupported}${skipped}`
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'WeTrakr sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const loadCatalog = async (search = false) => {
    setCatalogBusy(true);
    setError(null);
    setCatalogMessage(null);
    setCatalogResults([]);
    setCatalogDetail(null);
    try {
      const query = new URLSearchParams({
        filter_type: catalogType,
        page: '1',
        limit: '40',
      });
      const path = search
        ? `/catalog/search?${new URLSearchParams({ ...Object.fromEntries(query), q: catalogQuery.trim() })}`
        : `/catalog/discover/${catalogSection}?${query}`;
      if (search && !catalogQuery.trim())
        throw new Error('Enter a title to search WeTrakr.');
      const response = await apiRequest<{ data: unknown }>(
        path,
        uuid,
        password
      );
      const items = catalogItems(response.data);
      setCatalogResults(items);
      if (!items.length)
        setCatalogMessage('WeTrakr returned no titles for that query.');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'WeTrakr catalog request failed'
      );
    } finally {
      setCatalogBusy(false);
    }
  };

  const loadCatalogDetail = async (item: WeTrakrCatalogItem) => {
    const id = item.id;
    if (id === undefined || id === null || !/^\d{1,18}$/.test(String(id))) {
      setError('This WeTrakr catalog item has no usable numeric id.');
      return;
    }
    const mediaType = catalogType.toLowerCase();
    setCatalogDetailBusy(true);
    setCatalogDetail(null);
    setError(null);
    try {
      const query = new URLSearchParams();
      if (mediaType === 'show') query.set('append', 'seasons,episodes');
      if (mediaType === 'list') query.set('extended', 'preview');
      const suffix = query.size ? `?${query}` : '';
      const response = await apiRequest<{ data: unknown }>(
        `/catalog/${encodeURIComponent(mediaType)}/${encodeURIComponent(String(id))}${suffix}`,
        uuid,
        password
      );
      if (
        !response.data ||
        typeof response.data !== 'object' ||
        Array.isArray(response.data)
      ) {
        throw new Error('WeTrakr returned an invalid catalog detail.');
      }
      setCatalogDetail(response.data as Record<string, unknown>);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not load WeTrakr title details.'
      );
    } finally {
      setCatalogDetailBusy(false);
    }
  };

  const openMembershipPicker = async () => {
    setMembershipPickerOpen(true);
    setMembershipMessage(null);
    if (membershipLists.length) return;
    setMembershipBusy(true);
    setError(null);
    try {
      const response = await apiRequest<AccountPageResult>(
        '/account/lists?page=1&limit=100',
        uuid,
        password
      );
      const lists = catalogItems(response.data, 100).filter((list) =>
        /^\d{1,18}$/.test(String(list.id ?? ''))
      );
      setMembershipLists(lists);
      setMembershipListId((current) => current || String(lists[0]?.id ?? ''));
      if (!lists.length)
        setMembershipMessage(
          'Create a WeTrakr list first, then add titles here.'
        );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not load your WeTrakr lists.'
      );
      setMembershipPickerOpen(false);
    } finally {
      setMembershipBusy(false);
    }
  };

  const saveMembership = async (
    item: WeTrakrCatalogItem,
    mediaType: string,
    list: WeTrakrCatalogItem,
    state: 'list' | 'deleted'
  ) => {
    const record = makeListMembershipRecord(item, mediaType, list, state);
    if (!record) {
      setError('This title does not include a supported WeTrakr media id.');
      return;
    }
    setMembershipBusy(true);
    setError(null);
    setMembershipMessage(null);
    try {
      const response = await apiRequest<{
        success?: boolean;
        data?: {
          changed?: number;
          providerSync?: {
            pendingProviders?: string[];
            syncedProviders?: string[];
            unsupportedProviders?: string[];
            unsupportedWrites?: Array<{
              providerId: string;
              skipped: number;
            }>;
          };
        };
      }>(
        '/records',
        uuid,
        password,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ records: [record] }),
        },
        '/api/v1/tracking/v1'
      );
      const sync = response.data?.providerSync;
      const pending = sync?.pendingProviders ?? [];
      const unsupportedAdapters = sync?.unsupportedProviders ?? [];
      const unsupportedWrites = sync?.unsupportedWrites ?? [];
      if (response.data?.changed === 0) {
        setMembershipMessage(
          'No new list-membership change was applied; the merged ledger already has this value or a newer one. Refresh and retry if that was unexpected.'
        );
        return;
      }
      setMembershipMessage(
        pending.length
          ? `Saved to the AIOStreams ledger; waiting for ${pending.join(', ')}.`
          : state === 'list'
            ? `Added to “${String(list.name ?? list.title ?? 'list')}” through the merged tracker.${unsupportedAdapters.length ? ` No adapter for: ${unsupportedAdapters.join(', ')}.` : ''}${unsupportedWrites.length ? ` Skipped by: ${unsupportedWrites.map(({ providerId, skipped: count }) => `${providerId} (${count})`).join(', ')}.` : ''}`
            : `Removed from “${String(list.name ?? list.title ?? 'list')}” through the merged tracker.${unsupportedAdapters.length ? ` No adapter for: ${unsupportedAdapters.join(', ')}.` : ''}${unsupportedWrites.length ? ` Skipped by: ${unsupportedWrites.map(({ providerId, skipped: count }) => `${providerId} (${count})`).join(', ')}.` : ''}`
      );
      if (accountView === 'list-items' && selectedList?.id === list.id)
        await loadAccountPage('list-items', accountPage, selectedList);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The merged list change could not be saved.'
      );
    } finally {
      setMembershipBusy(false);
    }
  };

  const saveCatalogRecord = async (
    record: ReturnType<typeof makeCatalogTrackerRecord>,
    actionLabel: string
  ) => {
    if (!record) {
      setError('This item does not have a supported identity for this change.');
      return;
    }
    setMembershipBusy(true);
    setError(null);
    setMembershipMessage(null);
    try {
      const response = await apiRequest<{
        success?: boolean;
        data?: {
          changed?: number;
          providerSync?: {
            syncedProviders?: string[];
            pendingProviders?: string[];
            unsupportedProviders?: string[];
            unsupportedWrites?: Array<{
              providerId: string;
              skipped: number;
            }>;
          };
        };
      }>(
        '/records',
        uuid,
        password,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ records: [record] }),
        },
        '/api/v1/tracking/v1'
      );
      const providerSync = response.data?.providerSync;
      const pending = providerSync?.pendingProviders ?? [];
      const unsupported = providerSync?.unsupportedWrites ?? [];
      const unsupportedAdapters = providerSync?.unsupportedProviders ?? [];
      const synced = providerSync?.syncedProviders ?? [];
      if (response.data?.changed === 0) {
        setMembershipMessage(
          `No new ${actionLabel.toLowerCase()} value was applied; the merged ledger already has this value or a newer one. Refresh and retry if that was unexpected.`
        );
        return;
      }
      setMembershipMessage(
        pending.length
          ? `${actionLabel} saved to the merged ledger; waiting for ${pending.join(', ')}.`
          : `${actionLabel} saved${synced.length ? ` through ${synced.join(', ')}` : ' to the merged ledger'}.${unsupportedAdapters.length ? ` No adapter for: ${unsupportedAdapters.join(', ')}.` : ''}${unsupported.length ? ` Unsupported by: ${unsupported.map(({ providerId }) => providerId).join(', ')}.` : ''}`
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The tracker update could not be saved.'
      );
    } finally {
      setMembershipBusy(false);
    }
  };

  const saveCatalogMutation = async (
    item: WeTrakrCatalogItem,
    mediaType: string,
    mutation: CatalogTrackerMutation
  ) => {
    const record = makeCatalogTrackerRecord(item, mediaType, mutation);
    const actionLabel =
      mutation.state === 'rated'
        ? 'Rating'
        : mutation.state === 'favorite'
          ? 'Favorite'
          : mutation.state === 'note'
            ? 'Note'
            : 'Comment';
    await saveCatalogRecord(record, actionLabel);
  };

  const removeCatalogFacet = async (
    item: WeTrakrCatalogItem,
    mediaType: string,
    state: 'favorite' | 'rated'
  ) => {
    const record = makeCatalogTrackerTombstone(item, mediaType, state);
    await saveCatalogRecord(
      record,
      state === 'favorite'
        ? 'Favorite removal'
        : 'Rating removal'
    );
  };

  const promptForRating = (item: WeTrakrCatalogItem, mediaType: string) => {
    const value = window.prompt('Rating from 0 to 10:', '8');
    if (value === null) return;
    const rating = Number(value.trim());
    if (!Number.isFinite(rating) || rating < 0 || rating > 10) {
      setError('Enter a rating from 0 to 10.');
      return;
    }
    void saveCatalogMutation(item, mediaType, { state: 'rated', rating });
  };

  const promptForNote = (item: WeTrakrCatalogItem, mediaType: string) => {
    const text = window.prompt('Personal note (up to 10,000 characters):');
    if (text === null) return;
    if (!text.trim() || text.length > 10_000) {
      setError('Enter a non-empty note of at most 10,000 characters.');
      return;
    }
    void saveCatalogMutation(item, mediaType, { state: 'note', text });
  };

  const promptForComment = (item: WeTrakrCatalogItem, mediaType: string) => {
    const text = window.prompt(
      'Comment (up to 10,000 characters). Leave blank to cancel:'
    );
    if (text === null) return;
    if (text.length > 10_000) {
      setError('Comments can be at most 10,000 characters.');
      return;
    }
    const reaction = window.prompt(
      'Optional reaction (leave blank for a text-only comment):'
    );
    if (reaction === null) return;
    if (!text.trim() && !reaction.trim()) {
      setError('Enter comment text or a reaction.');
      return;
    }
    if (reaction.length > 80) {
      setError('Reactions can be at most 80 characters.');
      return;
    }
    void saveCatalogMutation(item, mediaType, {
      state: 'comment',
      ...(text.trim() ? { text } : {}),
      ...(reaction.trim() ? { reaction } : {}),
    });
  };

  const loadAccountPage = async (
    view: AccountView,
    page = 1,
    list: WeTrakrCatalogItem | null = null,
    target?: 'movies' | 'episodes'
  ) => {
    setAccountBusy(true);
    setError(null);
    setAccountItems([]);
    setAccountView(view);
    setAccountPage(page);
    setSelectedList(view === 'list-items' ? list : null);
    try {
      if (view === 'list-items' && !list?.id)
        throw new Error('This WeTrakr list has no usable id.');
      const query = new URLSearchParams({ page: String(page), limit: '40' });
      if (view === 'history') {
        const selectedTarget = target ?? historyTarget;
        setHistoryTarget(selectedTarget);
        query.set('target', selectedTarget);
      }
      const path =
        view === 'history'
          ? `/account/history?${query}`
          : view === 'lists'
            ? `/account/lists?${query}`
            : view === 'list-items'
              ? `/account/lists/${encodeURIComponent(String(list?.id))}/items?${query}`
              : `/account/facets/${encodeURIComponent(view)}?${query}`;
      const response = await apiRequest<AccountPageResult>(
        path,
        uuid,
        password
      );
      const rows = catalogItems(response.data);
      setAccountItems(rows);
      setAccountPageCount(
        Number.isSafeInteger(response.pagination?.pageCount) &&
          Number(response.pagination?.pageCount) >= 0
          ? Number(response.pagination?.pageCount)
          : null
      );
      if (!rows.length)
        setCatalogMessage(
          view === 'list-items'
            ? 'This list has no items on this page.'
            : `No ${accountViewTitles[view].toLowerCase()} on this page.`
        );
      else setCatalogMessage(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not load WeTrakr account data.'
      );
      setAccountView(null);
    } finally {
      setAccountBusy(false);
    }
  };

  const accountPageHasNext =
    accountPageCount !== null
      ? accountPage < accountPageCount
      : accountItems.length === 40;

  const mutateList = async (
    action: 'create' | 'rename' | 'delete',
    list?: WeTrakrCatalogItem
  ) => {
    const listId = list?.id === undefined ? '' : String(list.id);
    if (action !== 'create' && !/^\d{1,18}$/.test(listId)) {
      setError('This WeTrakr list has no usable id.');
      return;
    }

    if (
      action === 'delete' &&
      !window.confirm(
        `Delete “${String(list?.name ?? list?.title ?? 'this list')}” and its WeTrakr items? This cannot be undone.`
      )
    )
      return;

    let body: Record<string, unknown> | undefined;
    if (action === 'create') {
      const name = window
        .prompt('New list name (up to 100 characters):')
        ?.trim();
      if (!name) return;
      const description =
        window.prompt('Optional description (up to 2000 characters):') ?? '';
      const privacy = window
        .prompt('Visibility: private, friends, or public', 'private')
        ?.trim()
        .toLowerCase();
      if (!privacy || !['private', 'friends', 'public'].includes(privacy)) {
        setError('Choose private, friends, or public visibility.');
        return;
      }
      body = { name, description, privacy };
    } else if (action === 'rename') {
      const currentName = String(list?.name ?? list?.title ?? '');
      const name = window.prompt('List name:', currentName)?.trim();
      if (!name || name === currentName) return;
      body = { name };
    }

    setAccountBusy(true);
    setError(null);
    try {
      await apiRequest(
        action === 'create'
          ? '/account/lists'
          : `/account/lists/${encodeURIComponent(listId)}`,
        uuid,
        password,
        {
          method:
            action === 'create'
              ? 'POST'
              : action === 'rename'
                ? 'PUT'
                : 'DELETE',
          ...(body ? { body: JSON.stringify(body) } : {}),
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
        }
      );
      setAccountBusy(false);
      await loadAccountPage('lists', action === 'create' ? 1 : accountPage);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'WeTrakr list update failed.'
      );
      setAccountBusy(false);
    }
  };

  const editListSettings = async (list: WeTrakrCatalogItem) => {
    const listId = list.id === undefined ? '' : String(list.id);
    if (!/^\d{1,18}$/.test(listId)) {
      setError('This WeTrakr list has no usable id.');
      return;
    }
    const name = window.prompt(
      'List name:',
      String(list.name ?? list.title ?? '')
    );
    if (name === null) return;
    const description = window.prompt(
      'Description (up to 2000 characters):',
      String(list.description ?? '')
    );
    if (description === null) return;
    const privacy = window
      .prompt(
        'Visibility: private, friends, or public',
        String(list.privacy ?? 'private')
      )
      ?.trim()
      .toLowerCase();
    if (!privacy || !['private', 'friends', 'public'].includes(privacy)) {
      setError('Choose private, friends, or public visibility.');
      return;
    }
    const commentsAllowed = window
      .prompt(
        'Allow comments? Enter yes or no.',
        list.allow_comments === false ? 'no' : 'yes'
      )
      ?.trim()
      .toLowerCase();
    if (!commentsAllowed || !['yes', 'no'].includes(commentsAllowed)) {
      setError('Choose yes or no for list comments.');
      return;
    }
    const sortBy = window
      .prompt(
        'Sort by: rank, added, title, released, runtime, popularity, percentage, votes, my_rating, random, or watched.',
        String(list.sort_by ?? 'rank')
      )
      ?.trim()
      .toLowerCase();
    if (!sortBy) return;
    const sortHow = window
      .prompt('Sort direction: asc or desc.', String(list.sort_how ?? 'asc'))
      ?.trim()
      .toLowerCase();
    if (!sortHow || !['asc', 'desc'].includes(sortHow)) {
      setError('Choose asc or desc for list order.');
      return;
    }
    setAccountBusy(true);
    setError(null);
    try {
      await apiRequest(
        `/account/lists/${encodeURIComponent(listId)}`,
        uuid,
        password,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            description,
            privacy,
            allow_comments: commentsAllowed === 'yes',
            sort_by: sortBy,
            sort_how: sortHow,
          }),
        }
      );
      setAccountBusy(false);
      await loadAccountPage('lists', accountPage);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'WeTrakr list settings could not be saved.'
      );
      setAccountBusy(false);
    }
  };

  const timeLeft = flow ? remaining(flow.expiresAt, now) : '0:00';

  return (
    <div className="space-y-4 rounded-xl border border-[--border] bg-[--surface] p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-300 ring-1 ring-cyan-400/20"
            >
              W
            </span>
            <h3 className="text-lg font-semibold">WeTrakr</h3>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-[--muted]">
            Link WeTrakr to this AIOStreams profile. AIOStreams is the single
            tracker hub Nuvio connects to: it merges enabled providers and
            forwards live playback, watch-state, list, rating, and deletion
            changes to them. While Nuvio sync is active, AIOStreams checks
            WeTrakr's change journal every five minutes; playback events are
            forwarded immediately. Each AIOStreams profile supplies its own
            WeTrakr app key; credentials are not saved in shareable config and
            tokens are encrypted server-side.
          </p>
        </div>
      </div>

      <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span>WeTrakr client ID / API key</span>
          <input autoComplete="off" className="w-full rounded-md border border-[--border] bg-[--surface] px-3 py-2" value={clientId} onChange={(event) => setClientId(event.target.value)} />
        </label>
        <label className="space-y-1 text-sm">
          <span>WeTrakr client secret (if issued)</span>
          <input autoComplete="new-password" type="password" className="w-full rounded-md border border-[--border] bg-[--surface] px-3 py-2" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} />
        </label>
      </div>
      {!flow && (
        <Button type="button" onClick={connect} loading={busy} disabled={!clientId.trim()}>
          {authRef ? 'Relink with these app credentials' : 'Connect WeTrakr'}
        </Button>
      )}

      {error && <Alert intent="alert">{error}</Alert>}
      {syncSummary && <Alert intent="success">{syncSummary}</Alert>}

      {flow && (
        <div className="max-w-xl space-y-3 rounded-lg border border-[--border] bg-[--subtle] p-4">
          <p className="text-sm text-[--muted]">
            Approve this AIOStreams connection on WeTrakr. The code expires in{' '}
            {timeLeft}.
          </p>
          <div className="rounded-md bg-[--surface] p-4 text-center">
            <p className="text-xs uppercase tracking-wide text-[--muted]">
              Device code
            </p>
            <p className="mt-1 font-mono text-3xl font-bold tracking-[0.2em]">
              {flow.userCode}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              onClick={() =>
                window.open(
                  flow.verificationUri,
                  '_blank',
                  'noopener,noreferrer'
                )
              }
            >
              Open WeTrakr approval
            </Button>
            <span className="text-sm text-[--muted]">
              Waiting for approval…
            </span>
            <Button
              type="button"
              intent="gray-outline"
              onClick={() => setFlow(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {authRef && !flow && (
        <div className="flex flex-wrap items-center gap-3">
          <Alert intent="success">
            WeTrakr account is linked in this configuration;{' '}
            {trackerEnabled ? 'live sync is enabled.' : 'live sync is paused.'}
          </Alert>
          <Button
            type="button"
            intent={trackerEnabled ? 'gray-outline' : 'primary-outline'}
            onClick={() => setTrackerEnabled(!trackerEnabled)}
          >
            {trackerEnabled ? 'Pause live sync' : 'Enable live sync'}
          </Button>
          <Button
            type="button"
            intent="primary"
            onClick={syncNow}
            loading={syncing}
          >
            Backfill / merge now
          </Button>
          <Button
            type="button"
            intent="gray-outline"
            onClick={disconnect}
            loading={busy}
          >
            Disconnect
          </Button>
        </div>
      )}

      <p className="text-xs text-[--muted]">
        The initial backfill is separate from ongoing sync. While enabled,
        changes received from Nuvio are merged by AIOStreams and fanned out to
        every configured provider with a supported adapter. Disabling this link
        pauses WeTrakr fan-out without disconnecting the account.
      </p>

      {authRef && (
        <p className="text-xs text-[--muted]">
          Link and enable changes are part of your AIOStreams configuration.
          Use the main Save button before browsing account data or running a
          backfill; this panel does not save other pending configuration
          changes automatically.
        </p>
      )}

      {authRef && trackerEnabled && (
        <details className="border-t border-[--border] pt-4">
          <summary className="cursor-pointer select-none py-1 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
            Browse WeTrakr account and catalogs
          </summary>
          <section
            className="mt-3 space-y-3"
            aria-label="WeTrakr account and catalog tools"
          >
          <div>
            <h4 className="font-semibold">WeTrakr discovery</h4>
            <p className="text-sm text-[--muted]">
              Search titles or browse a WeTrakr catalog through this AIOStreams
              account.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Catalog media type"
              className="rounded-md border border-[--border] bg-[--surface] px-3 py-2 text-sm"
              value={catalogType}
              onChange={(event) => setCatalogType(event.target.value)}
            >
              <option value="movie">Movies</option>
              <option value="show">Shows</option>
              <option value="person">People</option>
              <option value="list">Lists</option>
              <option value="comment">Comments</option>
            </select>
            <select
              aria-label="WeTrakr catalog"
              className="rounded-md border border-[--border] bg-[--surface] px-3 py-2 text-sm"
              value={catalogSection}
              onChange={(event) => setCatalogSection(event.target.value)}
            >
              <option value="trending">Trending</option>
              <option value="popular">Popular</option>
              <option value="toprated">Top rated</option>
              <option value="favorited">Most favorited</option>
              <option value="listed">Most listed</option>
              <option value="planning">Planning</option>
              <option value="watched">Watched</option>
              <option value="last">Recently active</option>
              <option value="ranks">Ranked</option>
            </select>
            <Button
              type="button"
              intent="gray-outline"
              onClick={() => void loadCatalog()}
              loading={catalogBusy}
            >
              Browse
            </Button>
          </div>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void loadCatalog(true);
            }}
          >
            <input
              aria-label="Search WeTrakr"
              className="min-w-48 flex-1 rounded-md border border-[--border] bg-[--surface] px-3 py-2 text-sm"
              maxLength={160}
              placeholder="Search WeTrakr titles…"
              value={catalogQuery}
              onChange={(event) => setCatalogQuery(event.target.value)}
            />
            <Button type="submit" loading={catalogBusy}>
              Search
            </Button>
          </form>
          {catalogMessage && (
            <p className="text-sm text-[--muted]" role="status">
              {catalogMessage}
            </p>
          )}
          {catalogResults.length > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
              {catalogResults.map((item, index) => {
                const title = String(item.title ?? item.name ?? 'Untitled');
                const poster = catalogPoster(item);
                return (
                  <article
                    key={String(item.id ?? `${title}-${index}`)}
                    className="overflow-hidden rounded-lg border border-[--border] bg-[--subtle]"
                  >
                    {poster ? (
                      <img
                        src={poster}
                        alt=""
                        loading="lazy"
                        className="aspect-[2/3] w-full object-cover"
                      />
                    ) : (
                      <div
                        className="flex aspect-[2/3] items-center justify-center bg-[--surface] text-3xl text-[--muted]"
                        aria-hidden="true"
                      >
                        ◈
                      </div>
                    )}
                    <div className="p-2">
                      <p
                        className="line-clamp-2 text-sm font-medium"
                        title={title}
                      >
                        {title}
                      </p>
                      {item.year && (
                        <p className="mt-1 text-xs text-[--muted]">
                          {String(item.year)}
                        </p>
                      )}
                      <Button
                        type="button"
                        intent="gray-outline"
                        className="mt-2 w-full"
                        onClick={() => void loadCatalogDetail(item)}
                        loading={catalogDetailBusy}
                      >
                        Details
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          {catalogDetail && (
            <section
              className="space-y-2 rounded-lg border border-[--border] bg-[--subtle] p-4"
              aria-label="WeTrakr catalog details"
              aria-live="polite"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h4 className="font-semibold">
                  {String(
                    catalogDetail.title ??
                      catalogDetail.name ??
                      'WeTrakr title details'
                  )}
                </h4>
                <Button
                  type="button"
                  intent="gray-outline"
                  onClick={() => setCatalogDetail(null)}
                >
                  Close details
                </Button>
              </div>
              {typeof catalogDetail.overview === 'string' && (
                <p className="max-w-4xl whitespace-pre-line text-sm text-[--muted]">
                  {catalogDetail.overview}
                </p>
              )}
              {typeof catalogDetail.description === 'string' &&
                typeof catalogDetail.overview !== 'string' && (
                  <p className="max-w-4xl whitespace-pre-line text-sm text-[--muted]">
                    {catalogDetail.description}
                  </p>
                )}
              {Array.isArray(catalogDetail.seasons) && (
                <p className="text-sm text-[--muted]">
                  {catalogDetail.seasons.length} seasons ·{' '}
                  {catalogDetail.seasons.reduce((total, season) => {
                    if (!season || typeof season !== 'object') return total;
                    const episodes = (season as Record<string, unknown>)
                      .episodes;
                    return (
                      total + (Array.isArray(episodes) ? episodes.length : 0)
                    );
                  }, 0)}{' '}
                  appended episodes
                </p>
              )}
              {['movie', 'show', 'person'].includes(catalogType) && (
                <div className="space-y-2 border-t border-[--border] pt-3">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      intent="gray-outline"
                      onClick={() =>
                        void saveCatalogMutation(
                          catalogDetail as WeTrakrCatalogItem,
                          catalogType,
                          { state: 'favorite' }
                        )
                      }
                      disabled={membershipBusy}
                      loading={membershipBusy}
                    >
                      Add favorite
                    </Button>
                    <Button
                      type="button"
                      intent="gray-outline"
                      onClick={() =>
                        promptForRating(
                          catalogDetail as WeTrakrCatalogItem,
                          catalogType
                        )
                      }
                      disabled={membershipBusy}
                    >
                      Rate
                    </Button>
                    <Button
                      type="button"
                      intent="gray-outline"
                      onClick={() =>
                        promptForNote(
                          catalogDetail as WeTrakrCatalogItem,
                          catalogType
                        )
                      }
                      disabled={membershipBusy}
                    >
                      Add or update note
                    </Button>
                    <Button
                      type="button"
                      intent="gray-outline"
                      onClick={() =>
                        promptForComment(
                          catalogDetail as WeTrakrCatalogItem,
                          catalogType
                        )
                      }
                      disabled={membershipBusy}
                    >
                      Post comment
                    </Button>
                  </div>
                  {!membershipPickerOpen ? (
                    <Button
                      type="button"
                      intent="primary-outline"
                      onClick={() => void openMembershipPicker()}
                      loading={membershipBusy}
                    >
                      Add to a WeTrakr list
                    </Button>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      {membershipLists.length > 0 && (
                        <>
                          <select
                            aria-label="Choose WeTrakr list"
                            className="min-w-48 rounded-md border border-[--border] bg-[--surface] px-3 py-2 text-sm"
                            value={membershipListId}
                            onChange={(event) =>
                              setMembershipListId(event.target.value)
                            }
                            disabled={membershipBusy}
                          >
                            {membershipLists.map((list) => (
                              <option
                                key={String(list.id)}
                                value={String(list.id)}
                              >
                                {String(
                                  list.name ?? list.title ?? `List ${list.id}`
                                )}
                              </option>
                            ))}
                          </select>
                          <Button
                            type="button"
                            intent="primary"
                            onClick={() => {
                              const list = membershipLists.find(
                                (candidate) =>
                                  String(candidate.id) === membershipListId
                              );
                              if (list)
                                void saveMembership(
                                  catalogDetail as WeTrakrCatalogItem,
                                  catalogType,
                                  list,
                                  'list'
                                );
                            }}
                            disabled={membershipBusy || !membershipListId}
                            loading={membershipBusy}
                          >
                            Add title
                          </Button>
                        </>
                      )}
                      <Button
                        type="button"
                        intent="gray-outline"
                        onClick={() => setMembershipPickerOpen(false)}
                        disabled={membershipBusy}
                      >
                        Cancel
                      </Button>
                    </div>
                  )}
                  {membershipMessage && (
                    <p className="text-sm text-[--muted]" role="status">
                      {membershipMessage}
                    </p>
                  )}
                </div>
              )}
            </section>
          )}
          <div className="flex flex-wrap items-center gap-2 border-t border-[--border] pt-4">
            <span className="mr-1 text-sm font-medium">My WeTrakr data</span>
            <Button
              type="button"
              intent={accountView === 'lists' ? 'primary' : 'gray-outline'}
              onClick={() => void loadAccountPage('lists')}
              loading={accountBusy && accountView === 'lists'}
            >
              Custom lists
            </Button>
            {accountView === 'lists' && (
              <Button
                type="button"
                intent="primary"
                onClick={() => void mutateList('create')}
                disabled={accountBusy}
              >
                Create list
              </Button>
            )}
            {(['movies', 'episodes'] as const).map((target) => (
              <Button
                key={`history-${target}`}
                type="button"
                intent={
                  accountView === 'history' && historyTarget === target
                    ? 'primary'
                    : 'gray-outline'
                }
                onClick={() => void loadAccountPage('history', 1, null, target)}
                loading={
                  accountBusy &&
                  accountView === 'history' &&
                  historyTarget === target
                }
              >
                {target === 'movies' ? 'Movie history' : 'Episode history'}
              </Button>
            ))}
            {(
              [
                'progress',
                'playing',
                'waiting',
                'planning',
                'dropped',
                'paused',
                'ignored',
                'ratings',
                'favorites',
                'likes',
                'notes',
                'comments',
              ] as const
            ).map((view) => (
              <Button
                key={view}
                type="button"
                intent={accountView === view ? 'primary' : 'gray-outline'}
                onClick={() => void loadAccountPage(view)}
                loading={accountBusy && accountView === view}
              >
                {accountViewTitles[view]}
              </Button>
            ))}
          </div>
          {accountView && (
            <div className="space-y-3" aria-live="polite">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {accountView === 'list-items' && (
                    <Button
                      type="button"
                      intent="gray-outline"
                      onClick={() => void loadAccountPage('lists')}
                      disabled={accountBusy}
                    >
                      All lists
                    </Button>
                  )}
                  <h4 className="font-semibold">
                    {accountView === 'list-items'
                      ? String(
                          selectedList?.name ??
                            selectedList?.title ??
                            accountViewTitles[accountView]
                        )
                      : accountViewTitles[accountView]}
                  </h4>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[--muted]">
                    Page {accountPage}
                    {accountPageCount ? ` of ${accountPageCount}` : ''}
                  </span>
                  <Button
                    type="button"
                    intent="gray-outline"
                    onClick={() =>
                      void loadAccountPage(
                        accountView,
                        accountPage - 1,
                        selectedList
                      )
                    }
                    disabled={accountBusy || accountPage <= 1}
                  >
                    Previous
                  </Button>
                  <Button
                    type="button"
                    intent="gray-outline"
                    onClick={() =>
                      void loadAccountPage(
                        accountView,
                        accountPage + 1,
                        selectedList
                      )
                    }
                    disabled={accountBusy || !accountPageHasNext}
                    loading={accountBusy}
                  >
                    Next
                  </Button>
                </div>
              </div>
              {accountItems.length > 0 && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
                  {accountItems.map((item, index) => {
                    const title = String(
                      item.title ?? item.name ?? item.text ?? 'Untitled'
                    );
                    const poster = catalogPoster(item);
                    const id = item.id;
                    const permissions =
                      item.permissions && typeof item.permissions === 'object'
                        ? (item.permissions as Record<string, unknown>)
                        : {};
                    const canManageList = permissions.is_owner === true;
                    return (
                      <article
                        key={String(id ?? `${title}-${index}`)}
                        className="overflow-hidden rounded-lg border border-[--border] bg-[--subtle]"
                      >
                        {poster ? (
                          <img
                            src={poster}
                            alt=""
                            loading="lazy"
                            className="aspect-[2/3] w-full object-cover"
                          />
                        ) : (
                          <div
                            className="flex aspect-[2/3] items-center justify-center bg-[--surface] text-3xl text-[--muted]"
                            aria-hidden="true"
                          >
                            ◈
                          </div>
                        )}
                        <div className="space-y-2 p-2">
                          <p
                            className="line-clamp-2 text-sm font-medium"
                            title={title}
                          >
                            {title}
                          </p>
                          {item.year && (
                            <p className="text-xs text-[--muted]">
                              {String(item.year)}
                            </p>
                          )}
                          {accountView === 'favorites' && (
                            <Button
                              type="button"
                              intent="gray-outline"
                              onClick={() => {
                                if (
                                  !window.confirm(
                                    `Remove “${title}” from merged favorites?`
                                  )
                                )
                                  return;
                                void removeCatalogFacet(
                                  item,
                                  listItemMediaType(item),
                                  'favorite'
                                );
                              }}
                              disabled={membershipBusy}
                              loading={membershipBusy}
                            >
                              Remove favorite
                            </Button>
                          )}
                          {accountView === 'ratings' && (
                            <Button
                              type="button"
                              intent="gray-outline"
                              onClick={() => {
                                if (
                                  !window.confirm(
                                    `Remove your rating for “${title}” from merged trackers?`
                                  )
                                )
                                  return;
                                void removeCatalogFacet(
                                  item,
                                  listItemMediaType(item),
                                  'rated'
                                );
                              }}
                              disabled={membershipBusy}
                              loading={membershipBusy}
                            >
                              Remove rating
                            </Button>
                          )}
                          {accountView === 'lists' &&
                            id !== undefined &&
                            id !== null && (
                              <div className="flex flex-wrap gap-2">
                                <Button
                                  type="button"
                                  intent="primary-outline"
                                  onClick={() =>
                                    void loadAccountPage('list-items', 1, item)
                                  }
                                  disabled={accountBusy}
                                >
                                  Open list
                                </Button>
                                <Button
                                  type="button"
                                  intent="gray-outline"
                                  onClick={() => void editListSettings(item)}
                                  disabled={accountBusy || !canManageList}
                                >
                                  Settings
                                </Button>
                                <Button
                                  type="button"
                                  intent="gray-outline"
                                  onClick={() =>
                                    void mutateList('rename', item)
                                  }
                                  disabled={accountBusy || !canManageList}
                                >
                                  Rename
                                </Button>
                                <Button
                                  type="button"
                                  intent="gray-outline"
                                  onClick={() =>
                                    void mutateList('delete', item)
                                  }
                                  disabled={accountBusy || !canManageList}
                                >
                                  Delete
                                </Button>
                              </div>
                            )}
                          {accountView === 'list-items' && selectedList && (
                            <Button
                              type="button"
                              intent="gray-outline"
                              onClick={() => {
                                if (
                                  !window.confirm(
                                    `Remove “${title}” from “${String(selectedList.name ?? selectedList.title ?? 'this list')}”?`
                                  )
                                )
                                  return;
                                void saveMembership(
                                  item,
                                  listItemMediaType(item),
                                  selectedList,
                                  'deleted'
                                );
                              }}
                              disabled={membershipBusy}
                              loading={membershipBusy}
                            >
                              Remove from list
                            </Button>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          </section>
        </details>
      )}
    </div>
  );
}

export function TrackerProviders() {
  return (
    <div className="space-y-4">
      <TraktTrackerCard />
      <WeTrakrTrackerCard />
      <FloppyTrackerCard />
    </div>
  );
}
