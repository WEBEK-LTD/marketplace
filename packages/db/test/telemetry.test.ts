import { initTelemetry, trace } from '@repo/telemetry';
import { createSpanRecorder } from '@repo/telemetry/testing';
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
import { beforeEach, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/index.js';

const recorder = createSpanRecorder();
const telemetry = initTelemetry({ serviceName: 'api', testSpanProcessor: recorder.processor });
beforeEach(() => recorder.reset());

function fakeDb(failOn?: RegExp) {
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      if (failOn?.test(query.sql)) throw Object.assign(new Error('canary-db-error-message'), { code: '22012' });
      return { rows: [] };
    },
    async *streamQuery() {
      yield { rows: [] };
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  return new Kysely<{ notes: { owner_sub: string } }>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

// Test fixture claims only; not verified tokens.
const claims = { sub: 'canary-claim-subject', email: 'canary-claim@example.test', role: 'authenticated' };

describe('database transaction span (O8-9)', () => {
  it('records db.system only, as a child of the active span', async () => {
    const db = fakeDb();
    await telemetry.tracer.startActiveSpan('GET /route', async (parent) => {
      await withRlsContext(db, claims, async (trx) => {
        await trx.selectFrom('notes').select('owner_sub').where('owner_sub', '=', 'canary-sql-parameter').execute();
      });
      parent.end();
    });
    const spans = recorder.spans();
    const dbSpan = spans.find((span) => span.name === 'db.transaction');
    const parentSpan = spans.find((span) => span.name === 'GET /route');
    expect(dbSpan?.attributes).toEqual({ 'db.system': 'postgresql' });
    expect(dbSpan?.parentSpanContext?.spanId).toBe(parentSpan?.spanContext().spanId);
    const dump = recorder.dump();
    for (const canary of ['canary-claim-subject', 'canary-claim@example.test', 'canary-sql-parameter', 'set_config', 'select', 'owner_sub']) {
      expect(dump).not.toContain(canary);
    }
  });

  it('marks failures with the error type only', async () => {
    const db = fakeDb(/1 \/ 0/);
    await expect(
      withRlsContext(db, claims, async (trx) => {
        await trx.executeQuery({ sql: 'select 1 / 0', parameters: [], query: { kind: 'RawNode' } } as never);
      }),
    ).rejects.toMatchObject({ code: '22012' });
    const [span] = recorder.spans();
    expect(span?.attributes).toEqual({ 'db.system': 'postgresql', 'error.type': 'Error' });
    expect(span?.status.code).toBe(2);
    expect(recorder.dump()).not.toContain('canary-db-error-message');
    expect(trace.getActiveSpan()).toBeUndefined();
  });
});
