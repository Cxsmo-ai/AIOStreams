import { Router, type Request } from 'express';
import { randomUUID } from 'node:crypto';
import {
  APIError,
  constants,
  pollWeTrakrDeviceToken,
  removeWeTrakrToken,
  requestWeTrakrDeviceCode,
  storeWeTrakrToken,
  UserRepository,
  fetchWeTrakrAccountRecords,
  getDb,
  requestWeTrakrApi,
  WeTrakrApiError,
  WeTrakrRateLimitError,
  type WeTrakrDeviceCode,
  type WeTrakrApplicationCredentials,
  type WeTrakrToken,
  type DbDriver,
} from '@aiostreams/core';
import { userApiRateLimiter } from '../../middlewares/ratelimit.js';
import { parseBasicAuthHeader } from '../../utils/basic-auth.js';

type DeviceLinkState = {
  userUuid: string;
  device: WeTrakrDeviceCode;
  expiresAt: number;
  nextPollAt: number;
  polling: boolean;
  applicationCredentials?: WeTrakrApplicationCredentials;
  authRef?: string;
  error?: string;
};

export interface WeTrakrRouterDependencies {
  authenticate: (
    uuid: string,
    password: string
  ) => Promise<{
    trackerProviders?: { wetrakr?: { authRef?: string; enabled?: boolean } };
  } | null>;
  requestDeviceCode: (credentials: WeTrakrApplicationCredentials) => Promise<WeTrakrDeviceCode>;
  pollDeviceToken: (
    deviceCode: string,
    credentials: WeTrakrApplicationCredentials
  ) => Promise<
    | { status: 'pending'; retryAfter: number }
    | { status: 'authorized'; token: WeTrakrToken }
  >;
  storeToken: (token: WeTrakrToken, credentials: WeTrakrApplicationCredentials) => Promise<string>;
  removeToken: (reference: string) => Promise<void>;
  requestApi: (
    reference: string,
    path: string,
    init?: {
      method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      body?: unknown;
      idempotencyKey?: string;
    }
  ) => Promise<{ data: unknown; headers: Headers }>;
  database: () => DbDriver;
  rateLimiter?: import('express').RequestHandler;
}

export function createWeTrakrRouter(
  dependencies: WeTrakrRouterDependencies = {
    authenticate: async (uuid, password) =>
      (await UserRepository.getUser(uuid, password)) ?? null,
    requestDeviceCode: requestWeTrakrDeviceCode,
    pollDeviceToken: pollWeTrakrDeviceToken,
    storeToken: storeWeTrakrToken,
    removeToken: removeWeTrakrToken,
    requestApi: (reference, path, init) =>
      requestWeTrakrApi(reference, path, init),
    database: getDb,
    rateLimiter: userApiRateLimiter,
  }
): Router {
  const router: Router = Router();
  const states = new Map<string, DeviceLinkState>();
  router.use(dependencies.rateLimiter ?? userApiRateLimiter);

  function cleanExpiredStates(now = Date.now()): void {
    for (const [key, state] of states) {
      if (state.expiresAt <= now) states.delete(key);
    }
  }

  async function linkedProviderReference(req: Request): Promise<string | null> {
    const { user } = await authenticatedUser(req);
    const provider = user.trackerProviders?.wetrakr;
    if (!provider?.authRef || provider.enabled === false) return null;
    return provider.authRef;
  }

  function pageQuery(req: Request): URLSearchParams {
    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 50);
    if (!Number.isInteger(page) || page < 1 || page > 10_000)
      throw new APIError(
        constants.ErrorCode.MISSING_REQUIRED_FIELDS,
        undefined,
        'Invalid page'
      );
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new APIError(
        constants.ErrorCode.MISSING_REQUIRED_FIELDS,
        undefined,
        'Invalid page size'
      );
    return new URLSearchParams({ page: String(page), limit: String(limit) });
  }

  const accountFacetPaths: Record<string, string> = {
    progress: '/sync/tracking/watching/all',
    playing: '/sync/tracking/playing/all',
    waiting: '/sync/tracking/waiting/all',
    planning: '/sync/tracking/planning/all',
    dropped: '/sync/tracking/dropped/all',
    paused: '/sync/tracking/paused/all',
    ratings: '/sync/ratings/all',
    favorites: '/sync/favorites/all',
    // Account likes are part of the /sync API and support the `all` target.
    likes: '/sync/likes/all',
    notes: '/sync/notes/all',
    comments: '/sync/comments/all?include_replies=true',
  };

  async function proxyRead(
    authRef: string,
    path: string,
    res: import('express').Response
  ): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const result = await dependencies.requestApi(authRef, path);
      const rawPageCount = result.headers.get('x-pagination-page-count');
      const rawItemCount = result.headers.get('x-pagination-item-count');
      const parsedPageCount =
        rawPageCount === null ? NaN : Number(rawPageCount);
      const parsedItemCount =
        rawItemCount === null ? NaN : Number(rawItemCount);
      const pageCount =
        Number.isSafeInteger(parsedPageCount) && parsedPageCount >= 0
          ? parsedPageCount
          : undefined;
      const itemCount =
        Number.isSafeInteger(parsedItemCount) && parsedItemCount >= 0
          ? parsedItemCount
          : undefined;
      res.status(200).json({
        success: true,
        data: result.data,
        ...(pageCount !== undefined || itemCount !== undefined
          ? {
              pagination: {
                ...(pageCount !== undefined ? { pageCount } : {}),
                ...(itemCount !== undefined ? { itemCount } : {}),
              },
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof WeTrakrRateLimitError) {
        res.setHeader(
          'Retry-After',
          String(Math.max(1, Math.ceil(error.retryAfterMs / 1000)))
        );
        res
          .status(429)
          .json({ error: error.message, retryAfterMs: error.retryAfterMs });
      } else if (error instanceof WeTrakrApiError) {
        // Expose only the upstream status; never forward provider bodies/tokens.
        const status =
          error.status >= 400 && error.status <= 599 ? error.status : 502;
        res.status(status).json({ error: error.message });
      } else {
        res.status(502).json({ error: 'WeTrakr read operation failed.' });
      }
    }
  }

  function parseListMutation(
    value: unknown,
    requireName: boolean
  ): { body?: Record<string, unknown>; error?: string } {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return { error: 'A JSON object is required.' };
    const input = value as Record<string, unknown>;
    const body: Record<string, unknown> = {};
    if (requireName || Object.hasOwn(input, 'name')) {
      if (typeof input.name !== 'string')
        return { error: 'List name must be text.' };
      const name = input.name.trim();
      if (!name || name.length > 100 || /[\u0000-\u001f]/.test(name))
        return { error: 'List name must be 1–100 printable characters.' };
      body.name = name;
    }
    if (Object.hasOwn(input, 'description')) {
      if (
        typeof input.description !== 'string' ||
        input.description.length > 2000
      )
        return {
          error: 'Description must be text with at most 2000 characters.',
        };
      body.description = input.description;
    }
    if (Object.hasOwn(input, 'privacy')) {
      if (!['private', 'friends', 'public'].includes(String(input.privacy)))
        return { error: 'Privacy must be private, friends, or public.' };
      body.privacy = input.privacy;
    }
    if (Object.hasOwn(input, 'allow_comments')) {
      if (typeof input.allow_comments !== 'boolean')
        return { error: 'allow_comments must be a boolean.' };
      body.allow_comments = input.allow_comments;
    }
    if (Object.hasOwn(input, 'sort_by')) {
      if (
        ![
          'rank',
          'added',
          'title',
          'released',
          'runtime',
          'popularity',
          'percentage',
          'votes',
          'my_rating',
          'random',
          'watched',
        ].includes(String(input.sort_by))
      )
        return { error: 'Unsupported list sort order.' };
      body.sort_by = input.sort_by;
    }
    if (Object.hasOwn(input, 'sort_how')) {
      if (!['asc', 'desc'].includes(String(input.sort_how)))
        return { error: 'sort_how must be asc or desc.' };
      body.sort_how = input.sort_how;
    }
    // Collaborators are deliberately excluded: WeTrakr silently drops them on
    // free accounts, which would falsely imply access had been granted.
    const allowed = new Set([
      'name',
      'description',
      'privacy',
      'allow_comments',
      'sort_by',
      'sort_how',
    ]);
    if (Object.keys(input).some((key) => !allowed.has(key)))
      return { error: 'Unsupported list field.' };
    if (!requireName && Object.keys(body).length === 0)
      return { error: 'Provide at least one list field to update.' };
    return { body };
  }

  async function proxyMutation(
    authRef: string,
    path: string,
    init: { method: 'POST' | 'PUT' | 'DELETE'; body?: unknown },
    res: import('express').Response
  ): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const result = await dependencies.requestApi(authRef, path, init);
      res.status(200).json({ success: true, data: result.data });
    } catch (error) {
      if (error instanceof WeTrakrRateLimitError) {
        res.setHeader(
          'Retry-After',
          String(Math.max(1, Math.ceil(error.retryAfterMs / 1000)))
        );
        res
          .status(429)
          .json({ error: error.message, retryAfterMs: error.retryAfterMs });
      } else if (error instanceof WeTrakrApiError) {
        // Pass through only status, never provider response bodies or tokens.
        const status =
          error.status >= 400 && error.status <= 599 ? error.status : 502;
        res.status(status).json({ error: error.message });
      } else {
        res.status(502).json({ error: 'WeTrakr list operation failed.' });
      }
    }
  }

  async function authenticatedUser(req: Request) {
    const credentials = parseBasicAuthHeader(req, { allowEncrypted: false });
    if (!credentials)
      throw new APIError(
        constants.ErrorCode.UNAUTHORIZED,
        undefined,
        'Basic AIOStreams credentials required'
      );
    const user = await dependencies.authenticate(
      credentials.uuid,
      credentials.password
    );
    if (!user) throw new APIError(constants.ErrorCode.UNAUTHORIZED);
    return { uuid: credentials.uuid, user };
  }

  router.post('/link/device', async (req, res, next) => {
    cleanExpiredStates();
    try {
      const { uuid } = await authenticatedUser(req);
      const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
      const applicationCredentials: WeTrakrApplicationCredentials = {
        clientId: typeof body.clientId === 'string' ? body.clientId.trim() : '',
        ...(typeof body.clientSecret === 'string' && body.clientSecret.trim()
          ? { clientSecret: body.clientSecret.trim() }
          : {}),
      };
      if (!applicationCredentials.clientId || applicationCredentials.clientId.length > 512 || (applicationCredentials.clientSecret?.length ?? 0) > 2048) {
        res.status(400).json({ error: 'This AIOStreams configuration must provide a valid WeTrakr app client ID and optional client secret.' });
        return;
      }
      const device = await dependencies.requestDeviceCode(applicationCredentials);
      const state = randomUUID();
      const expiresAt = Date.now() + device.expiresIn * 1000;
      states.set(state, {
        userUuid: uuid,
        device,
        expiresAt,
        nextPollAt: 0,
        polling: false,
        applicationCredentials,
      });
      res.status(200).json({
        state,
        userCode: device.userCode,
        verificationUri: device.verificationUri,
        expiresIn: device.expiresIn,
        expiresAt,
        interval: device.interval,
      });
    } catch (error) {
      if (error instanceof APIError) next(error);
      else
        res.status(502).json({
          error:
            error instanceof Error
              ? error.message
              : 'Unable to start WeTrakr link',
        });
    }
  });

  router.get('/link/status/:state', async (req, res, next) => {
    cleanExpiredStates();
    let uuid: string;
    try {
      ({ uuid } = await authenticatedUser(req));
    } catch (error) {
      next(error);
      return;
    }
    const state = states.get(req.params.state);
    if (!state) {
      res
        .status(404)
        .json({ status: 'error', error: 'WeTrakr link expired. Start again.' });
      return;
    }
    if (state.userUuid !== uuid) {
      res
        .status(404)
        .json({ status: 'error', error: 'WeTrakr link not found.' });
      return;
    }
    if (state.authRef) {
      res.status(200).json({ status: 'authorized', authRef: state.authRef });
      return;
    }
    if (state.error) {
      res.status(502).json({ status: 'error', error: state.error });
      return;
    }
    const now = Date.now();
    if (now < state.nextPollAt || state.polling) {
      res.status(200).json({
        status: 'pending',
        retryAfter: state.polling
          ? state.device.interval
          : Math.max(1, Math.ceil((state.nextPollAt - now) / 1000)),
      });
      return;
    }

    state.polling = true;
    try {
      const applicationCredentials = state.applicationCredentials;
      if (!applicationCredentials) throw new Error('WeTrakr app credentials expired from the device-link flow; start again.');
      const result = await dependencies.pollDeviceToken(state.device.deviceCode, applicationCredentials);
      if (result.status === 'pending') {
        state.nextPollAt = Date.now() + result.retryAfter * 1000;
        res
          .status(200)
          .json({ status: 'pending', retryAfter: result.retryAfter });
        return;
      }
      state.authRef = await dependencies.storeToken(result.token, applicationCredentials);
      state.applicationCredentials = undefined;
      // Keep the one-time status result briefly available for the browser poller.
      state.expiresAt = Date.now() + 10 * 60 * 1000;
      res.status(200).json({ status: 'authorized', authRef: state.authRef });
    } catch (error) {
      state.error =
        error instanceof Error ? error.message : 'WeTrakr authorization failed';
      state.applicationCredentials = undefined;
      res.status(502).json({ status: 'error', error: state.error });
    } finally {
      state.polling = false;
    }
  });

  router.delete('/link/:authRef', async (req, res, next) => {
    let user;
    try {
      ({ user } = await authenticatedUser(req));
    } catch (error) {
      next(error);
      return;
    }
    const authRef = String(req.params.authRef ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(authRef)) {
      res.status(400).json({ error: 'Invalid WeTrakr account reference' });
      return;
    }
    // A random opaque reference is not an authorization token. Verify that the
    // authenticated profile actually owns it before deleting encrypted material.
    if (user.trackerProviders?.wetrakr?.authRef !== authRef) {
      res.status(404).json({ error: 'WeTrakr account link not found' });
      return;
    }
    try {
      await dependencies.removeToken(authRef);
      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  // Read-only WeTrakr account and catalog surfaces stay behind the AIOStreams
  // account and the server-held OAuth token. The browser never receives either.
  router.get('/account', async (req, res, next) => {
    try {
      const authRef = await linkedProviderReference(req);
      if (!authRef) {
        res.status(409).json({
          error: 'Connect and enable WeTrakr in this AIOStreams profile first.',
        });
        return;
      }
      // WeTrakr exposes the authenticated account profile at /account/settings;
      // the bare /account path is a documentation namespace, not an endpoint.
      await proxyRead(authRef, '/account/settings', res);
    } catch (error) {
      next(error);
    }
  });

  router.get('/account/lists', async (req, res, next) => {
    try {
      const authRef = await linkedProviderReference(req);
      if (!authRef) {
        res.status(409).json({
          error: 'Connect and enable WeTrakr in this AIOStreams profile first.',
        });
        return;
      }
      await proxyRead(authRef, `/sync/lists?${pageQuery(req)}`, res);
    } catch (error) {
      next(error);
    }
  });

  router.post('/account/lists', async (req, res, next) => {
    try {
      const authRef = await linkedProviderReference(req);
      if (!authRef) {
        res.status(409).json({
          error: 'Connect and enable WeTrakr in this AIOStreams profile first.',
        });
        return;
      }
      const parsed = parseListMutation(req.body, true);
      if (!parsed.body) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      // The official API defaults new lists to public. Choose private unless
      // the user explicitly selects a visibility in the UI.
      parsed.body.privacy ??= 'private';
      await proxyMutation(
        authRef,
        '/sync/lists',
        { method: 'POST', body: parsed.body },
        res
      );
    } catch (error) {
      next(error);
    }
  });

  router.put('/account/lists/:listId', async (req, res, next) => {
    try {
      const authRef = await linkedProviderReference(req);
      if (!authRef) {
        res.status(409).json({
          error: 'Connect and enable WeTrakr in this AIOStreams profile first.',
        });
        return;
      }
      const listId = String(req.params.listId ?? '');
      if (!/^\d{1,18}$/.test(listId)) {
        res.status(400).json({ error: 'A valid WeTrakr list id is required.' });
        return;
      }
      const parsed = parseListMutation(req.body, false);
      if (!parsed.body) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      await proxyMutation(
        authRef,
        `/sync/lists/${encodeURIComponent(listId)}`,
        { method: 'PUT', body: parsed.body },
        res
      );
    } catch (error) {
      next(error);
    }
  });

  router.delete('/account/lists/:listId', async (req, res, next) => {
    try {
      const authRef = await linkedProviderReference(req);
      if (!authRef) {
        res.status(409).json({
          error: 'Connect and enable WeTrakr in this AIOStreams profile first.',
        });
        return;
      }
      const listId = String(req.params.listId ?? '');
      if (!/^\d{1,18}$/.test(listId)) {
        res.status(400).json({ error: 'A valid WeTrakr list id is required.' });
        return;
      }
      await proxyMutation(
        authRef,
        `/sync/lists/${encodeURIComponent(listId)}`,
        { method: 'DELETE' },
        res
      );
    } catch (error) {
      next(error);
    }
  });

  router.get('/account/lists/:listId/items', async (req, res, next) => {
    try {
      const authRef = await linkedProviderReference(req);
      if (!authRef) {
        res.status(409).json({
          error: 'Connect and enable WeTrakr in this AIOStreams profile first.',
        });
        return;
      }
      const listId = String(req.params.listId ?? '');
      if (!/^\d{1,18}$/.test(listId)) {
        res.status(400).json({ error: 'A valid WeTrakr list id is required.' });
        return;
      }
      await proxyRead(
        authRef,
        `/sync/lists/${encodeURIComponent(listId)}/items?${pageQuery(req)}`,
        res
      );
    } catch (error) {
      next(error);
    }
  });

  router.get('/account/history', async (req, res, next) => {
    try {
      const authRef = await linkedProviderReference(req);
      if (!authRef) {
        res.status(409).json({
          error: 'Connect and enable WeTrakr in this AIOStreams profile first.',
        });
        return;
      }
      const target =
        typeof req.query.target === 'string'
          ? req.query.target.toLowerCase()
          : 'episodes';
      if (target !== 'movies' && target !== 'episodes') {
        res.status(400).json({
          error: 'Choose movies or episodes for watched history.',
        });
        return;
      }
      await proxyRead(
        authRef,
        `/sync/tracking/watched/history/${target}?${pageQuery(req)}`,
        res
      );
    } catch (error) {
      next(error);
    }
  });

  router.get('/account/facets/:facet', async (req, res, next) => {
    try {
      const authRef = await linkedProviderReference(req);
      if (!authRef) {
        res.status(409).json({
          error: 'Connect and enable WeTrakr in this AIOStreams profile first.',
        });
        return;
      }
      const facet = String(req.params.facet ?? '').toLowerCase();
      const path = accountFacetPaths[facet];
      if (!path) {
        res.status(404).json({ error: 'Unknown WeTrakr account facet.' });
        return;
      }
      const separator = path.includes('?') ? '&' : '?';
      await proxyRead(authRef, `${path}${separator}${pageQuery(req)}`, res);
    } catch (error) {
      next(error);
    }
  });

  router.get('/catalog/search', async (req, res, next) => {
    try {
      const authRef = await linkedProviderReference(req);
      if (!authRef) {
        res.status(409).json({
          error: 'Connect and enable WeTrakr in this AIOStreams profile first.',
        });
        return;
      }
      const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const filterType =
        typeof req.query.filter_type === 'string' ? req.query.filter_type : '';
      if (!query || query.length > 160 || /[\u0000-\u001f]/.test(query)) {
        res
          .status(400)
          .json({ error: 'Search text must be 1–160 printable characters.' });
        return;
      }
      if (
        !['movie', 'show', 'person', 'list', 'comment'].includes(filterType)
      ) {
        res
          .status(400)
          .json({ error: 'Choose one supported WeTrakr search type.' });
        return;
      }
      const params = pageQuery(req);
      params.set('q', query);
      params.set('filter_type', filterType);
      await proxyRead(authRef, `/search?${params}`, res);
    } catch (error) {
      next(error);
    }
  });

  router.get('/catalog/discover/:section', async (req, res, next) => {
    try {
      const authRef = await linkedProviderReference(req);
      if (!authRef) {
        res.status(409).json({
          error: 'Connect and enable WeTrakr in this AIOStreams profile first.',
        });
        return;
      }
      const section = String(req.params.section ?? '').toLowerCase();
      if (
        ![
          'trending',
          'popular',
          'toprated',
          'favorited',
          'listed',
          'planning',
          'watched',
          'last',
          'ranks',
        ].includes(section)
      ) {
        res.status(404).json({ error: 'Unknown WeTrakr discovery catalog.' });
        return;
      }
      const filterType =
        typeof req.query.filter_type === 'string' ? req.query.filter_type : '';
      if (
        !['movie', 'show', 'person', 'list', 'comment'].includes(filterType)
      ) {
        res
          .status(400)
          .json({ error: 'Choose one supported WeTrakr catalog type.' });
        return;
      }
      const params = pageQuery(req);
      params.set('filter_type', filterType);
      await proxyRead(authRef, `/discover/${section}?${params}`, res);
    } catch (error) {
      next(error);
    }
  });

  const catalogDetailPaths: Record<string, string> = {
    movie: 'movies',
    show: 'shows',
    season: 'seasons',
    episode: 'episodes',
    person: 'people',
    list: 'lists',
  };

  router.get('/catalog/:mediaType/:mediaId', async (req, res, next) => {
    try {
      const authRef = await linkedProviderReference(req);
      if (!authRef) {
        res.status(409).json({
          error: 'Connect and enable WeTrakr in this AIOStreams profile first.',
        });
        return;
      }
      const mediaType = String(req.params.mediaType ?? '').toLowerCase();
      const mediaPath = catalogDetailPaths[mediaType];
      const mediaId = String(req.params.mediaId ?? '');
      if (!mediaPath || !/^\d{1,18}$/.test(mediaId)) {
        res
          .status(400)
          .json({ error: 'Choose a valid WeTrakr media type and id.' });
        return;
      }

      const params = new URLSearchParams();
      if (req.query.append !== undefined) {
        const requested =
          typeof req.query.append === 'string'
            ? req.query.append
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean)
            : [];
        const append = [...new Set(requested)];
        if (
          mediaType !== 'show' ||
          append.length === 0 ||
          append.length > 2 ||
          append.some((value) => value !== 'seasons' && value !== 'episodes')
        ) {
          res.status(400).json({
            error: 'Only show details support append=seasons,episodes.',
          });
          return;
        }
        params.set('append', append.join(','));
      }
      if (req.query.extended !== undefined) {
        if (mediaType !== 'list' || req.query.extended !== 'preview') {
          res
            .status(400)
            .json({ error: 'Only list details support extended=preview.' });
          return;
        }
        params.set('extended', 'preview');
      }

      const suffix = params.size ? `?${params}` : '';
      await proxyRead(
        authRef,
        `/${mediaPath}/${encodeURIComponent(mediaId)}${suffix}`,
        res
      );
    } catch (error) {
      next(error);
    }
  });

  router.post('/sync/import', async (req, res, next) => {
    try {
      const { uuid, user } = await authenticatedUser(req);
      const provider = user.trackerProviders?.wetrakr;
      if (!provider?.authRef || provider.enabled === false) {
        res.status(409).json({
          error: 'Connect and enable WeTrakr in this AIOStreams profile first.',
        });
        return;
      }
      const records = await fetchWeTrakrAccountRecords((path) =>
        dependencies.requestApi(provider.authRef!, path)
      );
      const database = dependencies.database();
      let changed = 0;
      await database.tx(async (tx) => {
        for (const record of records) {
          const result = await tx.exec(
            `INSERT INTO tracker_records (user_uuid, record_id, record_json, updated_at_ms) VALUES (?, ?, ?, ?) ON CONFLICT(user_uuid, record_id) DO UPDATE SET record_json = excluded.record_json, updated_at_ms = excluded.updated_at_ms WHERE excluded.updated_at_ms > tracker_records.updated_at_ms`,
            [uuid, record.id, JSON.stringify(record), record.updatedAt]
          );
          changed += result.rowCount;
        }
      });
      res.status(200).json({
        success: true,
        imported: records.length,
        changed,
        detail:
          'WeTrakr account records merged into the AIOStreams tracker ledger.',
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createWeTrakrRouter();
