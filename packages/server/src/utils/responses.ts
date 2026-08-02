import { createLogger } from '@aiostreams/core';
import { Request } from 'express';
const logger = createLogger('server');

type ApiResponseOptions = {
  success: boolean;
  detail?: string;
  data?: any;
  error?: {
    code: string;
    message: string;
    issues?: any;
  };
};
export type ApiResponse<T> = {
  success: boolean;
  detail: string | null;
  data: T | null;
  error: {
    code: string;
    message: string;
    issues?: any;
  } | null;
};

export function createResponse<T>(options: ApiResponseOptions): ApiResponse<T> {
  const { success, detail, data, error } = options;

  return {
    success,
    detail: detail || null,
    data: data || null,
    error: error || null,
  };
}
