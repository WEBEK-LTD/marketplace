import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createDatabase, createDatabaseFromPool, withRlsContext } from '../src/index.js';

/** A stand-in for a node-postgres pool that records how queries are sent. */
function fakePool() {
  const calls: unknown[][] = [];
  const client = {
    query: async (...args: unknown[]) => {
      calls.push(args);
      return { command: 'SELECT', rowCount: 0, rows: [] };
    },
    release: () => undefined,
  };
  const pool = Object.assign(new EventEmitter(), {
    connect: async () => client,
    end: async () => undefined,
  });
  return { pool: pool as unknown as pg.Pool, calls };
}

describe('createDatabase', () => {
  it.each([0, -1, 1.5, Number.NaN])('rejects maxConnections %s', (maxConnections) => {
    expect(() => createDatabase({ connectionString: 'postgres://u@127.0.0.1:5432/db', maxConnections })).toThrow(RangeError);
  });

  it('creates a pool without connecting', async () => {
    const db = createDatabase({ connectionString: 'postgres://u@127.0.0.1:1/db', maxConnections: 2 });
    await db.destroy();
  });

  it('sends every statement as an unnamed query (text + values), never a named prepared statement', async () => {
    const { pool, calls } = fakePool();
    const db = createDatabaseFromPool<{ notes: { owner_sub: string } }>(pool);
    await withRlsContext(db, { sub: 'fixture-user' }, async (trx) => {
      await trx.selectFrom('notes').select('owner_sub').where('owner_sub', '=', 'x').execute();
    });
    await db.destroy();
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const args of calls) {
      expect(typeof args[0]).toBe('string');
      expect(args[0]).not.toMatch(/^\s*prepare\b/i);
      if (args.length > 1) expect(Array.isArray(args[1])).toBe(true);
    }
    expect(calls.map((args) => args[0])).toEqual([
      'begin',
      'set local role authenticated',
      "select set_config('request.jwt.claims', $1, true)",
      'select "owner_sub" from "notes" where "owner_sub" = $1',
      'commit',
    ]);
  });
});
