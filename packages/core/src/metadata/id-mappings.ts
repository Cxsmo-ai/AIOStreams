import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../logging/logger.js';
import { getDataFolder, makeRequest } from '../utils/index.js';
import { config as appConfig } from '../config/index.js';
import { BaseDataset } from '../builtins/base/dataset.js';

const logger = createLogger('id-mappings');

export interface IdSet {
  imdbId?: string;
  tvdbId?: number;
  tmdbId?: number;
}

interface TypeMaps {
  imdbToTvdb: Map<number, number>;
  imdbToTmdb: Map<number, number>;
}

interface StoredType {
  rows: [number, number, number][]; // [imdbNum, tvdbId, tmdbId], 0 = absent
}
interface IdMapData {
  tv: StoredType;
  movie: StoredType;
  lastUpdated: number;
}

const imdbToNum = (imdb: string): number | undefined => {
  const m = /^tt(\d+)$/.exec(imdb.trim());
  return m ? Number(m[1]) : undefined;
};

function emptyTypeMaps(): TypeMaps {
  return {
    imdbToTvdb: new Map(),
    imdbToTmdb: new Map(),
  };
}

export class IdMappingDataset extends BaseDataset {
  private static instance: IdMappingDataset;
  private tv: TypeMaps = emptyTypeMaps();
  private movie: TypeMaps = emptyTypeMaps();
  protected logger = logger;

  private constructor() {
    super({
      dataPath: path.join(getDataFolder(), 'id-mappings', 'mappings.json'),
      refreshIntervalSeconds: appConfig.metadata.idMappings.refreshInterval,
      logger,
      taskId: 'id-mappings-refresh',
      taskLabel: 'ID mappings refresh',
      taskDescription:
        'Re-download the cross-provider (imdb/tvdb/tmdb) ID mapping dataset.',
    });
  }

  public static getInstance(): IdMappingDataset {
    if (!IdMappingDataset.instance) {
      IdMappingDataset.instance = new IdMappingDataset();
    }
    return IdMappingDataset.instance;
  }

  /**
   * A tvdb/tmdb id claimed by more than one imdb id is an upstream data error,
   * not a legitimate alias, so the whole group is dropped and the id falls back
   * to the normal per-provider lookup.
   */
  private buildMaps(rows: [number, number, number][], label: string): TypeMaps {
    const conflicted = { tvdb: new Set<number>(), tmdb: new Set<number>() };
    const claimant = {
      tvdb: new Map<number, number>(),
      tmdb: new Map<number, number>(),
    };
    for (const [imdb, tvdb, tmdb] of rows) {
      if (!imdb) continue;
      for (const [providerId, key] of [
        [tvdb, 'tvdb'],
        [tmdb, 'tmdb'],
      ] as const) {
        if (!providerId) continue;
        const first = claimant[key].get(providerId);
        if (first === undefined) claimant[key].set(providerId, imdb);
        else if (first !== imdb) conflicted[key].add(providerId);
      }
    }

    const maps = emptyTypeMaps();
    for (const [imdb, tvdb, tmdb] of rows) {
      if (imdb && tvdb && !conflicted.tvdb.has(tvdb))
        maps.imdbToTvdb.set(imdb, tvdb);
      if (imdb && tmdb && !conflicted.tmdb.has(tmdb))
        maps.imdbToTmdb.set(imdb, tmdb);
    }
    if (conflicted.tvdb.size || conflicted.tmdb.size) {
      logger.debug(
        {
          type: label,
          tvdbIds: conflicted.tvdb.size,
          tmdbIds: conflicted.tmdb.size,
        },
        'dropped id mappings claimed by multiple imdb ids'
      );
    }
    return maps;
  }

  protected async reloadDataFromFile(): Promise<void> {
    const data: IdMapData = JSON.parse(
      await fs.readFile(this.DATA_PATH, 'utf-8')
    );
    this.tv = this.buildMaps(data.tv.rows, 'tv');
    this.movie = this.buildMaps(data.movie.rows, 'movie');
    logger.info(
      {
        tv: data.tv.rows.length,
        movie: data.movie.rows.length,
        tvTvdb: this.tv.imdbToTvdb.size,
        movieTvdb: this.movie.imdbToTvdb.size,
      },
      'loaded id mappings'
    );
  }

  private async fetchCsv(
    url: string,
    columns: number
  ): Promise<[number, number, number][]> {
    const response = await makeRequest(url, {
      method: 'GET',
      timeout: 60000,
      headers: { 'User-Agent': appConfig.http.defaultUserAgent },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }
    const text = await response.text();
    const rows: [number, number, number][] = [];
    const lines = text.split('\n');
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const parts = line.split(',');
      if (parts.length < columns) continue;
      const imdb = imdbToNum(parts[0]);
      if (!imdb) continue;
      const tvdb = parts[1] ? Number(parts[1]) : 0;
      const tmdb = parts[2] ? Number(parts[2]) : 0;
      if (!tvdb && !tmdb) continue;
      rows.push([imdb, tvdb || 0, tmdb || 0]);
    }
    return rows;
  }

  protected async performSync(): Promise<void> {
    const cfg = appConfig.metadata.idMappings;
    const [tv, movie] = await Promise.all([
      this.fetchCsv(cfg.tvUrl, 4),
      this.fetchCsv(cfg.movieUrl, 3),
    ]);
    const data: IdMapData = {
      tv: { rows: tv },
      movie: { rows: movie },
      lastUpdated: Date.now(),
    };
    const tempPath = `${this.DATA_PATH}.tmp`;
    await fs.mkdir(path.dirname(tempPath), { recursive: true });
    await fs.writeFile(tempPath, JSON.stringify(data));
    await fs.rename(tempPath, this.DATA_PATH);
    logger.info({ tv: tv.length, movie: movie.length }, 'synced id mappings');
  }

  /**
   * Fill the tvdb/tmdb ids missing from `ids`, anchored on the imdb id.
   * Returns only newly-resolved ids ({} when no imdb id or no match).
   */
  public resolve(mediaType: 'movie' | 'series', ids: IdSet): IdSet {
    const imdbNum = ids.imdbId ? imdbToNum(ids.imdbId) : undefined;
    if (imdbNum === undefined) return {};
    const maps = mediaType === 'movie' ? this.movie : this.tv;
    const out: IdSet = {};
    if (!ids.tvdbId) {
      const tvdb = maps.imdbToTvdb.get(imdbNum);
      if (tvdb) out.tvdbId = tvdb;
    }
    if (!ids.tmdbId) {
      const tmdb = maps.imdbToTmdb.get(imdbNum);
      if (tmdb) out.tmdbId = tmdb;
    }
    return out;
  }
}
