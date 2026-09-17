import { setTimeout as delay } from 'node:timers/promises';
import { sql, type Kysely } from 'kysely';
import { withRlsContext } from '../rls-context.js';
import { FIXTURE_ROLE } from './config.js';
import { NOTES_PER_USER, type FixtureRun } from './fixtures.js';

export const CONCURRENT_TRANSACTIONS = 50;
export const ROUNDS = 20;
const MAX_DELAY_MS = 5;

interface Tool3Tables {
  'tool3.notes': { id: number; owner_sub: string; body: string };
}

export interface ScenarioResult {
  readonly transactions: number;
  readonly committed: number;
  readonly rolledBack: number;
  readonly failedWithError: number;
  readonly cleanStateChecks: number;
  readonly distinctServerBackends: number;
  readonly failures: readonly string[];
}

class DeliberateRollback extends Error {}

type Mode = 'commit' | 'rollback' | 'error';

function modeFor(index: number): Mode {
  if (index % 10 === 7) return 'rollback';
  if (index % 10 === 8) return 'error';
  return 'commit';
}

const jitter = () => delay(Math.floor(Math.random() * (MAX_DELAY_MS + 1)));

function isEmptyClaims(value: unknown): boolean {
  return value === null || value === '';
}

/** TOOL-3 scenario (owner decision S10): 50 concurrent transactions x 20 rounds through the pooler. */
export async function runScenario(db: Kysely<Tool3Tables>, fixtures: FixtureRun): Promise<ScenarioResult> {
  const failures: string[] = [];
  const backends = new Set<number>();
  let committed = 0;
  let rolledBack = 0;
  let failedWithError = 0;
  let cleanStateChecks = 0;
  const fail = (message: string) => {
    if (failures.length < 50) failures.push(message);
  };

  // The fixture role alone has no table privileges (INHERIT FALSE membership).
  try {
    await sql`select count(*) from tool3.notes`.execute(db);
    fail('fixture role read tool3.notes without SET ROLE');
  } catch (error) {
    if ((error as { code?: string }).code !== '42501') fail(`unexpected error for direct access: ${(error as { code?: string }).code ?? 'unknown'}`);
  }

  // Without claims, RLS returns no protected rows.
  const noClaims = await db.transaction().execute(async (trx) => {
    await sql`set local role authenticated`.execute(trx);
    return (await sql<{ n: string }>`select count(*)::text as n from tool3.notes`.execute(trx)).rows[0]?.n;
  });
  if (noClaims !== '0') fail(`no-claims context returned ${noClaims} rows`);

  for (let round = 0; round < ROUNDS; round += 1) {
    const tasks = Array.from({ length: CONCURRENT_TRANSACTIONS }, async (_unused, index) => {
      const user = fixtures.users[(index + round) % fixtures.users.length] as string;
      const mode = modeFor(index);
      const tag = `round ${round} tx ${index}`;
      try {
        await withRlsContext(db, { sub: user, role: 'authenticated' }, async (trx) => {
          await jitter();
          const identity = await sql<{ current_user: string; session_user: string; sub: string | null }>`
            select current_user, session_user, tool3.claim_sub() as sub`.execute(trx);
          const row = identity.rows[0];
          if (row?.current_user !== 'authenticated') fail(`${tag}: current_user ${row?.current_user}`);
          if (row?.session_user !== FIXTURE_ROLE) fail(`${tag}: unexpected session_user`);
          if (row?.sub !== user) fail(`${tag}: saw claims of another transaction`);
          await jitter();
          const notes = await trx.selectFrom('tool3.notes').select('owner_sub').execute();
          if (notes.length !== NOTES_PER_USER || notes.some((note) => note.owner_sub !== user)) {
            fail(`${tag}: saw ${notes.length} rows, including other users' rows: ${notes.some((note) => note.owner_sub !== user)}`);
          }
          await jitter();
          const again = await sql<{ sub: string | null }>`select tool3.claim_sub() as sub`.execute(trx);
          if (again.rows[0]?.sub !== user) fail(`${tag}: claims changed inside the transaction`);
          if (mode === 'rollback') throw new DeliberateRollback();
          if (mode === 'error') await sql`select 1 / 0`.execute(trx);
        });
        if (mode === 'commit') committed += 1;
        else fail(`${tag}: ${mode} transaction completed unexpectedly`);
      } catch (error) {
        if (mode === 'rollback' && error instanceof DeliberateRollback) rolledBack += 1;
        else if (mode === 'error' && (error as { code?: string }).code === '22012') failedWithError += 1;
        else fail(`${tag}: unexpected ${(error as { code?: string }).code ?? (error as Error).name}: ${/prepared statement/i.test(String((error as Error).message)) ? 'PREPARED STATEMENT ERROR' : 'see code'}`);
      }
    });
    await Promise.all(tasks);

    // Reused server connections must be back to the fixture role with no claims.
    const checks = Array.from({ length: CONCURRENT_TRANSACTIONS }, async () => {
      const state = await sql<{ current_user: string; claims: string | null; pid: number }>`
        select current_user, current_setting('request.jwt.claims', true) as claims, pg_backend_pid() as pid`.execute(db);
      const row = state.rows[0];
      if (row === undefined) return fail(`round ${round}: empty state check`);
      backends.add(row.pid);
      cleanStateChecks += 1;
      if (row.current_user !== FIXTURE_ROLE) fail(`round ${round}: role leaked after transaction (${row.current_user})`);
      if (!isEmptyClaims(row.claims)) fail(`round ${round}: claims leaked after transaction`);
    });
    await Promise.all(checks);
  }

  return {
    transactions: CONCURRENT_TRANSACTIONS * ROUNDS,
    committed,
    rolledBack,
    failedWithError,
    cleanStateChecks,
    distinctServerBackends: backends.size,
    failures,
  };
}
