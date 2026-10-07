// The Netlify deployment-configuration policy, driven against compliant and non-compliant inputs.
//
// Every detector written for this repository has been wrong at least once, and each time the cause was the same:
// it was checked against the real tree, which happened to be compliant, and never against the broken input it
// claimed to catch. So the cases below include the exact defect the check was written for — a repository whose
// root configuration is missing, which is what let a Netlify site keep building `@repo/admin` after 0108 — and
// the false positive it must not raise, which is the root file's own comment quoting that obsolete command.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CONFIG_PATHS,
  EXPECTED_BUILD_COMMAND,
  EXPECTED_NODE_VERSION,
  EXPECTED_PUBLISH_DIR,
  netlifyConfigProblems,
  parseTomlSubset,
  readConfig,
  REPO_ROOT,
} from './netlify-config.mjs';

/** A compliant file, written the way the repository writes it: escaped quotes inside the command. */
const GOOD = `# A comment.
[build]
  command = "pnpm --filter \\"@repo/web...\\" run build"
  publish = "apps/web/.next"

[build.environment]
  NODE_VERSION = "24.21.0"

[[plugins]]
  package = "@netlify/plugin-nextjs"
`;

const bothGood = () => ({ 'netlify.toml': GOOD, 'apps/web/netlify.toml': GOOD });

test('the committed configuration passes', () => {
  const files = {};
  for (const { path } of CONFIG_PATHS) files[path] = readFileSync(join(REPO_ROOT, path), 'utf8');
  assert.deepEqual(netlifyConfigProblems({ files }), []);
});

test('the parser keeps a quote and a hash that are inside a string', () => {
  // The command contains escaped quotes. A line-wise comment strip or a naive quote split corrupts it, and the
  // check would then report a mismatch on a file that is perfectly correct.
  const config = readConfig(GOOD);
  assert.equal(config.command, EXPECTED_BUILD_COMMAND);
  assert.equal(config.publish, EXPECTED_PUBLISH_DIR);
  assert.equal(config.nodeVersion, EXPECTED_NODE_VERSION);
  assert.deepEqual(config.plugins, ['@netlify/plugin-nextjs']);

  const hashInside = readConfig('[build]\n  command = "echo \\"a # b\\""\n');
  assert.equal(hashInside.command, 'echo "a # b"');

  // And a comment really is removed.
  const commented = readConfig('[build]\n  command = "x" # publish = "wrong"\n');
  assert.equal(commented.command, 'x');
  assert.equal(commented.publish, undefined);
});

test('a comment naming the obsolete admin build is not a configuration of it', () => {
  // The false positive that would have made this check unusable: the root file explains the defect by quoting
  // `pnpm --filter @repo/admin run build` and `apps/admin/.next` in its header.
  const withExplanation = `# A deploy kept running pnpm --filter @repo/admin run build and publishing apps/admin/.next.\n${GOOD}`;
  assert.deepEqual(
    netlifyConfigProblems({ files: { 'netlify.toml': withExplanation, 'apps/web/netlify.toml': GOOD } }),
    [],
  );
  // The committed root file is that case, so the first test above already proves it on the real tree too.
  assert.match(readFileSync(join(REPO_ROOT, 'netlify.toml'), 'utf8'), /@repo\/admin/);
});

test('a missing root configuration fails, and says why it matters', () => {
  // THE defect. Netlify reads `netlify.toml` from the base directory, which for this site is the repository
  // root; with no file there it used the build settings stored on the site, which still named the admin app.
  const problems = netlifyConfigProblems({ files: { 'apps/web/netlify.toml': GOOD } });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^netlify\.toml is missing/);
  assert.match(problems[0], /ignores this repository entirely/);
});

test('a missing app-scoped copy fails too, because TOOL-1 would verify the wrong file', () => {
  const problems = netlifyConfigProblems({ files: { 'netlify.toml': GOOD } });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /apps\/web\/netlify\.toml is missing/);
  assert.match(problems[0], /TOOL-1/);
});

test('an actual admin build command or publish directory fails', () => {
  const adminBuild = GOOD.replace(EXPECTED_BUILD_COMMAND.replace(/"/g, '\\"'), 'pnpm --filter @repo/admin run build');
  const adminProblems = netlifyConfigProblems({ files: { 'netlify.toml': adminBuild, 'apps/web/netlify.toml': GOOD } });
  assert.match(adminProblems.join('\n'), /configures a build of @repo\/admin, which 0108 removed/);

  const adminPublish = GOOD.replace('apps/web/.next', 'apps/admin/.next');
  const publishProblems = netlifyConfigProblems({ files: { 'netlify.toml': adminPublish, 'apps/web/netlify.toml': GOOD } });
  assert.match(publishProblems.join('\n'), /configures the apps\/admin directory, which 0108 removed/);
});

test('the dependency-less filter fails, because it cannot build a clean checkout', () => {
  // The 0107 defect, kept reachable from here as well as from the build log: `--filter @repo/web` without `...`
  // builds no workspace dependency, so `next.config.ts` cannot load `@repo/config`.
  const dependencyLess = GOOD.replace('pnpm --filter \\"@repo/web...\\" run build', 'pnpm --filter @repo/web run build');
  const problems = netlifyConfigProblems({ files: { 'netlify.toml': dependencyLess, 'apps/web/netlify.toml': GOOD } });
  assert.match(problems.join('\n'), /build command is "pnpm --filter @repo\/web run build", expected/);
});

test('the two files are not allowed to drift apart', () => {
  const drifted = GOOD.replace('apps/web/.next', 'apps/web/.next/');
  const problems = netlifyConfigProblems({ files: { 'netlify.toml': GOOD, 'apps/web/netlify.toml': drifted } });
  assert.match(problems.join('\n'), /disagree about publish/);

  const nodeDrift = GOOD.replace('24.21.0', '22.0.0');
  assert.match(
    netlifyConfigProblems({ files: { 'netlify.toml': GOOD, 'apps/web/netlify.toml': nodeDrift } }).join('\n'),
    /disagree about nodeVersion/,
  );

  const pluginDrift = GOOD.replace('@netlify/plugin-nextjs', '@netlify/plugin-something-else');
  assert.match(
    netlifyConfigProblems({ files: { 'netlify.toml': GOOD, 'apps/web/netlify.toml': pluginDrift } }).join('\n'),
    /disagree about plugins/,
  );
});

test('a missing plugin or a missing Node pin fails', () => {
  const noPlugin = GOOD.split('[[plugins]]')[0];
  assert.match(
    netlifyConfigProblems({ files: { 'netlify.toml': noPlugin, 'apps/web/netlify.toml': noPlugin } }).join('\n'),
    /plugins are \[\], expected \["@netlify\/plugin-nextjs"\]/,
  );
  const noNode = GOOD.replace('  NODE_VERSION = "24.21.0"\n', '');
  assert.match(
    netlifyConfigProblems({ files: { 'netlify.toml': noNode, 'apps/web/netlify.toml': noNode } }).join('\n'),
    /NODE_VERSION is undefined/,
  );
});

test('a surviving admin app or a stray configuration fails', () => {
  assert.match(
    netlifyConfigProblems({ files: bothGood(), adminDirExists: true }).join('\n'),
    /apps\/admin still exists/,
  );
  assert.match(
    netlifyConfigProblems({ files: bothGood(), strayConfigs: ['apps/api/netlify.toml'] }).join('\n'),
    /apps\/api\/netlify\.toml is a Netlify configuration in a directory nothing reads/,
  );
});

test('a value this parser cannot read is reported, never silently ignored', () => {
  // A file that grows past the slice must fail the check rather than be misread by it.
  const unreadable = `${GOOD}\n[build]\n  ignore = ["a", "b"]\n`;
  const problems = netlifyConfigProblems({ files: { 'netlify.toml': unreadable, 'apps/web/netlify.toml': GOOD } });
  assert.match(problems.join('\n'), /cannot be read by this check \(value is not a basic quoted string\)/);

  // And the parser says so itself, with a line number.
  const parsed = parseTomlSubset('[build]\n  ignore = ["a"]\n');
  assert.equal(parsed.unsupported.length, 1);
  assert.equal(parsed.unsupported[0].line, 2);
});
