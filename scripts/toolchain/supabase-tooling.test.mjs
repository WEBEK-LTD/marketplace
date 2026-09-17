import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { reviewOfCliAttempt } from './supabase-cli.mjs';
import { tool3StackSettings } from './supabase-config.mjs';
import { ImageLockError, imageName, pullApprovedImages, verifyImages } from './supabase-images.mjs';

const toml = readFileSync(new URL('../../supabase/config.toml', import.meta.url), 'utf8');

test('the committed config enables the transaction pooler on PostgreSQL 17', () => {
  assert.deepEqual(tool3StackSettings(toml), { dbPort: 54322, poolerPort: 54329, problems: [] });
});

test('config problems are reported', () => {
  const disabled = toml.replace('[db.pooler]\n# Enabled for TOOL-3 (owner decision S14): transaction mode, template port and pool sizes.\nenabled = true', '[db.pooler]\nenabled = false');
  assert.match(tool3StackSettings(disabled).problems.join(), /db.pooler must be enabled/);
  assert.match(tool3StackSettings(toml.replace('pool_mode = "transaction"', 'pool_mode = "session"')).problems.join(), /transaction/);
  assert.match(tool3StackSettings(toml.replace('major_version = 17', 'major_version = 15')).problems.join(), /17/);
});

test('only the GitHub latest-version check is a reviewed CLI request', () => {
  assert.match(reviewOfCliAttempt('CONNECT api.github.com:443'), /V1/);
  assert.equal(reviewOfCliAttempt('CONNECT eu.i.posthog.com:443'), undefined);
  assert.equal(reviewOfCliAttempt('CONNECT sentry.io:443'), undefined);
  assert.equal(reviewOfCliAttempt('CONNECT github.com:443'), undefined);
});

test('the committed image lock waits for owner approval, so verification fails closed', () => {
  const committed = JSON.parse(readFileSync(new URL('../../toolchain/supabase-images.json', import.meta.url), 'utf8'));
  assert.equal(committed.status, 'pending-owner-approval');
  assert.deepEqual(committed.images, []);
  assert.match(verifyImages(committed, [])[0], /not approved yet/);
});

test('approved images are pulled by digest under the name the CLI uses', () => {
  assert.equal(imageName('public.ecr.aws/supabase/postgres:17.6.1.165'), 'public.ecr.aws/supabase/postgres');
  assert.equal(imageName('public.ecr.aws/supabase/postgres@sha256:aaa'), 'public.ecr.aws/supabase/postgres');
  assert.equal(imageName('localhost:5000/supabase/supavisor:2.9.7'), 'localhost:5000/supabase/supavisor');
  assert.equal(imageName('supabase/pg_prove:3.36'), 'supabase/pg_prove');
});

test('nothing is pulled from an unapproved lock', () => {
  const committed = JSON.parse(readFileSync(new URL('../../toolchain/supabase-images.json', import.meta.url), 'utf8'));
  assert.throws(() => pullApprovedImages(committed), ImageLockError);
  assert.throws(() => pullApprovedImages({ ...committed, status: 'approved' }), /approvedBy is required/);
});

