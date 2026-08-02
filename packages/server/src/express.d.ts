import 'express';
import { UserData } from '@aiostreams/core';
import type { RateLimitInfo } from 'express-rate-limit';

declare global {
  namespace Express {
    interface Request {
      userData?: UserData;
      userIp?: string;
      requestIp?: string;
      uuid?: string;
      user?: { username: string; isAdmin: boolean };
      rateLimit?: RateLimitInfo;
    }
  }
}
