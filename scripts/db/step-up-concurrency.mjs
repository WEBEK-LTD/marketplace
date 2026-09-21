// Sandbox concurrency evidence for the step-up consumption primitive (C-19 rule 10) — NOT CI evidence.
//
// pgTAP runs in a single session, so it can prove the semantics of `app_private.consume_step_up_grant`
// but not that two *simultaneous* callers cannot both win. This opens real, separate connections and
// races them against one grant, which is the only way to observe the row lock actually serialising.
//
// Two scenarios are run against every grant:
//
//   success — each winner commits, so the grant is spent and no one else may have it.
//   rollback — the winner's protected operation fails and its transaction rolls back, so the grant must
//             come back and exactly one *later* caller may take it. This is the case that distinguishes
//             "consumed on success" from "consumed on attempt".
//
//   SUPPLEMENTAL_SCHEMA_URL=postgresql://... node scripts/db/step-up-concurrency.mjs [--racers N]
//
// The URL must point at loopback and is never printed.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { REPO_ROOT } from '../toolchain/deno.mjs';

const pg = createRequire(join(REPO_ROOT, 'packages/db/package.json'))('pg');

const BANNER = '*** Sandbox step-up concurrency evidence — NOT CI evidence ***';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const OPERATION = 'concurrency_probe';

function connectionUrl() {
  const raw = process.env.SUPPLEMENTAL_SCHEMA_URL;
  if (!raw) throw new Error('SUPPLEMENTAL_SCHEMA_URL is required.');
  const url = new URL(raw);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('SUPPLEMENTAL_SCHEMA_URL must be a postgres URL.');
  }
  if (!LOOPBACK.has(url.hostname)) throw new Error('SUPPLEMENTAL_SCHEMA_URL must point at a loopback host.');
  return url.href;
}

/**
 * One racer: its own connection, its own transaction.
 *
 * Every racer waits on the same barrier before issuing the UPDATE, so the calls overlap instead of
 * queueing. The transaction is held open briefly after the consume so the row lock is genuinely
 * contended, then committed or rolled back according to the scenario.
 */
async function race({ url, grantId, userId, racers, outcome }) {
  const barrier = Promise.withResolvers();
  const clients = [];
  try {
    for (let i = 0; i < racers; i += 1) {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      clients.push(client);
    }

    const attempts = clients.map(async (client) => {
      await barrier.promise;
      await client.query('begin');
      try {
        const result = await client.query(
          'select app_private.consume_step_up_grant($1::uuid, $2::uuid, $3::text) as consumed',
          [grantId, userId, OPERATION],
        );
        const consumed = result.rows[0].consumed === true;
        // Hold the lock long enough that the others are genuinely waiting on it, not merely late.
        if (consumed) await new Promise((resolve) => setTimeout(resolve, 60));
        await client.query(outcome === 'commit' ? 'commit' : 'rollback');
        return consumed;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      }
    });

    barrier.resolve();
    const results = await Promise.all(attempts);
    return results.filter(Boolean).length;
  } finally {
    await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
  }
}

async function main() {
  console.log(BANNER);
  const racers = Number(process.argv[process.argv.indexOf('--racers') + 1]) || 8;
  const url = connectionUrl();
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();

  let failures = 0;
  try {
    const { rows } = await admin.query(
      `insert into auth.users (id, email) values (gen_random_uuid(), 'concurrency-probe@test.invalid')
       returning id`,
    );
    const userId = rows[0].id;

    const newGrant = async () => {
      const grant = await admin.query(
        `insert into public.step_up_grants (user_id, operation, granted_via, expires_at)
         values ($1, $2, 'otp_whatsapp', now() + interval '10 minutes') returning id`,
        [userId, OPERATION],
      );
      return grant.rows[0].id;
    };

    // 1. All racers commit: exactly one may consume.
    const committed = await race({ url, grantId: await newGrant(), userId, racers, outcome: 'commit' });
    console.log(`commit scenario:   ${racers} simultaneous attempts -> ${committed} consumed (expected 1)`);
    if (committed !== 1) failures += 1;

    // 2. All racers roll back: the grant must survive, so a later caller can still spend it.
    const rolledBackGrant = await newGrant();
    const rolledBack = await race({ url, grantId: rolledBackGrant, userId, racers, outcome: 'rollback' });
    console.log(`rollback scenario: ${racers} simultaneous attempts -> ${rolledBack} consumed before rollback`);
    const after = await admin.query('select consumed_at from public.step_up_grants where id = $1', [rolledBackGrant]);
    const survived = after.rows[0].consumed_at === null;
    console.log(`                   grant still unconsumed after rollback: ${survived} (expected true)`);
    if (!survived) failures += 1;

    // And it is still spendable exactly once afterwards.
    const afterRollback = await race({ url, grantId: rolledBackGrant, userId, racers, outcome: 'commit' });
    console.log(`                   then ${racers} more attempts -> ${afterRollback} consumed (expected 1)`);
    if (afterRollback !== 1) failures += 1;

    await admin.query('delete from public.step_up_grants where user_id = $1', [userId]);
    await admin.query('delete from auth.users where id = $1', [userId]);
  } finally {
    await admin.end().catch(() => undefined);
  }

  console.log(failures === 0 ? 'step-up concurrency evidence: PASS' : `step-up concurrency evidence: FAIL (${failures})`);
  console.log('*** End of sandbox step-up concurrency evidence (not CI evidence) ***');
  process.exit(failures === 0 ? 0 : 1);
}

await main();
