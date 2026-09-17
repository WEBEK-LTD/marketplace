// 14-day release-age policy for pnpm-managed packages (owner decisions I1, E18, E25). It does not apply to
// GitHub Actions, the Node.js runtime, pnpm itself, standalone tools or Docker images (E12).
// Usage: node scripts/policy/package-age.mjs [--report <file outside the repository>]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exceptionProblems, lockfilePackages, PolicyError, readJson, REPO_ROOT, todayUtc, workspaceSettings } from './lib.mjs';

export const MIN_AGE_MINUTES = 20160;
const REQUIRED = ['package', 'version', 'advisory', 'reason', 'approvedBy', 'approvedOn', 'expires'];

export function exceptionRegisterProblems(register, workspace, today) {
  const problems = [];
  const listed = new Set(workspace.minimumReleaseAgeExclude);
  const approved = new Set();
  for (const entry of register.exceptions) {
    const issues = exceptionProblems(entry, REQUIRED, today);
    const key = `${entry.package}@${entry.version}`;
    if (issues.length > 0) problems.push(`release-age exception ${key}: ${issues.join(', ')}`);
    else approved.add(key);
    if (!listed.has(key)) problems.push(`release-age exception ${key} is not listed in pnpm-workspace.yaml minimumReleaseAgeExclude`);
  }
  for (const key of listed) {
    if (!register.exceptions.some((e) => `${e.package}@${e.version}` === key)) problems.push(`minimumReleaseAgeExclude entry ${key} has no approved exception in policy/release-age-exceptions.json`);
  }
  return { problems, approved };
}

export function evaluateAges(packages, publishTimes, now, approved) {
  const cutoff = now.getTime() - MIN_AGE_MINUTES * 60_000;
  const tooNew = [];
  const undated = [];
  const excepted = [];
  for (const { name, version } of packages) {
    const published = publishTimes.get(name)?.[version];
    if (published === undefined) {
      undated.push(`${name}@${version}`);
      continue;
    }
    if (Date.parse(published) > cutoff) {
      if (approved.has(`${name}@${version}`)) excepted.push(`${name}@${version}`);
      else tooNew.push(`${name}@${version} (published ${published})`);
    }
  }
  return { tooNew, undated, excepted };
}

async function fetchTimes(name) {
  const url = `https://registry.npmjs.org/${name.replace('/', '%2F')}`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()).time ?? {};
    } catch (error) {
      if (attempt === 3) throw new PolicyError(`registry lookup failed for ${name}: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  return undefined;
}

async function main() {
  const workspace = workspaceSettings(readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8'));
  if (workspace.scalars.minimumReleaseAge !== String(MIN_AGE_MINUTES)) throw new PolicyError(`pnpm-workspace.yaml minimumReleaseAge must be ${MIN_AGE_MINUTES}`);
  const now = new Date();
  const register = readJson(join(REPO_ROOT, 'policy/release-age-exceptions.json'));
  const { problems, approved } = exceptionRegisterProblems(register, workspace, todayUtc(now));
  const packages = lockfilePackages(readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8'));
  const names = [...new Set(packages.map((p) => p.name))];
  const times = new Map();
  const queue = [...names];
  await Promise.all(Array.from({ length: 16 }, async () => {
    while (queue.length > 0) {
      const name = queue.shift();
      times.set(name, await fetchTimes(name));
    }
  }));
  const ages = evaluateAges(packages, times, now, approved);
  problems.push(...ages.tooNew.map((p) => `younger than 14 days: ${p}`), ...ages.undated.map((p) => `no publish time in the registry: ${p}`));
  const summary = { check: 'package-age', checkedAt: now.toISOString(), packageVersions: packages.length, packageNames: names.length, minimumReleaseAgeMinutes: MIN_AGE_MINUTES, approvedExceptions: ages.excepted, problems };
  const reportIndex = process.argv.indexOf('--report');
  if (reportIndex !== -1) writeFileSync(process.argv[reportIndex + 1], `${JSON.stringify(summary, null, 2)}\n`);
  if (problems.length > 0) {
    console.error(`package-age check failed:\n  ${problems.join('\n  ')}`);
    return 1;
  }
  console.log(`package-age check passed: ${packages.length} package versions (${names.length} names) are at least 14 days old${ages.excepted.length ? `; approved exceptions: ${ages.excepted.join(', ')}` : ''}.`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (error) => {
    console.error(`package-age check failed: ${error.message}`);
    process.exit(1);
  });
}
