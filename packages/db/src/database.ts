import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

export interface DatabaseOptions {
  /** Server-only connection string; never logged. */
  readonly connectionString: string;
  /** Upper bound of pooled client connections. */
  readonly maxConnections: number;
}

/**
 * Creates a Kysely instance on node-postgres. node-postgres sends parameterised queries as unnamed
 * statements, so no named prepared statements reach a transaction-mode pooler.
 */
export function createDatabase<DB>(options: DatabaseOptions): Kysely<DB> {
  if (!Number.isSafeInteger(options.maxConnections) || options.maxConnections < 1) {
    throw new RangeError('maxConnections must be a positive integer.');
  }
  const pool = new pg.Pool({ connectionString: options.connectionString, max: options.maxConnections });
  return createDatabaseFromPool<DB>(pool);
}

/** Wraps an existing node-postgres pool (used by tests). */
export function createDatabaseFromPool<DB>(pool: pg.Pool): Kysely<DB> {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}
