// Small CI checks and sanitised summaries (owner decisions E6, E9, E10, E22).
//   redis-version                       redis-server must report the approved version
//   playwright-browser                  Playwright 1.62.1 must pin, and have installed, the approved Chromium build
//   tool-versions --job <name> --output <file>   sanitised tool/version summary
//   e2e-summary --report <file> --output <file>  test titles and outcomes only
//   tool1-summary --input <file> --output <file> TOOL-1 result without local paths
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from '../toolchain/deno.mjs';

const SYSTEM = JSON.parse(readFileSync(join(REPO_ROOT, 'toolchain/ci-system.json'), 'utf8'));

export class CheckError extends Error {}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return result.error || result.status !== 0 ? undefined : `${result.stdout}${result.stderr}`.trim();
}

export function redisVersion(output) {
  return /v=(\d+\.\d+\.\d+)/.exec(output ?? '')?.[1];
}

export function playwrightBrowser() {
  const require = createRequire(join(REPO_ROOT, 'packages/e2e/package.json'));
  const core = dirname(require.resolve('playwright-core/package.json', { paths: [dirname(require.resolve('@playwright/test/package.json'))] }));
  const browsers = JSON.parse(readFileSync(join(core, 'browsers.json'), 'utf8')).browsers;
  const chromium = browsers.find((b) => b.name === 'chromium');
  return { playwrightCore: JSON.parse(readFileSync(join(core, 'package.json'), 'utf8')).version, revision: chromium?.revision, browserVersion: chromium?.browserVersion };
}

/** Path of the Chromium executable Playwright will use (honours Playwright's own browser location settings). */
export function installedChromium() {
  const require = createRequire(join(REPO_ROOT, 'packages/e2e/package.json'));
  const core = require(require.resolve('playwright-core', { paths: [dirname(require.resolve('@playwright/test/package.json'))] }));
  return core.chromium.executablePath();
}

export function sanitizeE2eReport(report) {
  const tests = [];
  const walk = (suite, prefix) => {
    const title = [prefix, suite.title].filter(Boolean).join(' › ');
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) tests.push({ title: `${title} › ${spec.title}`, project: test.projectName, status: test.status ?? test.results?.at(-1)?.status });
    }
    for (const child of suite.suites ?? []) walk(child, title);
  };
  for (const suite of report.suites ?? []) walk(suite, '');
  return { tool: 'Playwright', stats: report.stats ? { expected: report.stats.expected, unexpected: report.stats.unexpected, flaky: report.stats.flaky, skipped: report.stats.skipped } : null, tests };
}

/** Drops local file paths (Deno binary, temporary directories, log file) from the TOOL-1 result. */
export function sanitizeTool1(result) {
  const { log: _log, denoBinary: _denoBinary, freshXdgConfigHome: _xdg, ...rest } = result;
  return rest;
}

function outsideRepo(path) {
  if (!path || !isAbsolute(path)) return false;
  const rel = relative(REPO_ROOT, path);
  return rel.startsWith('..') || isAbsolute(rel);
}

function arg(name, { output = false } = {}) {
  const value = process.argv[process.argv.indexOf(name) + 1];
  if (!process.argv.includes(name) || !value) throw new CheckError(`missing ${name}`);
  if (output && !outsideRepo(value)) throw new CheckError(`${name} must be an absolute path outside the repository`);
  return value;
}

function main() {
  const command = process.argv[2];
  if (command === 'redis-version') {
    const found = redisVersion(run('redis-server', ['--version']));
    if (found !== SYSTEM.redis.expectedVersion) throw new CheckError(`redis-server version ${found ?? 'unknown'} does not match the approved ${SYSTEM.redis.expectedVersion}`);
    console.log(`redis-server ${found} (approved)`);
  } else if (command === 'playwright-browser') {
    const found = playwrightBrowser();
    const expected = SYSTEM.playwright;
    if (found.revision !== expected.revision || found.browserVersion !== expected.browserVersion) throw new CheckError(`Playwright pins chromium ${found.browserVersion} (revision ${found.revision}); approved ${expected.browserVersion} (revision ${expected.revision})`);
    if (process.argv.includes('--installed')) {
      const executable = installedChromium();
      if (!executable.includes(`-${expected.revision}`) || !existsSync(executable)) throw new CheckError(`Chromium revision ${expected.revision} is not installed`);
    }
    console.log(`Playwright ${found.playwrightCore} pins ${expected.browserTitle} ${found.browserVersion} (revision ${found.revision})${process.argv.includes('--installed') ? ', installed' : ''}`);
  } else if (command === 'tool-versions') {
    const job = arg('--job');
    const os = existsSync('/etc/os-release') ? /VERSION_ID="?([^"\n]+)/.exec(readFileSync('/etc/os-release', 'utf8'))?.[1] : undefined;
    const summary = {
      job,
      os: os ? `ubuntu ${os}` : process.platform,
      runnerImageNote: SYSTEM.runnerNote,
      node: process.version,
      pnpm: run('pnpm', ['--version']) ?? null,
      docker: run('docker', ['version', '--format', '{{.Server.Version}}']) ?? null,
      redis: redisVersion(run('redis-server', ['--version'])) ?? null,
      approved: { node: SYSTEM.node, pnpm: SYSTEM.pnpm, redis: SYSTEM.redis.expectedVersion, chromium: `${SYSTEM.playwright.browserVersion} (revision ${SYSTEM.playwright.revision})` },
    };
    writeFileSync(arg('--output', { output: true }), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`tool versions recorded for ${job}`);
  } else if (command === 'e2e-summary') {
    const summary = sanitizeE2eReport(JSON.parse(readFileSync(arg('--report'), 'utf8')));
    writeFileSync(arg('--output', { output: true }), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`e2e summary: ${summary.tests.length} tests`);
  } else if (command === 'tool1-summary') {
    const summary = sanitizeTool1(JSON.parse(readFileSync(arg('--input'), 'utf8')));
    writeFileSync(arg('--output', { output: true }), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`TOOL-1 summary: ${summary.app ?? ''} ${summary.result}`);
  } else throw new CheckError('Usage: checks.mjs <redis-version|playwright-browser [--installed]|tool-versions|e2e-summary|tool1-summary> ...');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof CheckError ? error.message : `check failed: ${error.message}`);
    process.exit(1);
  }
}
