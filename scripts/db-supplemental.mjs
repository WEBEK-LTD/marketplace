// Sandbox supplemental evidence only — NOT TOOL-3, NOT Supabase, NOT Supavisor (owner decision S1 b).
// Runs the same scenario against a plain PostgreSQL server behind PgBouncer in transaction mode,
// using SUPPLEMENTAL_POOLER_URL and SUPPLEMENTAL_ADMIN_URL. The result never counts as TOOL-3.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT } from './toolchain/deno.mjs';

console.log('*** Sandbox supplemental evidence only — NOT TOOL-3, NOT Supabase, NOT Supavisor ***');
const env = {
  PATH: process.env.PATH ?? '',
  SUPPLEMENTAL_POOLER_URL: process.env.SUPPLEMENTAL_POOLER_URL,
  SUPPLEMENTAL_ADMIN_URL: process.env.SUPPLEMENTAL_ADMIN_URL,
};
const child = spawn(process.execPath, [join(REPO_ROOT, 'packages/db/dist/tool3/run.js'), 'supplemental'], { env, stdio: 'inherit' });
child.on('exit', (code) => {
  console.log('*** End of sandbox supplemental evidence (not TOOL-3) ***');
  process.exit(code ?? 1);
});
