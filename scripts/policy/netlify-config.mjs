// Netlify deployment-configuration policy.
//
// **The defect this exists to prevent.** Netlify reads `netlify.toml` from the site's base directory. A site made
// by connecting this repository has no base or package directory set, so that directory is the repository root —
// and while no `netlify.toml` existed there, Netlify found no repository configuration at all and fell back to the
// build command and publish directory stored in the site's own settings. A deploy therefore kept running
// `pnpm --filter @repo/admin run build` and publishing `apps/admin/.next` long after 0108 merged the console into
// `apps/web` and deleted `apps/admin`. The repository was correct and irrelevant at the same time.
//
// So the rule is not "the configuration is right". It is **"the repository is authoritative, and says the right
// thing"** — a file that is never read cannot be wrong, which is precisely why its absence has to be a failure.
//
// Three things are asserted, and the third is the one that would have caught the original defect:
//
//   1. The root `netlify.toml` exists and names the single web build.
//   2. The app-scoped copy agrees with it exactly, so the configuration TOOL-1 verifies and the configuration the
//      site deploys cannot drift apart.
//   3. No Netlify configuration anywhere names `@repo/admin` or `apps/admin/.next`, and no `apps/admin` directory
//      exists to be built.
//
// **The admin check reads parsed values, never raw text.** The root file's own comment block quotes the obsolete
// command verbatim to explain the bug, and a text scan would fail on that explanation — the same false-positive
// trap that made three earlier detectors in this repository wrong. A comment is not configuration.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The build this repository deploys, and the only one. */
export const EXPECTED_BUILD_COMMAND = 'pnpm --filter "@repo/web..." run build';
export const EXPECTED_PUBLISH_DIR = 'apps/web/.next';
export const EXPECTED_NODE_VERSION = '24.21.0';
export const EXPECTED_PLUGINS = Object.freeze(['@netlify/plugin-nextjs']);

/**
 * The two configuration files, and why each one exists.
 *
 * `authoritative` is the file the deployed site reads. The other is read only by TOOL-1, which passes
 * `--filter @repo/web` and so resolves configuration from the workspace package's own directory.
 */
export const CONFIG_PATHS = Object.freeze([
  Object.freeze({ path: 'netlify.toml', authoritative: true, read_by: 'the deployed Netlify site' }),
  Object.freeze({ path: 'apps/web/netlify.toml', authoritative: false, read_by: 'TOOL-1 (`netlify build --filter @repo/web`)' }),
]);

/**
 * The slice of TOML these files use: tables, one array-of-tables, and basic quoted string values.
 *
 * Written out rather than taken from a library because the policy scripts in this repository take no
 * dependencies, and because the slice is genuinely small. What it does handle carefully is the one thing that
 * matters here: a `#` or a `"` **inside** a string is data, not a comment and not a terminator. The build command
 * contains escaped quotes (`--filter \"@repo/web...\"`), so a line-wise comment strip would corrupt it.
 *
 * Anything outside the slice — multi-line strings, arrays, inline tables, numbers, dates — is not silently
 * ignored: {@link parseTomlSubset} reports it, so a file that grows past what this can read fails the check
 * instead of being misread by it.
 */
export function parseTomlSubset(text) {
  const result = { tables: new Map(), arrays: new Map(), unsupported: [] };
  let table = '';
  let isArrayTable = false;

  for (const [index, rawLine] of text.split('\n').entries()) {
    const line = stripComment(rawLine).trim();
    if (line === '') continue;

    const arrayHeader = /^\[\[([A-Za-z0-9_.-]+)\]\]$/.exec(line);
    if (arrayHeader !== null) {
      table = arrayHeader[1];
      isArrayTable = true;
      if (!result.arrays.has(table)) result.arrays.set(table, []);
      result.arrays.get(table).push(new Map());
      continue;
    }

    const header = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (header !== null) {
      table = header[1];
      isArrayTable = false;
      if (!result.tables.has(table)) result.tables.set(table, new Map());
      continue;
    }

    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (pair === null) {
      result.unsupported.push({ line: index + 1, text: line, reason: 'not a table header or a key/value pair' });
      continue;
    }
    const value = readBasicString(pair[2]);
    if (value === null) {
      result.unsupported.push({ line: index + 1, text: line, reason: 'value is not a basic quoted string' });
      continue;
    }
    const target = isArrayTable
      ? result.arrays.get(table).at(-1)
      : (result.tables.get(table) ?? result.tables.set(table, new Map()).get(table));
    target.set(pair[1], value);
  }
  return result;
}

/** Removes a `#` comment, but only one that is outside a basic string. */
function stripComment(line) {
  let inString = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inString && ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '"') inString = !inString;
    else if (ch === '#' && !inString) return line.slice(0, i);
  }
  return line;
}

/** The value of a `"…"` basic string, with escapes resolved, or null when the text is not one. */
function readBasicString(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('"')) return null;
  let value = '';
  for (let i = 1; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === '\\') {
      const next = trimmed[i + 1];
      if (next === undefined) return null;
      value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
      i += 1;
      continue;
    }
    if (ch === '"') return trimmed.slice(i + 1).trim() === '' ? value : null;
    value += ch;
  }
  return null;
}

/** The fields this policy cares about, read out of a parsed file. */
export function readConfig(text) {
  const parsed = parseTomlSubset(text);
  const build = parsed.tables.get('build') ?? new Map();
  const environment = parsed.tables.get('build.environment') ?? new Map();
  return {
    command: build.get('command'),
    publish: build.get('publish'),
    nodeVersion: environment.get('NODE_VERSION'),
    plugins: (parsed.arrays.get('plugins') ?? []).map((entry) => entry.get('package')),
    unsupported: parsed.unsupported,
  };
}

/** Every value in a configuration that names a build to run or a directory to publish. */
function configuredValues(config) {
  return [config.command, config.publish, config.nodeVersion, ...config.plugins].filter((v) => typeof v === 'string');
}

/**
 * Problems with the repository's Netlify configuration.
 *
 * Pure: `files` maps a repository-relative path to its text, `adminDirExists` says whether `apps/admin` is still
 * present, and `strayConfigs` lists any `netlify.toml` outside {@link CONFIG_PATHS}. `scripts/policy/netlify-config.test.mjs`
 * drives it with compliant and non-compliant inputs.
 */
export function netlifyConfigProblems({ files, adminDirExists = false, strayConfigs = [] }) {
  const problems = [];

  for (const { path, authoritative, read_by } of CONFIG_PATHS) {
    const text = files[path];
    if (typeof text !== 'string') {
      problems.push(
        authoritative
          ? `${path} is missing. It is the file ${read_by} reads, so without it Netlify ignores this repository ` +
            'entirely and builds whatever the site settings happen to hold.'
          : `${path} is missing, so ${read_by} would verify a configuration the deployed site does not use.`,
      );
      continue;
    }

    const config = readConfig(text);
    for (const entry of config.unsupported) {
      problems.push(`${path}:${entry.line} cannot be read by this check (${entry.reason}): ${entry.text}`);
    }
    if (config.command !== EXPECTED_BUILD_COMMAND) {
      problems.push(`${path} build command is ${JSON.stringify(config.command)}, expected ${JSON.stringify(EXPECTED_BUILD_COMMAND)}`);
    }
    if (config.publish !== EXPECTED_PUBLISH_DIR) {
      problems.push(`${path} publish directory is ${JSON.stringify(config.publish)}, expected ${JSON.stringify(EXPECTED_PUBLISH_DIR)}`);
    }
    if (config.nodeVersion !== EXPECTED_NODE_VERSION) {
      problems.push(`${path} NODE_VERSION is ${JSON.stringify(config.nodeVersion)}, expected ${JSON.stringify(EXPECTED_NODE_VERSION)}`);
    }
    if (config.plugins.join(',') !== EXPECTED_PLUGINS.join(',')) {
      problems.push(`${path} plugins are ${JSON.stringify(config.plugins)}, expected ${JSON.stringify([...EXPECTED_PLUGINS])}`);
    }

    // The obsolete topology, checked against configured values rather than raw text: the root file quotes the old
    // command in a comment to explain why it exists, and a comment is not configuration.
    for (const value of configuredValues(config)) {
      if (value.includes('@repo/admin')) {
        problems.push(`${path} configures a build of @repo/admin, which 0108 removed: ${JSON.stringify(value)}`);
      }
      if (value.includes('apps/admin')) {
        problems.push(`${path} configures the apps/admin directory, which 0108 removed: ${JSON.stringify(value)}`);
      }
    }
  }

  // The two files must say the same thing, or TOOL-1 verifies one deployment and the site performs another.
  const [root, app] = CONFIG_PATHS.map(({ path }) => (typeof files[path] === 'string' ? readConfig(files[path]) : null));
  if (root !== null && app !== null) {
    for (const field of ['command', 'publish', 'nodeVersion']) {
      if (root[field] !== app[field]) {
        problems.push(
          `netlify.toml and apps/web/netlify.toml disagree about ${field}: ` +
            `${JSON.stringify(root[field])} vs ${JSON.stringify(app[field])}`,
        );
      }
    }
    if (root.plugins.join(',') !== app.plugins.join(',')) {
      problems.push(
        `netlify.toml and apps/web/netlify.toml disagree about plugins: ` +
          `${JSON.stringify(root.plugins)} vs ${JSON.stringify(app.plugins)}`,
      );
    }
  }

  if (adminDirExists) {
    problems.push('apps/admin still exists. 0108 merged the console into apps/web; a second app is a second deployable.');
  }
  for (const path of strayConfigs) {
    problems.push(`${path} is a Netlify configuration in a directory nothing reads, which can only drift from the two that are read.`);
  }
  return problems;
}

/* --------------------------------------------------------------------------------------- the CLI entry point */

/** Every `netlify.toml` in the repository, ignoring build output and dependencies. */
function findNetlifyConfigs(dir = REPO_ROOT, found = []) {
  const SKIP = new Set(['node_modules', '.next', '.netlify', 'dist', '.turbo', '.git', 'test-results', 'playwright-report']);
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) findNetlifyConfigs(full, found);
    else if (entry === 'netlify.toml') found.push(relative(REPO_ROOT, full));
  }
  return found;
}

function main() {
  const known = new Set(CONFIG_PATHS.map(({ path }) => path));
  const discovered = findNetlifyConfigs();
  const files = {};
  for (const { path } of CONFIG_PATHS) {
    const full = join(REPO_ROOT, path);
    if (existsSync(full)) files[path] = readFileSync(full, 'utf8');
  }

  const problems = netlifyConfigProblems({
    files,
    adminDirExists: existsSync(join(REPO_ROOT, 'apps', 'admin')),
    strayConfigs: discovered.filter((path) => !known.has(path)),
  });

  if (problems.length > 0) {
    console.error('check:netlify-config failed:');
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(
    `check:netlify-config passed: ${discovered.length} netlify.toml files, both authoritative paths present and in ` +
      `agreement; build \`${EXPECTED_BUILD_COMMAND}\` publishing ${EXPECTED_PUBLISH_DIR}; no admin deployment configuration.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
