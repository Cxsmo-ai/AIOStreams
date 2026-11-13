import { Request, Response, NextFunction, RequestHandler } from 'express';
import multer, { MulterError } from 'multer';
import { config as appConfig } from '@aiostreams/core';

/**
 * Generic bounded multipart upload middleware. The size limit is set per
 * route, and a fresh in-memory multer instance is built for each request.
 *
 * On oversize input multer raises `MulterError('LIMIT_FILE_SIZE')`; callers
 * translate that into their own error envelope. Pass the accepted file field
 * name(s); the first field that carries a file wins.
 */
export function boundedFileUpload(
  fields: string[],
  maxFileSize: number
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const handler = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: maxFileSize, files: 1 },
    }).fields(fields.map((name) => ({ name, maxCount: 1 })));
    handler(req, res, next);
  };
}

/** Upload middleware for `.nzb` routes using the live instance setting. */
export function nzbUpload(fields: string[]): RequestHandler {
  return boundedFileUpload(fields, appConfig.usenet.maxNzbSize);
}

/** The single uploaded file across the accepted fields, if any. */
export function pickUploadedFile(
  req: Request,
  fields: string[]
): Express.Multer.File | undefined {
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  if (!files) return undefined;
  for (const field of fields) {
    const file = files[field]?.[0];
    if (file) return file;
  }
  return undefined;
}

/** Whether an error is multer's oversize-file error. */
export function isFileTooLargeError(err: unknown): err is MulterError {
  return err instanceof MulterError && err.code === 'LIMIT_FILE_SIZE';
}
