import { z } from 'zod';

export const TorboxRouteSchema = z.object({
  quality: z.enum(['native', '1080p', '720p']).default('native'),
  audioLanguage: z.string().default('auto'),
  subtitleLanguage: z.string().default('off'),
  appendFilename: z.boolean().default(false),
  torrentCacheAndPlay: z.boolean().optional(),
  usenetCacheAndPlay: z.boolean().optional(),
});
