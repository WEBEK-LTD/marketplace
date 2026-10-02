// Sandbox concurrency evidence for the password-reset consumption primitive (C-18) — NOT CI evidence.
//
// pgTAP runs in a single session, so it can prove the semantics of
// `app_private.consume_password_reset_token` but not that two *simultaneous* callers cannot both win.
// This opens real, separate connections and races them against one token, which is the only way to
// observe the row lock actually serialising.
//
// Two scenarios are run:
//
//   commit   — every racer commits, so the token is spent and exactly one caller may have it.
//   rollback — the winner's surrounding work fails and its transaction rolls back, so the token must
//              come back and exactly one *later* caller may take it. This is what distinguishes
//              "consumed when the reset succeeds" from "consumed on attempt", and it is why the API
//              consumes inside the transaction that changes the password.
//
//   SUPPLEMENTAL_SCHEMA_URL=postgresql://... node scripts/db/password-reset-concurrency.mjs [--racers N]
//
// The URL must point at loopback and is never printed. No clear token exists in this script: the
// racers pass a digest, exactly as the API does.
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { REPO_ROOT } from '../toolchain/deno.mjs';

const pg = createRequire(join(REPO_ROOT, 'packages/db/package.json'))('pg');

const BANNER = '*** Sandbox password-reset concurrency evidence — NOT CI evidence ***';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

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

/** A digest of fresh randomness, the way the API produces one. The random value is never returned. */
function freshDigest() {
  return createHash('sha256').update(randomBytes(32)).digest();
}

/**
 * One racer: its own connection, its own transaction.
 *
 * Every racer waits on the same barrier before calling, so the calls overlap instead of queueing. The
 * transaction is held open briefly after a successful consume so the row lock is genuinely contended,
 * then committed or rolled back according to the scenario.
 */
async function race({ url, digest, userId, racers, outcome }) {
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
          'select outcome, user_id from app_private.consume_password_reset_token($1::bytea, $2::uuid)',
          [digest, userId],
        );
        const consumed = result.rows[0].outcome === 'consumed';
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
      `insert into auth.users (id, email) values (gen_random_uuid(), 'reset-concurrency-probe@test.invalid')
       returning id`,
    );
    const userId = rows[0].id;

    const newToken = async () => {
      const digest = freshDigest();
      const issued = await admin.query(
        'select outcome from app_private.issue_password_reset_token($1::uuid, $2::bytea)',
        [userId, digest],
      );
      if (issued.rows[0].outcome !== 'issued') throw new Error('could not issue a probe token');
      return digest;
    };

    // 1. All racers commit: exactly one may consume.
    const committed = await race({ url, digest: await newToken(), userId, racers, outcome: 'commit' });
    console.log(`commit scenario:   ${racers} simultaneous attempts -> ${committed} consumed (expected 1)`);
    if (committed !== 1) failures += 1;

    // 2. All racers roll back: the token must survive, so a later caller can still spend it.
    const rolledBack = await newToken();
    const before = await race({ url, digest: rolledBack, userId, racers, outcome: 'rollback' });
    console.log(`rollback scenario: ${racers} simultaneous attempts -> ${before} consumed before rollback`);
    const after = await admin.query(
      'select consumed_at from app_private.password_reset_tokens where token_hash = $1::bytea',
      [rolledBack],
    );
    const survived = after.rows[0].consumed_at === null;
    console.log(`                   token still unconsumed after rollback: ${survived} (expected true)`);
    if (!survived) failures += 1;

    // And it is still spendable exactly once afterwards.
    const afterRollback = await race({ url, digest: rolledBack, userId, racers, outcome: 'commit' });
    console.log(`                   then ${racers} more attempts -> ${afterRollback} consumed (expected 1)`);
    if (afterRollback !== 1) failures += 1;

    await admin.query('delete from app_private.password_reset_tokens where user_id = $1', [userId]);
    await admin.query('delete from auth.users where id = $1', [userId]);
  } finally {
    await admin.end().catch(() => undefined);
  }

  console.log(failures === 0 ? 'password-reset concurrency evidence: PASS' : `password-reset concurrency evidence: FAIL (${failures})`);
  console.log('*** End of sandbox password-reset concurrency evidence (not CI evidence) ***');
  process.exit(failures === 0 ? 0 : 1);
}

await main();
