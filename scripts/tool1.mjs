// TOOL-1: `netlify build --offline` for one app, under owner decisions D1-D6:
// pinned Deno first on PATH, fresh XDG/Deno directories, every external fetch blocked and recorded,
// and failure if Netlify downloaded or cached its own Deno.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DENO_TOOLCHAIN, ensureDeno, REPO_ROOT, ToolchainError } from './toolchain/deno.mjs';
import { startDenyProxy } from './toolchain/deny-proxy.mjs';
import { checkEntryExports, compareEdgeManifests } from './toolchain/edge-manifest.mjs';

// Outbound attempts reviewed by the owner (decision E1). All are refused by the deny-all proxy;
// none is an accepted dependency of TOOL-1. Anything else fails TOOL-1.
const REVIEWED_BLOCKED_FETCHES = [
  {
    match: /^CONNECT edge\.netlify\.com:443$/,
    disposition: 'Blocked by E1: unversioned remote module imported by the edge bundler config extractor (https://edge.netlify.com/bootstrap/globals/types.ts) and its types version check; fallback verified by manifest comparison',
  },
  {
    match: /^CONNECT list-v2--netlify-plugins\.netlify\.app:443$/,
    disposition: 'Blocked (reviewed): Netlify plugin-list lookup; the plugin version comes from the lockfile',
  },
  {
    match: /^CONNECT [a-z0-9-]+--site-name\.netlify\.app:443$/,
    disposition: 'Blocked (reviewed): Next.js runtime post-build prewarm of placeholder deploy URLs (no site exists); result unused',
  },
];
const reviewOf = (attempt) => REVIEWED_BLOCKED_FETCHES.find((entry) => entry.match.test(attempt))?.disposition;

const app = process.argv[2];
const keepOutput = process.argv.includes('--keep-output');
if (app !== 'web' && app !== 'admin') {
  console.error('Usage: node scripts/tool1.mjs <web|admin> [--keep-output]');
  process.exit(2);
}
const appDir = join(REPO_ROOT, 'apps', app);

function fail(message) {
  throw new ToolchainError(`TOOL-1 (${app}) failed: ${message}`);
}

function denoCaches(root) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 6 || !existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'deno-cli' || entry.name === 'deno-cli-v1') found.push(full);
        walk(full, depth + 1);
      }
    }
  };
  walk(root, 0);
  return found;
}

async function main() {
  const deno = await ensureDeno();
  const work = mkdtempSync(join(tmpdir(), `tool1-${app}-`));
  const xdgConfig = join(work, 'xdg-config');
  const xdgCache = join(work, 'xdg-cache');
  const denoDir = join(work, 'deno-dir');
  const home = process.env.HOME ?? '';
  for (const dir of [xdgConfig, xdgCache, denoDir]) {
    if (existsSync(dir)) fail(`${dir} is not fresh`);
  }
  if (denoCaches(join(home, '.config', 'netlify')).length > 0) fail('a Netlify Deno cache already exists under HOME');

  const debugLogsBefore = new Set(readdirSync(appDir).filter((name) => /^tailwindcss-\d+\.log$/.test(name)));
  const proxy = await startDenyProxy();
  const env = {
    PATH: `${dirname(deno)}:${join(REPO_ROOT, 'node_modules/.bin')}:${process.env.PATH ?? ''}`,
    HOME: home,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: xdgCache,
    DENO_DIR: denoDir,
    // Documented Deno setting (`deno --help`): no background check for newer Deno releases.
    DENO_NO_UPDATE_CHECK: '1',
    HTTP_PROXY: proxy.url,
    HTTPS_PROXY: proxy.url,
    http_proxy: proxy.url,
    https_proxy: proxy.url,
    NO_PROXY: '',
    no_proxy: '',
    NODE_USE_ENV_PROXY: '1',
    NEXT_TELEMETRY_DISABLED: '1',
    NETLIFY_TELEMETRY_DISABLED: '1',
    NO_COLOR: '1',
    CI: '1',
  };

  const which = await capture('sh', ['-c', 'command -v deno && deno --version | head -1'], env, appDir);
  const [resolved, versionLine] = which.output.trim().split('\n');
  if (resolved !== deno) fail(`deno on PATH resolves to ${resolved}`);
  if (versionLine !== DENO_TOOLCHAIN.platforms['linux-x64'].versionLine) fail(`deno on PATH reports ${versionLine}`);

  const build = await capture(join(REPO_ROOT, 'node_modules/.bin/netlify'), ['build', '--offline', '--debug'], env, appDir);
  await proxy.close();
  const logPath = join(work, 'netlify-build.log');
  writeFileSync(logPath, build.output);

  const problems = [];
  if (build.code !== 0) problems.push(`netlify build exited with ${build.code}`);
  if (/Downloading Deno CLI/.test(build.output)) problems.push('Netlify downloaded Deno');
  if (!/Using global installation of Deno CLI/.test(build.output)) problems.push('no evidence that the pinned global Deno was used');
  if (/Using cached Deno CLI/.test(build.output)) problems.push('Netlify used a cached Deno');
  const caches = [...denoCaches(xdgConfig), ...denoCaches(xdgCache), ...denoCaches(join(home, '.config', 'netlify')), ...denoCaches(join(appDir, '.netlify'))];
  if (caches.length > 0) problems.push(`Netlify Deno cache created: ${caches.join(', ')}`);
  for (const artefact of ['.netlify/functions-internal/___netlify-server-handler', '.netlify/edge-functions-dist/manifest.json']) {
    if (!existsSync(join(appDir, artefact))) problems.push(`missing build output ${artefact}`);
  }
  // E1 evidence: the blocked config extraction lost nothing.
  const edgeSrc = join(appDir, '.netlify/edge-functions');
  const edgeDist = join(appDir, '.netlify/edge-functions-dist');
  let manifestCheck = 'not run';
  if (existsSync(join(edgeSrc, 'manifest.json')) && existsSync(join(edgeDist, 'manifest.json'))) {
    const runtimeManifest = JSON.parse(readFileSync(join(edgeSrc, 'manifest.json'), 'utf8'));
    const bundlerManifest = JSON.parse(readFileSync(join(edgeDist, 'manifest.json'), 'utf8'));
    const manifestProblems = compareEdgeManifests(runtimeManifest, bundlerManifest);
    for (const fn of runtimeManifest.functions ?? []) {
      const entry = join(edgeSrc, fn.function, `${fn.function}.js`);
      if (!existsSync(entry)) manifestProblems.push(`edge function ${fn.function}: entry module missing`);
      else manifestProblems.push(...checkEntryExports(fn.function, readFileSync(entry, 'utf8')));
    }
    for (const bundle of bundlerManifest.bundles ?? []) {
      const file = join(edgeDist, bundle.asset);
      if (!existsSync(file) || statSync(file).size === 0) manifestProblems.push(`edge bundle ${bundle.asset} missing or empty`);
      else if (`${createHash('sha256').update(readFileSync(file)).digest('hex')}.eszip` !== bundle.asset) manifestProblems.push(`edge bundle ${bundle.asset} does not match its content hash`);
    }
    problems.push(...manifestProblems);
    manifestCheck = manifestProblems.length === 0 ? 'routes and function config match the Next.js runtime manifest; entries export only a default handler' : 'FAILED';
  }
  const extractionFallbacks = (build.output.match(/Config extraction for .* hit a transient error/g) ?? []).length;
  const attempts = [...new Set(proxy.attempts.map((a) => `${a.method} ${a.target}`))];
  const unreviewed = attempts.filter((a) => reviewOf(a) === undefined);
  if (unreviewed.length > 0) problems.push(`unreviewed external fetch attempts: ${unreviewed.join(', ')}`);

  console.log(JSON.stringify({
    app,
    denoVersion: versionLine,
    denoBinary: deno,
    freshXdgConfigHome: xdgConfig,
    exitCode: build.code,
    manifestCheck,
    configExtractionRetriesObserved: extractionFallbacks,
    blockedFetchAttempts: attempts.map((a) => ({ attempt: a, disposition: reviewOf(a) ?? 'UNREVIEWED' })),
    log: logPath,
    result: problems.length === 0 ? 'PASS' : 'FAIL',
    problems,
  }, null, 2));
  if (!keepOutput) rmSync(join(appDir, '.netlify'), { recursive: true, force: true });
  // `--debug` also enables Tailwind's scanner debug log files; remove the ones this run created.
  for (const name of readdirSync(appDir)) {
    if (/^tailwindcss-\d+\.log$/.test(name) && !debugLogsBefore.has(name)) rmSync(join(appDir, name));
  }
  if (problems.length > 0) process.exit(1);
}

function capture(cmd, args, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('error', (error) => resolve({ code: -1, output: `${output}\n${error.message}` }));
    child.on('exit', (code) => resolve({ code, output }));
  });
}

main().catch((error) => {
  console.error(error instanceof ToolchainError ? error.message : error);
  process.exit(1);
});
