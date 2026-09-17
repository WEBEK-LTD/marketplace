// TOOL-3 (owner decisions S1, S2, S11, S13, V1): runs only against the local Supabase stack through
// its transaction-mode pooler. It fails closed if the stack, its configuration, the image digests or the
// connection variables are not as required. It never falls back to any other database.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT } from './toolchain/deno.mjs';
import { tool3StackSettings } from './toolchain/supabase-config.mjs';
import { reviewOfCliAttempt, runSupabase } from './toolchain/supabase-cli.mjs';
import { ImageLockError, verifyImages } from './toolchain/supabase-images.mjs';

function stop(message) {
  console.error(`TOOL-3 not run: ${message}`);
  process.exit(1);
}

const settings = tool3StackSettings();
if (settings.problems.length > 0) stop(`supabase/config.toml: ${settings.problems.join('; ')}`);
for (const name of ['TOOL3_POOLER_URL', 'TOOL3_ADMIN_URL']) {
  if (!process.env[name]) stop(`${name} is required.`);
}

const status = await runSupabase(['status']);
for (const attempt of status.attempts) console.log(`supabase status outbound attempt (refused): ${attempt} [${reviewOfCliAttempt(attempt) ?? 'UNREVIEWED'}]`);
if (status.unreviewed.length > 0) stop('the Supabase CLI attempted an unreviewed outbound request.');
if (status.code !== 0) stop('the local Supabase stack is not running (`pnpm run supabase start`).');

try {
  const problems = verifyImages();
  if (problems.length > 0) stop(`image digest verification failed: ${problems.join('; ')}`);
} catch (error) {
  stop(error instanceof ImageLockError ? error.message : 'image digest verification failed.');
}

const env = { PATH: process.env.PATH ?? '', TOOL3_POOLER_URL: process.env.TOOL3_POOLER_URL, TOOL3_ADMIN_URL: process.env.TOOL3_ADMIN_URL };
const child = spawn(process.execPath, [join(REPO_ROOT, 'packages/db/dist/tool3/run.js'), 'supabase', String(settings.poolerPort), String(settings.dbPort)], { env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
