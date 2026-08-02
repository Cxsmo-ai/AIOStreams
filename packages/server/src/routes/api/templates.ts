import { Router, Request, Response, NextFunction } from 'express';
import { createResponse } from '../../utils/responses.js';
import {
  APIError,
  constants,
  createLogger,
  TemplateManager,
} from '@aiostreams/core';
import fs from 'fs/promises';
import path from 'path';

const router: Router = Router();
const logger = createLogger('server');

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const templates = TemplateManager.getTemplates();
    res.json(createResponse({ success: true, data: templates }));
  } catch (error: any) {
    logger.error(`Failed to load templates: ${error.message}`);
    next(
      new APIError(
        constants.ErrorCode.INTERNAL_SERVER_ERROR,
        undefined,
        error.message
      )
    );
  }
});

export default router;
