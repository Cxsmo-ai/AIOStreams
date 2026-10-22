import type { RequestHandler } from 'express';

/** Conservative response protections that do not constrain addon/API CORS. */
export const securityHeadersMiddleware: RequestHandler = (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.accepts('html')) res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
};
