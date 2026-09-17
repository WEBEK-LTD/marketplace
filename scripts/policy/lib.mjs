// Shared helpers for the Phase 1 policy checks (owner decisions E3, E17, E18, E25; Step 9).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO_ROOT } from '../toolchain/deno.mjs';

export { REPO_ROOT };

export class PolicyError extends Error {}

export const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.netlify', '.turbo', '.git', 'test-results', 'playwright-report', 'blob-report']);

/** Repository files (as the project tree), excluding generated and installed directories. */
export function repositoryFiles(root = REPO_ROOT) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      const rel = relative(root, full);
      if (rel === 'supabase/.temp' || rel === 'supabase/.branches') continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(rel);
    }
  };
  walk(root);
  return files.sort();
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ------------------------------------------------------------------ pnpm lockfile / workspace

/**
 * Package versions from the project document of a pnpm 12 lockfile. The first document only records
 * the pnpm package manager itself, which the 14-day rule does not cover (owner decision E12).
 */
export function lockfilePackages(text) {
  const documents = text.split(/^---$/m).map((doc) => doc.trim()).filter(Boolean);
  const project = documents.filter((doc) => !/^\s{4}packageManagerDependencies:/m.test(doc));
  if (project.length !== 1) throw new PolicyError(`expected exactly one project document in pnpm-lock.yaml, found ${project.length}`);
  const lines = project[0].split('\n');
  const start = lines.findIndex((line) => line === 'packages:');
  if (start === -1) throw new PolicyError('pnpm-lock.yaml has no packages section');
  const result = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match = /^ {2}'?((?:@[^/@\s]+\/)?[^@\s']+)@([^':\s(]+)'?:$/.exec(line);
    if (match) result.push({ name: match[1], version: match[2] });
  }
  if (result.length === 0) throw new PolicyError('no packages found in pnpm-lock.yaml');
  return result;
}

/** Minimal reader for the flat pnpm-workspace.yaml used by this repository. */
export function workspaceSettings(text) {
  const settings = { packages: [], allowBuilds: {}, minimumReleaseAgeExclude: [], scalars: {} };
  let section;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    if (line.trim() === '') continue;
    const top = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (top) {
      section = top[1];
      if (top[2] !== '') {
        const value = top[2].replace(/^"(.*)"$/, '$1');
        if (value === '[]') settings[section] = [];
        else settings.scalars[section] = value;
        section = undefined;
      }
      continue;
    }
    if (section === 'packages' || section === 'minimumReleaseAgeExclude') {
      const item = /^\s+-\s+"?([^"]+)"?$/.exec(line);
      if (!item) throw new PolicyError(`unexpected line in ${section}: ${line}`);
      settings[section].push(item[1]);
    } else if (section === 'allowBuilds') {
      const item = /^\s+"?([^":]+)"?:\s*(true|false)$/.exec(line);
      if (!item) throw new PolicyError(`unexpected line in allowBuilds: ${line}`);
      settings.allowBuilds[item[1]] = item[2] === 'true';
    } else {
      throw new PolicyError(`unsupported pnpm-workspace.yaml structure near: ${line}`);
    }
  }
  return settings;
}

// ------------------------------------------------------------------ exception registers

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value) {
  return typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** Returns problems for an exception register entry; `today` is YYYY-MM-DD. */
export function exceptionProblems(entry, requiredFields, today) {
  const problems = [];
  for (const field of requiredFields) {
    if (typeof entry[field] !== 'string' || entry[field].trim() === '') problems.push(`missing ${field}`);
  }
  if (!validDate(entry.approvedOn)) problems.push('approvedOn must be YYYY-MM-DD');
  if (!validDate(entry.expires)) problems.push('expires must be YYYY-MM-DD');
  else if (entry.expires < today) problems.push(`expired on ${entry.expires}`);
  if (validDate(entry.approvedOn) && validDate(entry.expires) && entry.expires < entry.approvedOn) problems.push('expires is before approvedOn');
  return problems;
}

export function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function exists(path) {
  return existsSync(path) && statSync(path).isFile();
}
