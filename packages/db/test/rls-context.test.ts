import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { describe, expect, it } from 'vitest';
import { InvalidClaimsError, serializeClaims, withRlsContext, type RlsClaims } from '../src/index.js';

/** Records what Kysely sends, without a database. */
function recordingDb(options: { failOn?: RegExp } = {}) {
  const log: string[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      log.push(`${query.sql} ${JSON.stringify(query.parameters)}`);
      if (options.failOn?.test(query.sql)) throw Object.assign(new Error('boom'), { code: '22012' });
      return { rows: [] };
    },
    async *streamQuery() {
      yield { rows: [] };
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => void log.push('BEGIN'),
    commitTransaction: async () => void log.push('COMMIT'),
    rollbackTransaction: async () => void log.push('ROLLBACK'),
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const db = new Kysely<{ notes: { owner_sub: string } }>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, log };
}

// Test fixture claims only; not verified tokens.
const claims: RlsClaims = { sub: '11111111-1111-4111-8111-111111111111', role: 'authenticated', aal: 'aal1' };

describe('withRlsContext', () => {
  it('sets the role and claims transaction-locally before the work, then commits', async () => {
    const { db, log } = recordingDb();
    const result = await withRlsContext(db, claims, async (trx) => {
      await trx.selectFrom('notes').select('owner_sub').execute();
      return 'done';
    });
    expect(result).toBe('done');
    expect(log).toEqual([
      'BEGIN',
      'set local role authenticated []',
      `select set_config('request.jwt.claims', $1, true) ${JSON.stringify([JSON.stringify(claims)])}`,
      'select "owner_sub" from "notes" []',
      'COMMIT',
    ]);
  });

  it('passes the claims as a parameter, never inside the SQL text', async () => {
    const { db, log } = recordingDb();
    const hostile: RlsClaims = { sub: "x'); drop table notes; --" };
    await withRlsContext(db, hostile, async () => undefined);
    expect(log[2]?.startsWith("select set_config('request.jwt.claims', $1, true) ")).toBe(true);
    expect(log.join('\n')).not.toMatch(/drop table notes; --\) /);
  });

  it('rolls back when the work throws, and rethrows the same error', async () => {
    const { db, log } = recordingDb();
    const failure = new Error('work failed');
    await expect(withRlsContext(db, claims, async () => Promise.reject(failure))).rejects.toBe(failure);
    expect(log.at(-1)).toBe('ROLLBACK');
    expect(log).not.toContain('COMMIT');
  });

  it('rolls back when a statement fails', async () => {
    const { db, log } = recordingDb({ failOn: /1 \/ 0/ });
    await expect(
      withRlsContext(db, claims, async (trx) => {
        await trx.executeQuery({ sql: 'select 1 / 0', parameters: [], query: { kind: 'RawNode' } } as never);
      }),
    ).rejects.toMatchObject({ code: '22012' });
    expect(log.at(-1)).toBe('ROLLBACK');
  });

  it('never issues session-level settings', async () => {
    const { db, log } = recordingDb();
    await withRlsContext(db, claims, async () => undefined);
    const statements = log.filter((line) => line !== 'BEGIN' && line !== 'COMMIT');
    for (const statement of statements) {
      expect(statement).not.toMatch(/^set (session )?role|^set (?!local)|set_config\([^)]*false\)|^reset|^discard|listen|notify|pg_advisory_lock/i);
    }
  });

  it('validates claims before opening a transaction', async () => {
    const { db, log } = recordingDb();
    await expect(withRlsContext(db, { sub: '' }, async () => undefined)).rejects.toBeInstanceOf(InvalidClaimsError);
    expect(log).toEqual([]);
  });
});

describe('serializeClaims', () => {
  it('serialises plain JSON claims', () => {
    expect(serializeClaims({ sub: 'u', nested: { a: [1, true, null] } })).toBe('{"sub":"u","nested":{"a":[1,true,null]}}');
  });

  it.each([
    ['missing sub', { role: 'authenticated' }],
    ['empty sub', { sub: '' }],
    ['numeric sub', { sub: 42 }],
    ['non-finite number', { sub: 'u', exp: Number.POSITIVE_INFINITY }],
    ['function value', { sub: 'u', f: () => 1 }],
    ['undefined value', { sub: 'u', x: undefined }],
    ['date value', { sub: 'u', at: new Date(0) }],
    ['array instead of object', ['u']],
    ['null', null],
    ['class instance', new (class { sub = 'u'; })()],
  ])('rejects %s', (_label, value) => {
    expect(() => serializeClaims(value as never)).toThrow(InvalidClaimsError);
  });
});
