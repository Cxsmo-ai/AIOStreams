import type { Dialect } from '../driver/types.js';

export interface Migration {
  /** Stable numeric identifier; execution order is the MIGRATIONS registry order. */
  readonly id: number;
  /** Human-readable name (used in logs and the `_migrations` table). */
  readonly name: string;
  /** DDL/DML per dialect. Both are required so missing one is a build error. */
  readonly up: Record<Dialect, string>;
}
