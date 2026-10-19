export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** The levels pino actually emits, and the only ones offered in the UI. */
export const LOG_LEVELS = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
] as const;

/** Winston-era aliases accepted for compatibility with existing installs. */
export const LEGACY_LOG_LEVELS = [
  'verbose',
  'silly',
  'http',
  'warning',
] as const;

export function normaliseLevel(raw: string | undefined): LogLevel {
  if (!raw) return 'info';
  const v = raw.toLowerCase();
  switch (v) {
    case 'silly': return 'trace';
    case 'verbose': return 'debug';
    case 'http': return 'info';
    case 'warning': return 'warn';
  }
  if (
    v === 'trace' || v === 'debug' || v === 'info' ||
    v === 'warn' || v === 'error' || v === 'fatal'
  ) return v;
  return 'info';
}
