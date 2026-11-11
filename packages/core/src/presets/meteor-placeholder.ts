import type { Stream } from '../db/index.js';

export function isMeteorPlaceholder(
  stream: Pick<Stream, 'externalUrl'>
): boolean {
  const url = stream.externalUrl ?? '';
  return url.includes('/status/video/no_results') || url.endsWith('/support');
}
