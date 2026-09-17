import pg from 'pg';
import { createDatabase } from '../database.js';
import { readConnections, Tool3ConfigError, withPassword, type ExpectedPorts, type Tool3Target } from './config.js';
import { setUpFixtures, tearDownFixtures } from './fixtures.js';
import { CONCURRENT_TRANSACTIONS, ROUNDS, runScenario } from './scenario.js';

const LABELS: Record<Tool3Target, string> = {
  supabase: 'TOOL-3 (local Supabase transaction-mode pooler)',
  supplemental: 'Sandbox supplemental evidence only — NOT TOOL-3, NOT Supabase, NOT Supavisor',
};

function parseArgs(argv: readonly string[]): { target: Tool3Target; expected?: ExpectedPorts } {
  const target = argv[0];
  if (target !== 'supabase' && target !== 'supplemental') throw new Tool3ConfigError('Usage: run.js <supabase|supplemental> [poolerPort adminPort]');
  if (target === 'supabase') {
    const pooler = Number(argv[1]);
    const admin = Number(argv[2]);
    if (!Number.isInteger(pooler) || !Number.isInteger(admin)) throw new Tool3ConfigError('The supabase target needs the configured pooler and database ports.');
    return { target, expected: { pooler, admin } };
  }
  return { target };
}

async function main(): Promise<number> {
  const { target, expected } = parseArgs(process.argv.slice(2));
  const connections = readConnections(target, process.env, expected);
  console.log(`== ${LABELS[target]}`);
  const admin = new pg.Client({ connectionString: connections.adminUrl.href });
  await admin.connect();
  let exitCode = 1;
  try {
    const fixtures = await setUpFixtures(admin);
    const db = createDatabase<never>({
      connectionString: withPassword(connections.poolerUrl, fixtures.password),
      maxConnections: CONCURRENT_TRANSACTIONS,
    });
    try {
      const started = Date.now();
      const result = await runScenario(db as never, fixtures);
      const pass = result.failures.length === 0 && result.committed + result.rolledBack + result.failedWithError === result.transactions;
      console.log(JSON.stringify({ label: LABELS[target], rounds: ROUNDS, concurrency: CONCURRENT_TRANSACTIONS, durationMs: Date.now() - started, ...result, result: pass ? 'PASS' : 'FAIL' }, null, 2));
      if (pass && target === 'supabase') console.log('TOOL-3 result: Local transaction-pooler behavior verified');
      exitCode = pass ? 0 : 1;
    } finally {
      await db.destroy();
    }
  } finally {
    await tearDownFixtures(admin).catch(() => {
      console.error('Fixture cleanup failed.');
      exitCode = 1;
    });
    await admin.end();
  }
  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Tool3ConfigError ? error.message : `Run failed: ${(error as { code?: string }).code ?? (error as Error).name}`);
    process.exit(1);
  },
);
