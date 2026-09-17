// Every Supabase CLI invocation goes through here (owner decisions S16 and V1): telemetry opt-out
// variables are always set, and all outbound requests from the CLI process are refused and recorded
// by the local deny-all proxy. Only the reviewed, non-fatal latest-version check may be attempted.
// Requests to loopback addresses (the local stack) are not proxied by the CLI.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './deno.mjs';
import { startDenyProxy } from './deny-proxy.mjs';

export const SUPABASE_CLI = join(REPO_ROOT, 'node_modules/.bin/supabase');
export const SUPABASE_CLI_VERSION = '2.116.0';

const REVIEWED_BLOCKED = [
  {
    match: /^CONNECT api\.github\.com:443$/,
    disposition: 'Blocked by V1: Supabase CLI latest-version check (non-fatal; must never succeed)',
  },
];

export function reviewOfCliAttempt(attempt) {
  return REVIEWED_BLOCKED.find((entry) => entry.match.test(attempt))?.disposition;
}

/** Runs the pinned CLI with the approved network policy. Never throws for a CLI failure. */
export async function runSupabase(args, { cwd = REPO_ROOT, inheritOutput = false, extraEnv = {} } = {}) {
  const proxy = await startDenyProxy();
  const env = {
    ...process.env,
    ...extraEnv,
    SUPABASE_TELEMETRY_DISABLED: '1',
    DO_NOT_TRACK: '1',
    HTTPS_PROXY: proxy.url,
    HTTP_PROXY: proxy.url,
    https_proxy: proxy.url,
    http_proxy: proxy.url,
    NO_PROXY: '',
    no_proxy: '',
  };
  const result = await new Promise((resolve) => {
    const child = spawn(SUPABASE_CLI, args, { cwd, env, stdio: inheritOutput ? ['inherit', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    child.on('error', (error) => resolve({ code: -1, output: `${output}\n${error.message}` }));
    child.on('exit', (code) => resolve({ code: code ?? -1, output }));
  });
  // Give background requests a moment to reach the proxy before closing it.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await proxy.close();
  const attempts = [...new Set(proxy.attempts.map((a) => `${a.method} ${a.target}`))];
  const unreviewed = attempts.filter((a) => reviewOfCliAttempt(a) === undefined);
  return { ...result, attempts, unreviewed };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runSupabase(process.argv.slice(2), { cwd: process.cwd(), inheritOutput: true });
  const summary = result.attempts.map((a) => `${a} [${reviewOfCliAttempt(a) ?? 'UNREVIEWED'}]`);
  process.stderr.write(`\n[supabase-cli policy] outbound attempts (all refused): ${summary.length ? summary.join('; ') : 'none'}\n`);
  if (result.unreviewed.length > 0) {
    process.stderr.write('[supabase-cli policy] FAIL: unreviewed outbound request attempted\n');
    process.exit(1);
  }
  process.exit(result.code);
}
