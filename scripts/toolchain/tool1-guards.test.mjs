import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardProblems, parseBuildContext } from './tool1-guards.mjs';

const REPO = '/repo';
const APP = '/repo/apps/web';

/** A log shaped like a correct repository-root build of the web app. */
function goodLog({ publish = '/repo/apps/web/.next', packagePath = 'apps/web', repositoryRoot = '/repo', buildDir = '/repo', command = 'pnpm --filter "@repo/web..." run build' } = {}) {
  return [
    '❯ Flags',
    '  offline: true',
    `  packagePath: ${packagePath}`,
    `  repositoryRoot: ${repositoryRoot}`,
    `  buildDir: ${buildDir}`,
    '❯ Resolved config',
    '  build:',
    `    publish: ${publish}`,
    '​',
    `$ ${command}`,
    '$ next build',
    '❯ Updated config',
    `    publish: ${publish}`,
  ].join('\n');
}

const never = () => false;
const guards = (log, options = {}) => guardProblems({ app: 'web', appDir: APP, repoRoot: REPO, context: parseBuildContext(log), gitPresent: true, exists: never, ...options });

test('a valid monorepo build passes every guard', () => {
  assert.deepEqual(guards(goodLog()), []);
});

test('a valid build passes with git absent, and the repository root is still parsed', () => {
  const context = parseBuildContext(goodLog());
  assert.equal(context.repositoryRoot, '/repo');
  assert.equal(context.packagePath, 'apps/web');
  assert.deepEqual(context.publishDirs, ['/repo/apps/web/.next']);
  assert.deepEqual(guardProblems({ app: 'web', appDir: APP, repoRoot: REPO, context, gitPresent: false, exists: never }), []);
});

test('duplicate publish lines do not cause false failures', () => {
  // Netlify prints the resolved publish directory more than once; the same value twice is one value.
  const log = `${goodLog()}\n    publish: /repo/apps/web/.next`;
  assert.deepEqual(guards(log), []);
});

test('the guards stay parameterised by app rather than hardcoded to the web one', () => {
  // There is one Netlify site since 0108, so `web` is the only app TOOL-1 is invoked for today. The guard function
  // is still written in terms of whichever app it is given, and this holds it to that: hardcoding `web` inside it
  // would pass every assertion in this file except this one.
  const otherLog = goodLog({ publish: '/repo/apps/other/.next', packagePath: 'apps/other', command: 'pnpm --filter "@repo/other..." run build' });
  assert.deepEqual(
    guardProblems({ app: 'other', appDir: '/repo/apps/other', repoRoot: REPO, context: parseBuildContext(otherLog), gitPresent: true, exists: never }),
    [],
  );
});

test('the bundled repository-relative copy inside the function bundle is not flagged', () => {
  // Only <appDir>/apps/web/.netlify counts; paths under functions-internal are legitimate bundle content.
  const exists = (path) => path === '/repo/apps/web/.netlify/functions-internal/___netlify-server-handler/apps/web/.netlify';
  assert.deepEqual(guards(goodLog(), { exists }), []);
});

test('guard 1 rejects a publish directory outside the app', () => {
  assert.match(guards(goodLog({ publish: '/repo/.next' })).join(), /resolved publish directory \/repo\/\.next is not \/repo\/apps\/web\/\.next/);
  assert.match(guards(goodLog({ packagePath: 'apps/api' })).join(), /packagePath is apps\/api/);
  assert.match(guards(goodLog({ buildDir: '/repo/apps/web' })).join(), /buildDir is \/repo\/apps\/web/);
  assert.match(guards('no resolved config here').join(), /records no resolved publish directory/);
});

test('guard 2 rejects the doubled output path', () => {
  const exists = (path) => path === '/repo/apps/web/apps/web/.netlify';
  assert.match(guards(goodLog(), { exists }).join(), /doubled path \/repo\/apps\/web\/apps\/web\/\.netlify/);
});

test('guard 3 rejects a repository root that is not the repository root when git is present', () => {
  assert.match(guards(goodLog({ repositoryRoot: '/repo/apps/web' })).join(), /repositoryRoot is \/repo\/apps\/web/);
  // Without git the assertion does not apply, so a sandbox cannot fail for that reason alone.
  assert.deepEqual(guardProblems({ app: 'web', appDir: APP, repoRoot: REPO, context: parseBuildContext(goodLog({ repositoryRoot: '/repo/apps/web' })), gitPresent: false, exists: never }), []);
});

test('guard 4 rejects the root workspace build and a missing package-scoped build', () => {
  assert.match(guards(goodLog({ command: 'pnpm run build' })).join(), /root workspace command/);
  assert.match(
    guards(goodLog({ command: 'pnpm run build' })).join(),
    /does not show `pnpm --filter "@repo\/web\.\.\." run build`/,
  );
  const withTurbo = `${goodLog()}\n$ turbo run build`;
  assert.match(guards(withTurbo).join(), /root workspace command `turbo run build`/);
});

test('guard 4 rejects the dependency-less filter, which cannot build a clean checkout', () => {
  // The defect this guard was blind to until the first deployment inspection. Every workspace package exports
  // only `dist/`, `dist/` is gitignored and nothing has a `postinstall`, so `--filter @repo/web` builds no
  // dependency and `next build` dies loading `next.config.ts`:
  //
  //   Error: Cannot find module '.../apps/web/node_modules/@repo/config/dist/index.js'
  //
  // Verified by moving every packages/*/dist aside and running the command. CI never saw it because it builds
  // the graph itself first, so TOOL-1 always inherited a tree where every dist/ existed.
  const problems = guards(goodLog({ command: 'pnpm --filter @repo/web run build' }));
  assert.match(problems.join(), /builds no workspace dependency/);
  assert.match(problems.join(), /Use the `\.\.\.` form/);
  // And it is reported as the wrong command as well as a missing right one, so neither message stands alone.
  assert.match(problems.join(), /does not show `pnpm --filter "@repo\/web\.\.\." run build`/);

  // The quoted and unquoted dependency-inclusive forms are both accepted: how a builder echoes a shell-glob
  // argument is its business, not this repository's.
  assert.deepEqual(guards(goodLog({ command: 'pnpm --filter "@repo/web..." run build' })), []);
  assert.deepEqual(guards(goodLog({ command: 'pnpm --filter @repo/web... run build' })), []);
  assert.deepEqual(guards(goodLog({ command: "pnpm --filter '@repo/web...' run build" })), []);

  // A different package's dependency-inclusive build is not this app's.
  assert.match(
    guards(goodLog({ command: 'pnpm --filter "@repo/api..." run build' })).join(),
    /does not show `pnpm --filter "@repo\/web\.\.\." run build`/,
  );
});
