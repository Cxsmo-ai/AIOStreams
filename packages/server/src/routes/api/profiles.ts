import { Router } from 'express';
import {
  APIError,
  ConfigProfileRepository,
  constants,
  createLogger,
  decryptString,
  encryptString,
  isConfigUuid,
  MAX_PROFILES_PER_OWNER,
  DeepbridOfficialClient,
  normaliseAlias,
  resolveConfigAlias,
  UserRepository,
  validateAlias,
  config as appConfig,
} from '@aiostreams/core';
import { z } from 'zod';
import { userApiRateLimiter } from '../../middlewares/ratelimit.js';
import { attachSession, requireSession } from '../../middlewares/auth.js';
import { createResponse } from '../../utils/responses.js';
import {
  projectDeepbridFolderFiles,
  projectDeepbridUploadDetails,
} from '../../utils/deepbrid-upload.js';
import { projectDeepbridFinderMetrics } from '../../utils/deepbrid-metrics.js';
import { runDeepbridLocalSelfTests } from '../../utils/deepbrid-self-test.js';

const router: Router = Router();
const logger = createLogger('server');

router.use(userApiRateLimiter);
router.use(attachSession);
router.use(requireSession);

function notFound(): APIError {
  return new APIError(
    constants.ErrorCode.USER_INVALID_DETAILS,
    404,
    'Saved configuration not found'
  );
}

function conflict(message: string): APIError {
  return new APIError(constants.ErrorCode.USER_ALREADY_EXISTS, 409, message);
}

/** Settings win at resolve time, so claiming one here would do nothing. */
function aliasCollidesWithSettings(alias: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    appConfig.api.aliasedConfigurations,
    alias
  );
}

async function assertAliasFree(alias: string, exceptId: string): Promise<void> {
  const reason = validateAlias(alias);
  if (reason) {
    throw new APIError(constants.ErrorCode.BAD_REQUEST, undefined, reason);
  }
  if (aliasCollidesWithSettings(alias)) {
    throw conflict(`"${alias}" is already used by an instance-wide alias`);
  }
  if (await ConfigProfileRepository.aliasTaken(alias, exceptId)) {
    throw conflict(`"${alias}" is already taken`);
  }
}

const saveBody = z.object({
  uuid: z.string().min(1),
  password: z.string().min(1),
  label: z.string().trim().min(1).max(64).optional(),
});

const updateBody = z.object({
  label: z.string().trim().min(1).max(64).optional(),
  alias: z.string().nullable().optional(),
});

const historyQuery = z.object({
  kind: z.enum(['downloads', 'uploads']).default('downloads'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const historyDeleteBody = z.object({
  kind: z.enum(['downloads', 'uploads']),
  ids: z
    .array(
      z.union([
        z.number().int().positive().safe(),
        z.string().regex(/^[1-9]\d{0,15}$/),
      ])
    )
    .min(1)
    .max(100),
  confirm: z.literal(true),
});
const folderResolveBody = z.object({
  link: z.string().trim().min(1).max(2_048),
});

/** Resolve this owner's saved config and its own Deepbrid key; never accept a
 * credential from the browser or fall back to another profile's service. */
async function deepbridClientForProfile(
  owner: string,
  profileId: string
): Promise<DeepbridOfficialClient> {
  const secret = await ConfigProfileRepository.openSecret(owner, profileId);
  if (!secret) throw notFound();

  const { success, data: password } = decryptString(secret.encryptedPassword);
  if (!success) {
    await ConfigProfileRepository.markBroken(owner, profileId);
    throw new APIError(
      constants.ErrorCode.ENCRYPTION_ERROR,
      undefined,
      'This saved configuration must be relinked before account history can be opened.'
    );
  }

  let userData;
  try {
    userData = await UserRepository.getUser(secret.uuid, password);
  } catch (error) {
    if (
      error instanceof APIError &&
      error.code === constants.ErrorCode.USER_INVALID_DETAILS
    ) {
      await ConfigProfileRepository.markBroken(owner, profileId);
      throw new APIError(
        constants.ErrorCode.USER_INVALID_DETAILS,
        undefined,
        'This saved configuration must be relinked before account history can be opened.'
      );
    }
    throw error;
  }
  if (!userData) {
    await ConfigProfileRepository.markBroken(owner, profileId);
    throw new APIError(
      constants.ErrorCode.USER_INVALID_DETAILS,
      undefined,
      'This saved configuration must be relinked before account history can be opened.'
    );
  }

  const service = userData.services?.find(
    (entry) => entry.id === constants.DEEPBRID_SERVICE
  );
  const apiKey = service?.credentials.apiKey;
  if (!apiKey) {
    throw new APIError(
      constants.ErrorCode.BAD_REQUEST,
      undefined,
      'Deepbrid is not configured in this saved profile.'
    );
  }

  await ConfigProfileRepository.markOpened(owner, profileId);
  return new DeepbridOfficialClient(apiKey);
}

function logDeepbridHistoryFailure(error: unknown, operation: string): void {
  const value =
    error && typeof error === 'object'
      ? (error as Record<string, unknown>)
      : undefined;
  const status = value?.status;
  const code = value?.code;
  logger.warn(
    {
      errorName: error instanceof Error ? error.name : 'UnknownError',
      status:
        typeof status === 'number' && Number.isInteger(status)
          ? status
          : undefined,
      code:
        typeof code === 'string' && /^[a-z0-9_-]{1,64}$/i.test(code)
          ? code
          : undefined,
    },
    operation
  );
}

router.get('/', async (req, res, next) => {
  try {
    const profiles = await ConfigProfileRepository.list(req.user!.username);
    res.status(200).json(
      createResponse({
        success: true,
        data: { profiles, limit: MAX_PROFILES_PER_OWNER },
      })
    );
  } catch (error) {
    next(
      error instanceof APIError
        ? error
        : new APIError(constants.ErrorCode.INTERNAL_SERVER_ERROR)
    );
  }
});

// also refreshes one already saved, so this doubles as the re-link path
router.post('/', async (req, res, next) => {
  const parsed = saveBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    next(
      new APIError(
        constants.ErrorCode.MISSING_REQUIRED_FIELDS,
        undefined,
        'uuid and password are required'
      )
    );
    return;
  }
  const owner = req.user!.username;
  const { password } = parsed.data;

  try {
    let uuid = parsed.data.uuid.trim();
    if (!isConfigUuid(uuid)) {
      const target = await resolveConfigAlias(uuid);
      if (!target) {
        throw new APIError(constants.ErrorCode.USER_INVALID_DETAILS);
      }
      uuid = target.uuid;
    }

    // The password check is the consent gate: you can only save a
    // configuration you can already open.
    await UserRepository.verifyUser(uuid, password);

    const existing = await ConfigProfileRepository.list(owner);
    const alreadySaved = existing.some((p) => p.uuid === uuid);
    if (!alreadySaved && existing.length >= MAX_PROFILES_PER_OWNER) {
      throw new APIError(
        constants.ErrorCode.FORBIDDEN,
        undefined,
        `You can save at most ${MAX_PROFILES_PER_OWNER} configurations`
      );
    }

    const label = parsed.data.label ?? uuid.slice(0, 8);
    const clash = existing.find((p) => p.label === label && p.uuid !== uuid);
    if (clash) {
      throw conflict(`You already have a saved configuration named "${label}"`);
    }

    const { success, data: encryptedPassword } = encryptString(password);
    if (!success) {
      throw new APIError(constants.ErrorCode.ENCRYPTION_ERROR);
    }

    const profile = await ConfigProfileRepository.save(owner, {
      uuid,
      encryptedPassword,
      label,
    });
    logger.info({ owner, uuid }, 'saved a configuration to a session identity');
    res.status(201).json(
      createResponse({
        success: true,
        detail: 'Configuration saved',
        data: { profile },
      })
    );
  } catch (error) {
    next(
      error instanceof APIError
        ? error
        : new APIError(constants.ErrorCode.INTERNAL_SERVER_ERROR)
    );
  }
});

router.patch('/:id', async (req, res, next) => {
  const parsed = updateBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    next(
      new APIError(constants.ErrorCode.BAD_REQUEST, undefined, 'Invalid body')
    );
    return;
  }
  const owner = req.user!.username;
  const { id } = req.params;

  try {
    const current = await ConfigProfileRepository.get(owner, id);
    if (!current) {
      throw notFound();
    }

    const fields: { label?: string; alias?: string | null } = {};
    if (parsed.data.label !== undefined) {
      if (
        await ConfigProfileRepository.labelTaken(owner, parsed.data.label, id)
      ) {
        throw conflict(
          `You already have a saved configuration named "${parsed.data.label}"`
        );
      }
      fields.label = parsed.data.label;
    }
    // undefined leaves the alias alone; null and '' clear it.
    const requestedAlias = parsed.data.alias;
    if (requestedAlias !== undefined) {
      if (requestedAlias === null || requestedAlias.trim() === '') {
        fields.alias = null;
      } else {
        const alias = normaliseAlias(requestedAlias);
        await assertAliasFree(alias, id);
        fields.alias = alias;
      }
    }

    const profile = await ConfigProfileRepository.update(owner, id, fields);
    if (!profile) {
      throw notFound();
    }
    res.status(200).json(
      createResponse({
        success: true,
        detail: 'Saved configuration updated',
        data: { profile },
      })
    );
  } catch (error) {
    next(
      error instanceof APIError
        ? error
        : new APIError(constants.ErrorCode.INTERNAL_SERVER_ERROR)
    );
  }
});

// unlink; the configuration itself is left alone
router.delete('/:id', async (req, res, next) => {
  try {
    const removed = await ConfigProfileRepository.remove(
      req.user!.username,
      req.params.id
    );
    if (!removed) {
      throw notFound();
    }
    res.status(200).json(
      createResponse({
        success: true,
        detail: 'Saved configuration removed',
        data: { deleted: true },
      })
    );
  } catch (error) {
    next(
      error instanceof APIError
        ? error
        : new APIError(constants.ErrorCode.INTERNAL_SERVER_ERROR)
    );
  }
});

// returns credentials, not the configuration: the SPA loads it via /user
router.post('/:id/open', async (req, res, next) => {
  const owner = req.user!.username;
  const { id } = req.params;

  try {
    const secret = await ConfigProfileRepository.openSecret(owner, id);
    if (!secret) {
      throw notFound();
    }

    const { success, data: password } = decryptString(secret.encryptedPassword);
    if (!success) {
      await ConfigProfileRepository.markBroken(owner, id);
      throw new APIError(
        constants.ErrorCode.ENCRYPTION_ERROR,
        undefined,
        'This saved configuration can no longer be opened. Save it again with its password.'
      );
    }

    // decryptString only proves the blob was made with this instance's key, so
    // this is the check that the password still opens the configuration.
    try {
      await UserRepository.verifyUser(secret.uuid, password);
    } catch {
      await ConfigProfileRepository.markBroken(owner, id);
      throw new APIError(
        constants.ErrorCode.USER_INVALID_DETAILS,
        undefined,
        'The password for this saved configuration has changed. Save it again with the new password.'
      );
    }

    await ConfigProfileRepository.markOpened(owner, id);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(
      createResponse({
        success: true,
        data: {
          uuid: secret.uuid,
          password,
          encryptedPassword: secret.encryptedPassword,
        },
      })
    );
  } catch (error) {
    next(
      error instanceof APIError
        ? error
        : new APIError(constants.ErrorCode.INTERNAL_SERVER_ERROR)
    );
  }
});

router.get('/:id/deepbrid/history', async (req, res, next) => {
  const parsed = historyQuery.safeParse(req.query);
  if (!parsed.success) {
    next(
      new APIError(
        constants.ErrorCode.BAD_REQUEST,
        undefined,
        'Invalid Deepbrid history page.'
      )
    );
    return;
  }

  try {
    const client = await deepbridClientForProfile(
      req.user!.username,
      req.params.id
    );
    const { kind, limit, offset } = parsed.data;
    let entries;
    let hasNext: boolean;
    if (kind === 'downloads') {
      const page = await client.listDownloadsPage({ limit, offset });
      entries = page.entries;
      hasNext = page.hasNext;
    } else {
      // The upload endpoint currently exposes one list response, so page the
      // returned snapshot locally and do not imply provider-side completeness.
      const uploads = await client.listUploads();
      const safeUploads = uploads.map((item) => ({
        id: item.id,
        filename: item.title.slice(0, 500),
        date: item.addedAt?.slice(0, 80),
      }));
      entries = safeUploads.slice(offset, offset + limit);
      hasNext = offset + entries.length < safeUploads.length;
    }

    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json(
      createResponse({
        success: true,
        data: { kind, limit, offset, entries, hasNext },
      })
    );
  } catch (error) {
    if (error instanceof APIError) {
      next(error);
      return;
    }
    logDeepbridHistoryFailure(error, 'Deepbrid profile history request failed');
    next(
      new APIError(
        constants.ErrorCode.INTERNAL_SERVER_ERROR,
        undefined,
        'Could not load Deepbrid account history.'
      )
    );
  }
});

router.get('/:id/deepbrid/uploads/:uploadId', async (req, res, next) => {
  const uploadId = z
    .string()
    .regex(/^[1-9]\d{0,15}$/)
    .safeParse(req.params.uploadId);
  if (!uploadId.success) {
    next(
      new APIError(
        constants.ErrorCode.BAD_REQUEST,
        undefined,
        'Invalid Deepbrid upload identifier.'
      )
    );
    return;
  }

  try {
    const client = await deepbridClientForProfile(
      req.user!.username,
      req.params.id
    );
    const upload = await client.getUploadInfo(uploadId.data);
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json(
      createResponse({
        success: true,
        data: projectDeepbridUploadDetails(upload),
      })
    );
  } catch (error) {
    if (error instanceof APIError) {
      next(error);
      return;
    }
    logDeepbridHistoryFailure(error, 'Deepbrid upload inspection failed');
    next(
      new APIError(
        constants.ErrorCode.INTERNAL_SERVER_ERROR,
        undefined,
        'Could not inspect this Deepbrid NZB upload.'
      )
    );
  }
});

router.post('/:id/deepbrid/folder', async (req, res, next) => {
  const parsed = folderResolveBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    next(
      new APIError(
        constants.ErrorCode.BAD_REQUEST,
        undefined,
        'Enter a supported Deepbrid folder link.'
      )
    );
    return;
  }

  try {
    const client = await deepbridClientForProfile(
      req.user!.username,
      req.params.id
    );
    const files = await client.resolveFolder(parsed.data.link, {
      timeoutMs: 15_000,
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json(
      createResponse({
        success: true,
        data: { files: projectDeepbridFolderFiles(files) },
      })
    );
  } catch (error) {
    if (error instanceof APIError) {
      next(error);
      return;
    }
    const code =
      error && typeof error === 'object'
        ? (error as Record<string, unknown>).code
        : undefined;
    if (code === 'invalid-folder-url') {
      next(
        new APIError(
          constants.ErrorCode.BAD_REQUEST,
          undefined,
          error instanceof Error
            ? error.message
            : 'Enter a supported Deepbrid folder link.'
        )
      );
      return;
    }
    logDeepbridHistoryFailure(error, 'Deepbrid folder resolution failed');
    next(
      new APIError(
        constants.ErrorCode.INTERNAL_SERVER_ERROR,
        undefined,
        'Could not resolve this Deepbrid folder.'
      )
    );
  }
});

router.get('/:id/deepbrid/metrics', async (req, res, next) => {
  try {
    const client = await deepbridClientForProfile(
      req.user!.username,
      req.params.id
    );
    const report = client.getFinderRequestReport();
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json(
      createResponse({
        success: true,
        data: projectDeepbridFinderMetrics(report),
      })
    );
  } catch (error) {
    if (error instanceof APIError) {
      next(error);
      return;
    }
    logDeepbridHistoryFailure(error, 'Deepbrid profile metrics request failed');
    next(
      new APIError(
        constants.ErrorCode.INTERNAL_SERVER_ERROR,
        undefined,
        'Could not load Deepbrid Finder performance metrics.'
      )
    );
  }
});

router.post('/:id/deepbrid/self-test', async (req, res, next) => {
  try {
    const client = await deepbridClientForProfile(
      req.user!.username,
      req.params.id
    );
    const startedAt = Date.now();
    let accountStatus: 'connected' | 'failed' = 'connected';
    let failureKind:
      | 'authentication'
      | 'rate-limited'
      | 'provider-error'
      | 'network-error'
      | undefined;
    try {
      // One bounded, read-only authenticated request verifies the saved key.
      await client.getUser({ timeoutMs: 8_000 });
    } catch (error) {
      accountStatus = 'failed';
      const status =
        error && typeof error === 'object'
          ? (error as Record<string, unknown>).status
          : undefined;
      failureKind =
        status === 401 || status === 403
          ? 'authentication'
          : status === 429
            ? 'rate-limited'
            : typeof status === 'number' && status >= 500
              ? 'provider-error'
              : 'network-error';
      logDeepbridHistoryFailure(
        error,
        'Deepbrid profile self-test auth failed'
      );
    }
    const checks = await runDeepbridLocalSelfTests();
    const allChecksPassed = checks.every((check) => check.status === 'passed');
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json(
      createResponse({
        success: true,
        data: {
          overall:
            accountStatus === 'connected' && allChecksPassed
              ? 'passed'
              : 'failed',
          account: {
            status: accountStatus,
            failureKind,
            durationMs: Math.max(0, Date.now() - startedAt),
          },
          checks,
        },
      })
    );
  } catch (error) {
    if (error instanceof APIError) {
      next(error);
      return;
    }
    logDeepbridHistoryFailure(error, 'Deepbrid profile self-test failed');
    next(
      new APIError(
        constants.ErrorCode.INTERNAL_SERVER_ERROR,
        undefined,
        'Could not run the Deepbrid self-test.'
      )
    );
  }
});

router.delete('/:id/deepbrid/history', async (req, res, next) => {
  const parsed = historyDeleteBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    next(
      new APIError(
        constants.ErrorCode.BAD_REQUEST,
        undefined,
        'Select specific history entries and confirm the deletion.'
      )
    );
    return;
  }

  try {
    const client = await deepbridClientForProfile(
      req.user!.username,
      req.params.id
    );
    const { kind, ids } = parsed.data;
    const result =
      kind === 'downloads'
        ? await client.deleteDownloads(ids, { confirm: true })
        : await client.deleteUploads(ids, { confirm: true });

    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json(createResponse({ success: true, data: result }));
  } catch (error) {
    if (error instanceof APIError) {
      next(error);
      return;
    }
    logDeepbridHistoryFailure(
      error,
      'Deepbrid profile history deletion failed'
    );
    next(
      new APIError(
        constants.ErrorCode.INTERNAL_SERVER_ERROR,
        undefined,
        'Could not delete the selected Deepbrid account history.'
      )
    );
  }
});

export default router;
