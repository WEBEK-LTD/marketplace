// Migration policy (Phase 2). Static and deterministic: it needs no database, so it runs in the policy
// job and fails a pull request before the Supabase job ever starts.
//
// What it enforces:
//   * file names are `NNNN_lower_snake_case.sql`, versions are unique and contiguous from 0001;
//   * every file opens with its own `-- NNNN — ` header, so a copied file cannot keep the wrong number;
//   * every table created by a migration has row level security enabled by some migration;
//   * every SECURITY DEFINER function pins `search_path`;
//   * nothing is ever granted to `anon`;
//   * no password literal is written into a migration;
//   * every committed pgTAP file declares a plan.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './lib.mjs';

export const MIGRATIONS_DIR = 'supabase/migrations';
export const TESTS_DIR = 'supabase/tests';
export const FILE_NAME = /^([0-9]{4})_[a-z][a-z0-9_]*\.sql$/;
const ALLOWED_NON_SQL = new Set(['.gitkeep']);

const CREATE_TABLE = /^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)/gim;
const ENABLE_RLS = /^\s*alter\s+table\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s+enable\s+row\s+level\s+security/gim;
const GRANT_TO_ANON = /^\s*grant\b[^;]*\bto\b[^;]*\banon\b/gim;
const PASSWORD_LITERAL = /\bpassword\s+('|"|\$\$)/gi;

/** Migration and test file names, sorted, with non-SQL entries reported as problems. */
export function listMigrations(root = REPO_ROOT) {
  return readdirSync(join(root, MIGRATIONS_DIR)).sort();
}

export function namingProblems(names) {
  const problems = [];
  const versions = [];
  for (const name of names) {
    if (ALLOWED_NON_SQL.has(name)) continue;
    const match = FILE_NAME.exec(name);
    if (match === null) {
      problems.push(`${MIGRATIONS_DIR}/${name}: name must be NNNN_lower_snake_case.sql`);
      continue;
    }
    versions.push(match[1]);
  }
  const sorted = [...versions].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(versions)) problems.push(`${MIGRATIONS_DIR}: files are not in version order`);
  versions.forEach((version, index) => {
    const expected = String(index + 1).padStart(4, '0');
    if (version !== expected) problems.push(`${MIGRATIONS_DIR}: expected migration ${expected}, found ${version}`);
  });
  return { problems, versions };
}

/** Each migration must introduce itself with its own number, so a duplicated file cannot lie. */
export function headerProblems(name, text) {
  if (ALLOWED_NON_SQL.has(name)) return [];
  const version = FILE_NAME.exec(name)?.[1];
  if (version === undefined) return [];
  const first = text.split('\n')[0] ?? '';
  return first.startsWith(`-- ${version} — `) ? [] : [`${MIGRATIONS_DIR}/${name}: the first line must start with "-- ${version} — "`];
}

/** Matches of a global regular expression as `schema.table` strings. */
function pairs(pattern, text) {
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)].map((m) => `${m[1]}.${m[2]}`);
}

export function contentProblems(name, text) {
  const problems = [];
  const at = (message) => problems.push(`${MIGRATIONS_DIR}/${name}: ${message}`);

  GRANT_TO_ANON.lastIndex = 0;
  for (const match of text.matchAll(GRANT_TO_ANON)) at(`nothing may be granted to anon (${match[0].trim().slice(0, 80)})`);

  PASSWORD_LITERAL.lastIndex = 0;
  for (const match of text.matchAll(PASSWORD_LITERAL)) {
    // `password __FIXTURE_PASSWORD_LITERAL__` style placeholders live in test fixtures, never here.
    at(`a password literal must never appear in a migration (${match[0].trim()})`);
  }

  // SECURITY DEFINER functions must pin their search path. Each function body is delimited by $$.
  const blocks = text.split(/create\s+or\s+replace\s+function|create\s+function/i).slice(1);
  for (const block of blocks) {
    const head = block.split(/\bas\s+\$\$/i)[0] ?? '';
    if (/security\s+definer/i.test(head) && !/set\s+search_path\s*=/i.test(head)) {
      at(`a SECURITY DEFINER function does not pin search_path (${head.split('(')[0].trim().slice(0, 60)})`);
    }
  }
  return problems;
}

export function rlsProblems(files) {
  const created = new Map();
  const enabled = new Set();
  for (const { name, text } of files) {
    for (const table of pairs(CREATE_TABLE, text)) if (!created.has(table)) created.set(table, name);
    for (const table of pairs(ENABLE_RLS, text)) enabled.add(table);
  }
  return [...created.entries()]
    .filter(([table]) => !enabled.has(table))
    .map(([table, name]) => `${MIGRATIONS_DIR}/${name}: ${table} is created but row level security is never enabled for it`);
}

export function testPlanProblems(root = REPO_ROOT) {
  const dir = join(root, TESTS_DIR);
  const names = readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
  const problems = names
    .filter((name) => !/select\s+plan\((\d+)\)/.test(readFileSync(join(dir, name), 'utf8')))
    .map((name) => `${TESTS_DIR}/${name}: every pgTAP file must declare a plan`);
  if (names.length === 0) problems.push(`${TESTS_DIR}: no pgTAP files found`);
  return { problems, count: names.length };
}

export function checkMigrations(root = REPO_ROOT) {
  const names = listMigrations(root);
  const { problems, versions } = namingProblems(names);
  const files = names
    .filter((name) => name.endsWith('.sql'))
    .map((name) => ({ name, text: readFileSync(join(root, MIGRATIONS_DIR, name), 'utf8') }));
  for (const file of files) {
    problems.push(...headerProblems(file.name, file.text));
    problems.push(...contentProblems(file.name, file.text));
  }
  problems.push(...rlsProblems(files));
  const tests = testPlanProblems(root);
  problems.push(...tests.problems);
  return { migrations: versions.length, tests: tests.count, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = checkMigrations();
  if (result.problems.length > 0) {
    console.error(`migration policy failed:\n  ${result.problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`migration policy passed: ${result.migrations} migrations, ${result.tests} pgTAP files.`);
}
