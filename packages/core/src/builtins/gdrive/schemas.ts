import { z } from 'zod';

export const RefreshTokenResponseSuccessSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  token_type: z.string(),
  scope: z.string(),
  refresh_token: z.string().optional(),
});

export const RefreshTokenResponseErrorSchema = z.object({
  error: z.string(),
  error_description: z.string(),
});

export const RefreshTokenResponseSchema = z.union([
  RefreshTokenResponseSuccessSchema,
  RefreshTokenResponseErrorSchema,
]);

// export type RefreshTokenResponse = z.infer<typeof RefreshTokenResponseSchema>;
export type RefreshTokenResponse = z.infer<
  typeof RefreshTokenResponseSuccessSchema
>;

const GDriveFile = z.object({
  kind: z.string().optional(),
  driveId: z.string().optional(),
  teamDriveId: z.string().optional(),
  fileExtension: z.string().optional(),
  md5Checksum: z.string().optional(),
  contentHints: z
    .object({
      indexableText: z.string(),
      thumbnail: z.object({
        image: z.string(),
        mimeType: z.string(),
      }),
    })
    .optional(),
  webViewLink: z.string().optional(),
  webContentLink: z.string().optional(),
  thumbnailLink: z.string().optional(),
  iconLink: z.string().optional(),
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  size: z.string().optional(),
  createdTime: z.string(),
  modifiedTime: z.string(),
  videoMediaMetadata: z
    .object({
      width: z.number(),
      height: z.number(),
      durationMs: z.number().optional(),
    })
    .optional(),
});

export type GDriveFile = z.infer<typeof GDriveFile>;

const GDriveFileQueryResponseSuccessSchema = z.object({
  files: z.array(GDriveFile),
  nextPageToken: z.string().optional(),
  incompleteSearch: z.boolean().optional(),
  kind: z.string().optional(),
});

const GDriveApiErrorSchema = z.object({
  error: z.object({
    code: z.number(),
    message: z.string(),
    errors: z.array(
      z.object({
        message: z.string(),
        reason: z.string(),
        location: z.string().optional(),
        locationType: z.string().optional(),
        domain: z.string().optional(),
      })
    ),
    status: z.string().optional(),
  }),
});

export const GDriveFileQueryResponseSchema = z.union([
  GDriveFileQueryResponseSuccessSchema,
  GDriveApiErrorSchema,
]);

export type GDriveFileQueryResponse = z.infer<
  typeof GDriveFileQueryResponseSchema
>;

export const GDriveFileGetResponseSchema = z.union([
  GDriveFile,
  GDriveApiErrorSchema,
]);

export const UserData = z.object({
  refreshToken: z.string().min(1),
  includeAudioFiles: z.boolean().optional(),
  // catalogSort: z.enum(['createdTime desc', 'modifiedTime desc', 'name', '']).optional(),
  catalogSort: z
    .array(
      z.enum([
        'createdTime_asc',
        'createdTime_desc',
        'modifiedTime_asc',
        'modifiedTime_desc',
        'modifiedByMeTime_asc',
        'modifiedByMeTime_desc',
        'viewedByMeTime_asc',
        'viewedByMeTime_desc',
        'sharedWithMeTime_asc',
        'sharedWithMeTime_desc',
        'name_asc',
        'name_desc',
        'name_natural_asc',
        'name_natural_desc',
        'recency_asc',
        'recency_desc',
        'starred_asc',
        'starred_desc',
        'folder_asc',
        'folder_desc',
      ])
    )
    .optional(),
  metadataSource: z.enum(['imdb', 'tmdb']).optional(),
  tmdbReadAccessToken: z.string().optional(),
});
export type UserData = z.infer<typeof UserData>;
