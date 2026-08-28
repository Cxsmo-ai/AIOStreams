import { fetch } from 'undici';
import {
  Cache,
  createLogger,
  DistributedLock,
  formatZodError,
  makeRequest,
} from '../../utils/index.js';
import { config as appConfig } from '../../config/index.js';
import z from 'zod';
import { searchWithBackgroundRefresh } from '../utils/general.js';

interface ResponseMeta {
  headers: Record<string, string>;
  status: number;
  statusText: string;
}

interface HarbrrApiResponse<T> {
  data: T;
  meta: ResponseMeta;
}

interface HarbrrConfig {
  baseUrl: string;
  apiKey: string;
  timeout: number;
}

export class HarbrrApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly statusText: string
  ) {
    super(message);
  }
}

const HarbrrApiIndexerSchema = z.object({
  id: z.number(),
  slug: z.string(),
  definitionId: z.string(),
  name: z.string(),
  baseUrl: z.string().optional(),
  enabled: z.boolean(),
  protocol: z.enum(['torrent', 'usenet']),
  priority: z.number().optional(),
  minSeeders: z.number().optional(),
});

export type HarbrrApiIndexer = z.infer<typeof HarbrrApiIndexerSchema>;
const HarbrrApiIndexersListSchema = z.array(HarbrrApiIndexerSchema);

const HarbrrApiReleaseSchema = z.object({
  title: z.string(),
  releaseName: z.string().optional(),
  filename: z.string().optional(),
  tags: z.array(z.string()).optional(),
  description: z.string().optional(),
  details: z.string().optional(),
  comments: z.string().optional(),
  link: z.string().optional(),
  magnet: z.string().optional(),
  infohash: z
    .string()
    .optional()
    .transform((val) => val?.toLowerCase()),
  guid: z.string().optional(),
  size: z.number(),
  categories: z.array(z.number()).optional(),
  seeders: z.number().optional(),
  leechers: z.number().optional(),
  peers: z.number().optional(),
  grabs: z.number().optional(),
  publishDate: z.string().optional(),
  downloadVolumeFactor: z.number().optional(),
  uploadVolumeFactor: z.number().optional(),
  imdbid: z.string().optional(),
  tmdbid: z.number().optional(),
  tvdbid: z.number().optional(),
  genre: z.string().optional(),
  year: z.number().optional(),
});

export type HarbrrApiRelease = z.infer<typeof HarbrrApiReleaseSchema>;

const HarbrrApiSearchResultSchema = z.object({
  indexer: z.string(),
  release: HarbrrApiReleaseSchema,
});

export type HarbrrApiSearchResult = z.infer<typeof HarbrrApiSearchResultSchema>;

const HarbrrApiSearchEnvelopeSchema = z.object({
  results: z.array(HarbrrApiSearchResultSchema).nullable().optional(),
  total: z.number().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
});

const logger = createLogger('harbrr');
export const HARBRR_INTERACTIVE_TIMEOUT_MS = 8_000;

export class HarbrrApi {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly baseApiPath = '/api';

  private readonly searchCache = Cache.getInstance<
    string,
    HarbrrApiResponse<HarbrrApiSearchResult[]>
  >('harbrr-api:search');

  private readonly indexersCache = Cache.getInstance<
    string,
    HarbrrApiIndexer[]
  >('harbrr-api:indexers');

  #headers: Record<string, string>;
  #timeout: number;

  constructor(config: HarbrrConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.#headers = {
      'Content-Type': 'application/json',
      'X-API-Key': this.apiKey,
      'User-Agent': appConfig.http.defaultUserAgent,
    };
    this.#timeout = config.timeout;
  }

  async indexers(): Promise<HarbrrApiResponse<HarbrrApiIndexer[]>> {
    return this.indexersCache.wrap(
      () =>
        this.request<HarbrrApiIndexer[]>(
          'indexers',
          {},
          HarbrrApiIndexersListSchema,
          3000
        ),
      `${this.baseUrl}:indexers`,
      appConfig.builtins.harbrr.indexersCacheTtl
    );
  }

  async search({
    query,
    indexerSlugs,
    limit,
    offset,
  }: {
    query: string;
    indexerSlugs?: string[];
    limit?: number;
    offset?: number;
  }): Promise<HarbrrApiResponse<HarbrrApiSearchResult[]>> {
    const indexersKey = indexerSlugs && indexerSlugs.length > 0 ? indexerSlugs.join(',') : 'all';
    const cacheKey = `${this.baseUrl}:search:${query}:${indexersKey}:${limit}:${offset}`;

    return searchWithBackgroundRefresh({
      searchCache: this.searchCache,
      searchCacheKey: cacheKey,
      bgCacheKey: `harbrr:${cacheKey}`,
      cacheTTL: appConfig.builtins.harbrr.searchCacheTtl,
      fetchFn: async () => {
        const params: Record<string, any> = {
          q: query,
          ...(limit !== undefined && { limit }),
          ...(offset !== undefined && { offset }),
        };
        if (indexerSlugs && indexerSlugs.length > 0) {
          params.indexers = indexerSlugs.join(',');
        }
        const envRes = await this.request(
          'search',
          params,
          HarbrrApiSearchEnvelopeSchema,
          Math.min(this.#timeout, HARBRR_INTERACTIVE_TIMEOUT_MS)
        );
        return {
          data: envRes.data.results ?? [],
          meta: envRes.meta,
        };
      },
      isEmptyResult: (result) => result.data.length === 0,
      logger,
    });
  }

  private getPath(endpoint: string) {
    return `${this.baseUrl}${this.baseApiPath}/${endpoint}`;
  }

  private async request<T>(
    endpoint: string,
    params: Record<string, string | number | boolean | (string | number)[]> = {},
    schema: z.ZodType<T>,
    timeout?: number
  ): Promise<HarbrrApiResponse<T>> {
    const { result } = await DistributedLock.getInstance().withLock(
      `${this.getPath(endpoint)}:${JSON.stringify(params)}`,
      () => this._request(endpoint, params, schema, timeout),
      {
        timeout: timeout ?? this.#timeout,
        ttl: (timeout ?? this.#timeout) * 2,
      }
    );
    return result;
  }

  private async _request<T>(
    endpoint: string,
    params: Record<string, string | number | boolean | (string | number)[]> = {},
    schema: z.ZodType<T>,
    timeout?: number
  ): Promise<HarbrrApiResponse<T>> {
    const url = new URL(this.getPath(endpoint));
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        url.searchParams.append(key, value.toString());
      }
    });

    const response = await makeRequest(url.toString(), {
      headers: this.#headers,
      timeout: timeout ?? this.#timeout,
    });

    const meta: ResponseMeta = {
      headers: Object.fromEntries(response.headers.entries()),
      status: response.status,
      statusText: response.statusText,
    };

    if (!response.ok) {
      const error = await response.text();
      logger.error(
        `Harbrr API error: ${response.status} ${response.statusText} - ${error}`
      );
      throw new HarbrrApiError(
        `Harbrr API error: ${error}`,
        response.status,
        response.statusText
      );
    }

    const data = await response.json();
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      logger.error(
        `Failed to parse Harbrr API response for ${endpoint}: ${formatZodError(parsed.error)}`
      );
      throw new Error(
        `Failed to parse Harbrr API response for ${endpoint}: ${formatZodError(parsed.error)}`
      );
    }
    return {
      data: parsed.data,
      meta,
    };
  }
}

export default HarbrrApi;
