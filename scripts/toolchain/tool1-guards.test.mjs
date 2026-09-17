import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardProblems, parseBuildContext } from './tool1-guards.mjs';

const REPO = '/repo';
const APP = '/repo/apps/web';

/** A log shaped like a correct repository-root build of the web app. */
function goodLog({ publish = '/repo/apps/web/.next', packagePath = 'apps/web', repositoryRoot = '/repo', buildDir = '/repo', command = 'pnpm --filter @repo/web run build' } = {}) {
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

test('duplicate publish lines and admin builds do not cause false failures', () => {
  const log = `${goodLog()}\n    publish: /repo/apps/web/.next`;
  assert.deepEqual(guards(log), []);
  const adminLog = goodLog({ publish: '/repo/apps/admin/.next', packagePath: 'apps/admin', command: 'pnpm --filter @repo/admin run build' });
  assert.deepEqual(guardProblems({ app: 'admin', appDir: '/repo/apps/admin', repoRoot: REPO, context: parseBuildContext(adminLog), gitPresent: true, exists: never }), []);
});

test('the bundled repository-relative copy inside the function bundle is not flagged', () => {
  // Only <appDir>/apps/web/.netlify counts; paths under functions-internal are legitimate bundle content.
  const exists = (path) => path === '/repo/apps/web/.netlify/functions-internal/___netlify-server-handler/apps/web/.netlify';
  assert.deepEqual(guards(goodLog(), { exists }), []);
});

test('guard 1 rejects a publish directory outside the app', () => {
  assert.match(guards(goodLog({ publish: '/repo/.next' })).join(), /resolved publish directory \/repo\/\.next is not \/repo\/apps\/web\/\.next/);
  assert.match(guards(goodLog({ packagePath: 'apps/admin' })).join(), /packagePath is apps\/admin/);
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
  assert.match(guards(goodLog({ command: 'pnpm run build' })).join(), /does not show `pnpm --filter @repo\/web run build`/);
  const withTurbo = `${goodLog()}\n$ turbo run build`;
  assert.match(guards(withTurbo).join(), /root workspace command `turbo run build`/);
});
