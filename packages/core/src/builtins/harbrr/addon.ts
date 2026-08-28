import { BaseDebridAddon, BaseDebridConfigSchema } from '../base/debrid.js';
import { z } from 'zod';
import { createLogger, getTimeTakenSincePoint } from '../../utils/index.js';
import { config as appConfig } from '../../config/index.js';
import HarbrrApi, {
  HarbrrApiIndexer,
  HarbrrApiSearchResult,
  HARBRR_INTERACTIVE_TIMEOUT_MS,
} from './api.js';
import { ParsedId } from '../../utils/id-parser.js';
import { SearchMetadata } from '../base/debrid.js';
import { NZB, UnprocessedTorrent } from '../../debrid/index.js';
import {
  extractInfoHashFromMagnet,
  extractTrackersFromMagnet,
  validateInfoHash,
} from '../utils/debrid.js';
import { createQueryLimit, getTitleLanguagesForUrl } from '../utils/general.js';
import { collectHarbrrResultsUntilDeadline } from './deadline.js';

export const HarbrrAddonConfigSchema = BaseDebridConfigSchema.extend({
  url: z.string(),
  apiKey: z.string(),
  indexers: z.array(z.string()),
  sources: z.array(z.string()).optional(),
});

export type HarbrrAddonConfig = z.infer<typeof HarbrrAddonConfigSchema>;

const logger = createLogger('harbrr');
const HARBRR_RESULT_LIMIT = 500;

export class HarbrrAddon extends BaseDebridAddon<HarbrrAddonConfig> {
  readonly id = 'harbrr';
  readonly name = 'Harbrr';
  readonly version = '1.0.0';
  readonly logger = logger;
  readonly api: HarbrrApi;

  public static preconfiguredIndexers: HarbrrApiIndexer[] | undefined;

  private readonly preconfiguredInstance: boolean;
  private readonly indexers: string[] = [];
  private readonly sources: string[] = [];
  private readonly selectedIndexersByProtocol = new Map<
    'torrent' | 'usenet',
    Promise<HarbrrApiIndexer[]>
  >();

  constructor(config: HarbrrAddonConfig, clientIp?: string) {
    super(config, HarbrrAddonConfigSchema, clientIp);

    let isPreconfigured = false;
    let searchTimeout = 30000;
    try {
      isPreconfigured =
        Boolean(
          appConfig.builtins.harbrr?.url && appConfig.builtins.harbrr?.apiKey
        ) &&
        appConfig.builtins.harbrr.url === config.url &&
        appConfig.builtins.harbrr.apiKey === config.apiKey;
      searchTimeout = appConfig.builtins.harbrr?.searchTimeout ?? 30000;
    } catch {
      isPreconfigured = false;
      searchTimeout = 30000;
    }
    this.preconfiguredInstance = isPreconfigured;
    this.indexers = config.indexers.map((x) => x.toLowerCase());
    this.sources = (config.sources ?? []).map((x) => x.toLowerCase());
    this.api = new HarbrrApi({
      baseUrl: config.url,
      apiKey: config.apiKey,
      timeout: searchTimeout,
    });
  }

  public static async fetchpreconfiguredIndexers(): Promise<void> {
    if (this.preconfiguredIndexers) return;
    let harbrrUrl: string | null | undefined;
    let harbrrApiKey: string | null | undefined;
    try {
      harbrrUrl = appConfig.builtins.harbrr?.url;
      harbrrApiKey = appConfig.builtins.harbrr?.apiKey;
    } catch {
      return;
    }
    if (!harbrrUrl || !harbrrApiKey) return;
    const api = new HarbrrApi({
      baseUrl: harbrrUrl,
      apiKey: harbrrApiKey,
      timeout: 5000,
    });
    try {
      const { data } = await api.indexers();
      logger.debug(`Fetched ${data.length} preconfigured Harbrr indexers`);
      this.preconfiguredIndexers = data.filter((indexer) => {
        if (!indexer.enabled) return false;
        if (appConfig.builtins.harbrr.indexers?.length) {
          const configured = appConfig.builtins.harbrr.indexers.map((x) =>
            x.toLowerCase()
          );
          return [
            indexer.name.toLowerCase(),
            indexer.slug.toLowerCase(),
            indexer.definitionId.toLowerCase(),
          ].some((x) => configured.includes(x));
        }
        return true;
      });
      logger.debug(
        `Set ${this.preconfiguredIndexers?.length} preconfigured Harbrr indexers`
      );
    } catch (err) {
      logger.warn(`Failed to fetch preconfigured Harbrr indexers: ${err}`);
    }
  }

  private async getIndexersByProtocol(
    protocol: 'torrent' | 'usenet'
  ): Promise<HarbrrApiIndexer[]> {
    const existing = this.selectedIndexersByProtocol.get(protocol);
    if (existing) return existing;

    const selection = this.loadIndexersByProtocol(protocol);
    this.selectedIndexersByProtocol.set(protocol, selection);
    try {
      return await selection;
    } catch (error) {
      if (this.selectedIndexersByProtocol.get(protocol) === selection) {
        this.selectedIndexersByProtocol.delete(protocol);
      }
      throw error;
    }
  }

  private async loadIndexersByProtocol(
    protocol: 'torrent' | 'usenet'
  ): Promise<HarbrrApiIndexer[]> {
    let availableIndexers: HarbrrApiIndexer[] = [];

    if (this.preconfiguredInstance && HarbrrAddon.preconfiguredIndexers) {
      availableIndexers = HarbrrAddon.preconfiguredIndexers;
    } else {
      const indexersResult = await this.api.indexers();
      availableIndexers = indexersResult.data;
    }

    const chosenIndexers = availableIndexers.filter(
      (indexer) =>
        indexer.enabled &&
        indexer.protocol === protocol &&
        (!this.indexers.length ||
          this.indexers.includes(indexer.name.toLowerCase()) ||
          this.indexers.includes(indexer.slug.toLowerCase()) ||
          this.indexers.includes(indexer.definitionId.toLowerCase()))
    );

    this.logger.info(
      `Chosen Harbrr ${protocol} indexers: ${chosenIndexers.map((indexer) => indexer.name).join(', ')}`
    );

    return chosenIndexers;
  }

  private async performSearch(
    protocol: 'torrent' | 'usenet',
    parsedId: ParsedId,
    metadata: SearchMetadata
  ): Promise<HarbrrApiSearchResult[]> {
    if (this.sources.length > 0 && !this.sources.includes(protocol)) {
      return [];
    }

    const queryLimit = createQueryLimit();
    const chosenIndexers = await this.getIndexersByProtocol(protocol);

    if (chosenIndexers.length === 0) {
      this.logger.warn(`No Harbrr ${protocol} indexers available`);
      return [];
    }

    const queries = [
      ...new Set(
        this.buildQueries(parsedId, metadata, {
          titleLanguages: getTitleLanguagesForUrl(this.userData.url, this.id),
        })
      ),
    ];
    if (queries.length === 0) {
      return [];
    }

    const indexerSlugs = chosenIndexers.map((indexer) => indexer.slug);

    const searchPromises = queries.map((q) =>
      queryLimit(async () => {
        const start = Date.now();
        const { data } = await this.api.search({
          query: q,
          indexerSlugs,
          limit: HARBRR_RESULT_LIMIT,
        });
        this.logger.info(
          `Harbrr ${protocol} search for ${q} took ${getTimeTakenSincePoint(start)}`,
          {
            results: data.length,
          }
        );
        return data;
      })
    );

    return collectHarbrrResultsUntilDeadline(
      searchPromises,
      Math.min(
        appConfig.builtins.harbrr.searchTimeout,
        HARBRR_INTERACTIVE_TIMEOUT_MS
      ) + 1_000,
      (error) =>
        this.logger.warn(
          `Harbrr ${protocol} query failed: ${error instanceof Error ? error.message : String(error)}`
        )
    );
  }

  protected async _searchTorrents(
    parsedId: ParsedId
  ): Promise<UnprocessedTorrent[]> {
    const metadata = await this.getSearchMetadata();
    const results = await this.performSearch('torrent', parsedId, metadata);
    if (results.length === 0) return [];

    const seenTorrents = new Set<string>();
    const torrents: UnprocessedTorrent[] = [];

    for (const result of results) {
      const rel = result.release;
      const magnetUrl = rel.magnet?.includes('magnet:')
        ? rel.magnet
        : undefined;
      const downloadUrl = rel.link?.startsWith('http') ? rel.link : undefined;
      const infoHash = validateInfoHash(
        rel.infohash ||
          (magnetUrl ? extractInfoHashFromMagnet(magnetUrl) : undefined)
      );
      if (!infoHash && !downloadUrl) continue;
      if (seenTorrents.has(infoHash ?? downloadUrl!)) continue;
      seenTorrents.add(infoHash ?? downloadUrl!);

      torrents.push({
        hash: infoHash,
        downloadUrl: downloadUrl,
        sources: magnetUrl ? extractTrackersFromMagnet(magnetUrl) : [],
        seeders: rel.seeders,
        title: rel.title,
        size: rel.size,
        indexer: rel.releaseName || result.indexer,
        type: 'torrent',
      });
    }
    return torrents;
  }

  protected async _searchNzbs(parsedId: ParsedId): Promise<NZB[]> {
    // Harbrr is intentionally torrent-only in AIOStreams. Its Usenet
    // capability remains available in the upstream service, but this preset
    // is dedicated to the user's public/private torrent tracker fabric.
    return [];
  }
}
