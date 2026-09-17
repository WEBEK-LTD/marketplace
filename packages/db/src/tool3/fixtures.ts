import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { FIXTURE_ROLE } from './config.js';

const FIXTURE_DIR = new URL('../../test/fixtures/', import.meta.url);
export const USERS_PER_RUN = 10;
export const NOTES_PER_USER = 2;

export interface FixtureRun {
  readonly password: string;
  readonly users: readonly string[];
}

function fixtureSql(name: string): string {
  return readFileSync(new URL(name, FIXTURE_DIR), 'utf8');
}

/** Creates the throwaway schema, fixture role and rows through the direct (admin) connection. */
export async function setUpFixtures(admin: pg.Client): Promise<FixtureRun> {
  const password = randomBytes(24).toString('base64url');
  const users = Array.from({ length: USERS_PER_RUN }, () => randomUUID());
  await tearDownFixtures(admin);
  const setup = fixtureSql('tool3-setup.sql').replace('__FIXTURE_PASSWORD_LITERAL__', admin.escapeLiteral(password));
  await admin.query(setup);
  for (const user of users) {
    for (let n = 0; n < NOTES_PER_USER; n += 1) {
      await admin.query('insert into tool3.notes (owner_sub, body) values ($1, $2)', [user, `fixture note ${n + 1}`]);
    }
  }
  return { password, users };
}

/** Removes everything the fixtures created. Safe to run when nothing exists. */
export async function tearDownFixtures(admin: pg.Client): Promise<void> {
  const exists = await admin.query('select 1 from pg_roles where rolname = $1', [FIXTURE_ROLE]);
  if (exists.rowCount !== 0) {
    await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where usename = $1 and pid <> pg_backend_pid()', [FIXTURE_ROLE]);
  }
  await admin.query(fixtureSql('tool3-teardown.sql'));
}
