import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { reviewOfCliAttempt } from './supabase-cli.mjs';
import { tool3StackSettings } from './supabase-config.mjs';
import { ImageLockError, approvalProblems, imageName, pullApprovedImages, sanitizeToolError, verifyImages } from './supabase-images.mjs';

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

test('the committed image lock carries the owner-approved discovery result', () => {
  const committed = JSON.parse(readFileSync(new URL('../../toolchain/supabase-images.json', import.meta.url), 'utf8'));
  assert.equal(committed.status, 'approved');
  assert.deepEqual(approvalProblems(committed), []);
  assert.deepEqual(
    committed.images.map((image) => image.reference).sort(),
    ['public.ecr.aws/supabase/pg_prove:3.36', 'public.ecr.aws/supabase/postgres:17.6.1.165', 'public.ecr.aws/supabase/supavisor:2.9.7'],
  );
  for (const image of committed.images) assert.match(image.digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(committed.excludedServices, ['gotrue', 'realtime', 'storage-api', 'imgproxy', 'kong', 'mailpit', 'postgrest', 'postgres-meta', 'studio', 'edge-runtime', 'logflare', 'vector']);
  assert.equal(committed.excludedServices.length, 12);
  assert.equal(committed.poolerUserFormat, '{role}.pooler-dev');
  assert.deepEqual(committed.requiredServices, ['supabase/postgres', 'supabase/supavisor']);
  assert.ok(committed.exclusionEvidence && committed.poolerUserFormatEvidence);
});

test('verification still fails closed for an unapproved or malformed lock', () => {
  const committed = JSON.parse(readFileSync(new URL('../../toolchain/supabase-images.json', import.meta.url), 'utf8'));
  assert.match(verifyImages({ ...committed, status: 'pending-owner-approval' }, [])[0], /not approved yet/);
  assert.match(approvalProblems({ ...committed, approvedOn: '<YYYY-MM-DD>' }).join(), /approvedOn must be YYYY-MM-DD/);
  assert.match(approvalProblems({ ...committed, approvedBy: '' }).join(), /approvedBy is required/);
  assert.match(approvalProblems({ ...committed, excludedServices: [...committed.excludedServices, 'supavisor'] }).join(), /may not be excluded/);
  assert.match(approvalProblems({ ...committed, exclusionEvidence: null }).join(), /exclusionEvidence/);
  assert.match(approvalProblems({ ...committed, poolerUserFormat: 'tool3_app_api' }).join(), /poolerUserFormat/);
  assert.match(approvalProblems({ ...committed, images: [{ reference: 'public.ecr.aws/supabase/postgres:17.6.1.165', digest: 'sha256:short' }] }).join(), /invalid image entry/);
  // A running image that is not the approved digest is rejected.
  const running = [{ container: 'supabase_db_marketplace', reference: 'public.ecr.aws/supabase/postgres:17.6.1.165', repoDigests: [`public.ecr.aws/supabase/postgres@sha256:${'b'.repeat(64)}`] }];
  assert.match(verifyImages(committed, running).join(), /digest mismatch/);
});

test('approved images are pulled by digest under the name the CLI uses', () => {
  assert.equal(imageName('public.ecr.aws/supabase/postgres:17.6.1.165'), 'public.ecr.aws/supabase/postgres');
  assert.equal(imageName('public.ecr.aws/supabase/postgres@sha256:aaa'), 'public.ecr.aws/supabase/postgres');
  assert.equal(imageName('localhost:5000/supabase/supavisor:2.9.7'), 'localhost:5000/supabase/supavisor');
  assert.equal(imageName('supabase/pg_prove:3.36'), 'supabase/pg_prove');
});

test('nothing is pulled from an unapproved lock', () => {
  const committed = JSON.parse(readFileSync(new URL('../../toolchain/supabase-images.json', import.meta.url), 'utf8'));
  assert.throws(() => pullApprovedImages({ ...committed, status: 'pending-owner-approval' }), ImageLockError);
  assert.throws(() => pullApprovedImages({ ...committed, approvedBy: '' }), /approvedBy is required/);
  assert.throws(() => pullApprovedImages({ ...committed, approvedOn: '<YYYY-MM-DD>' }), /approvedOn must be YYYY-MM-DD/);
});

// --- diagnostics (Phase 1 Step 9): failures must be identifiable without leaking anything ----------
test('ImageLockError keeps its own name so failures are never reduced to "failed: Error"', () => {
  const error = new ImageLockError('docker pull failed: toomanyrequests');
  assert.equal(error.name, 'ImageLockError');
  assert.ok(error instanceof Error);
  assert.equal(`${error.name}: ${error.message}`, 'ImageLockError: docker pull failed: toomanyrequests');
});

test('docker stderr is surfaced, but sanitised and bounded', () => {
  // The relevant detail survives: this is what identifies a registry rate limit or a missing manifest.
  assert.equal(sanitizeToolError('Error response from daemon: toomanyrequests: Rate exceeded\n'), 'Error response from daemon: toomanyrequests: Rate exceeded');
  assert.equal(sanitizeToolError('first line\nmanifest unknown\n'), 'manifest unknown');
  assert.equal(sanitizeToolError(''), '');
  assert.equal(sanitizeToolError(undefined), '');
  assert.equal(sanitizeToolError('   \n  \n'), '');
});

test('credential-shaped values never reach the log', () => {
  assert.equal(sanitizeToolError('failed for postgresql://user:hunter2@127.0.0.1:54322/postgres'), 'failed for <url>');
  assert.equal(sanitizeToolError('denied for registry.example.com/x: Authorization: Bearer abc.def.ghi'), 'denied for registry.example.com/x: Authorization <redacted>');
  assert.equal(sanitizeToolError('login admin:s3cr3t@registry.example.com refused'), 'login <credentials>@registry.example.com refused');
  assert.equal(sanitizeToolError('token=abc123 rejected'), 'token <redacted>');
  assert.equal(sanitizeToolError('password: hunter2'), 'password <redacted>');
  for (const text of ['hunter2', 'abc.def.ghi', 's3cr3t', 'abc123']) {
    assert.ok(!sanitizeToolError(`postgresql://user:hunter2@h/db Authorization: Bearer abc.def.ghi admin:s3cr3t@r token=abc123`).includes(text));
  }
});

test('the diagnostic is length-bounded', () => {
  const long = 'x'.repeat(5000);
  assert.equal(sanitizeToolError(long).length, 201);
  assert.ok(sanitizeToolError(long).endsWith('…'));
  assert.equal(sanitizeToolError('y'.repeat(50), 10), 'yyyyyyyyyy…');
  assert.equal(sanitizeToolError('short', 10), 'short');
});

