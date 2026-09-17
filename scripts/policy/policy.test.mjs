import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { allowlistProblems, exclusionFor, findCurrencyLiterals, scanRepository } from './currency-literals.mjs';
import { installScriptProblems } from './install-scripts.mjs';
import { changedFiles, overrideProblems, snapshot, workspaceProblems } from './integrity.mjs';
import { PolicyError, REPO_ROOT, exceptionProblems, lockfilePackages, workspaceSettings } from './lib.mjs';
import { evaluateAges, exceptionRegisterProblems } from './package-age.mjs';
import { dependabotProblems, playwrightProblems, repositoryProblems, workflowProblems } from './workflow-policy.mjs';

const read = (p) => readFileSync(join(REPO_ROOT, p), 'utf8');

test('lockfile: only the project document is read (pnpm itself is governed separately)', () => {
  const text = "---\nlockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    configDependencies: {}\n    packageManagerDependencies:\n      pnpm:\n        specifier: 12.4.2\n\npackages:\n\n  pnpm@12.4.2:\n    resolution: {}\n\n---\nlockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    devDependencies: {}\n\npackages:\n\n  '@scope/a@1.2.3':\n    resolution: {}\n\n  b@0.1.0-rc.1:\n    resolution: {}\n\nsnapshots:\n\n  b@0.1.0-rc.1: {}\n";
  assert.deepEqual(lockfilePackages(text), [{ name: '@scope/a', version: '1.2.3' }, { name: 'b', version: '0.1.0-rc.1' }]);
  const real = lockfilePackages(read('pnpm-lock.yaml'));
  assert.ok(real.length > 1000);
  assert.ok(!real.some((p) => p.name === 'pnpm'));
});

test('workspace settings are parsed strictly', () => {
  const ws = workspaceSettings(read('pnpm-workspace.yaml'));
  assert.equal(ws.scalars.minimumReleaseAge, '20160');
  assert.equal(ws.allowBuilds.esbuild, false);
  assert.deepEqual(workspaceSettings('overrides:\n  foo: 1.0.0\n').overrides, { foo: '1.0.0' });
  assert.throws(() => workspaceSettings('unknownSection:\n  foo: 1.0.0\n'), /unsupported/);
});

test('exception entries need every field and an unexpired date', () => {
  const fields = ['package', 'version', 'approvedBy', 'approvedOn', 'expires'];
  const ok = { package: 'a', version: '1.0.0', approvedBy: 'owner', approvedOn: '2026-09-01', expires: '2026-10-01' };
  assert.deepEqual(exceptionProblems(ok, fields, '2026-09-17'), []);
  assert.match(exceptionProblems({ ...ok, expires: '2026-09-01' }, fields, '2026-09-17').join(), /expired/);
  assert.match(exceptionProblems({ ...ok, approvedBy: '' }, fields, '2026-09-17').join(), /missing approvedBy/);
  assert.match(exceptionProblems({ ...ok, approvedOn: 'soon' }, fields, '2026-09-17').join(), /approvedOn/);
});

test('release-age exceptions must match pnpm-workspace.yaml exactly', () => {
  const entry = { package: 'a', version: '1.0.1', advisory: 'GHSA-x', reason: 'critical fix', approvedBy: 'owner', approvedOn: '2026-09-16', expires: '2026-09-30' };
  const ws = (list) => ({ minimumReleaseAgeExclude: list });
  assert.deepEqual(exceptionRegisterProblems({ exceptions: [entry] }, ws(['a@1.0.1']), '2026-09-17').problems, []);
  assert.match(exceptionRegisterProblems({ exceptions: [entry] }, ws([]), '2026-09-17').problems.join(), /not listed/);
  assert.match(exceptionRegisterProblems({ exceptions: [] }, ws(['a@1.0.1']), '2026-09-17').problems.join(), /no approved exception/);
  assert.match(exceptionRegisterProblems({ exceptions: [entry] }, ws(['a@1.0.1']), '2026-10-02').problems.join(), /expired/);
  const committed = JSON.parse(read('policy/release-age-exceptions.json'));
  assert.deepEqual(committed.exceptions, []);
});

test('package ages: too new fails unless approved; undated fails', () => {
  const now = new Date('2026-09-17T00:00:00Z');
  const times = new Map([['a', { '1.0.0': '2026-08-01T00:00:00Z', '1.0.1': '2026-09-10T00:00:00Z' }], ['b', {}]]);
  const packages = [{ name: 'a', version: '1.0.0' }, { name: 'a', version: '1.0.1' }, { name: 'b', version: '2.0.0' }];
  const none = evaluateAges(packages, times, now, new Set());
  assert.deepEqual(none.tooNew.map((p) => p.split(' ')[0]), ['a@1.0.1']);
  assert.deepEqual(none.undated, ['b@2.0.0']);
  assert.deepEqual(evaluateAges(packages, times, now, new Set(['a@1.0.1'])).excepted, ['a@1.0.1']);
  assert.deepEqual(evaluateAges([{ name: 'a', version: '1.0.1' }], times, new Date('2026-09-24T00:00:01Z'), new Set()).tooNew, []);
});

test('install scripts must be listed and blocked, and nothing else listed', () => {
  const found = new Map([['esbuild', ['postinstall']], ['newpkg', ['install']]]);
  const problems = installScriptProblems(found, { esbuild: false, stale: false, allowed: true });
  assert.match(problems.join(), /newpkg has install scripts/);
  assert.match(problems.join(), /stale, which has no install scripts/);
  assert.match(problems.join(), /allowBuilds.allowed must be false/);
  assert.deepEqual(installScriptProblems(new Map([['esbuild', ['postinstall']]]), { esbuild: false }), []);
});

function copyRepoSubset(files) {
  const root = mkdtempSync(join(tmpdir(), 'policy-'));
  for (const f of files) {
    mkdirSync(join(root, f, '..'), { recursive: true });
    cpSync(join(REPO_ROOT, f), join(root, f));
  }
  return root;
}

test('workspace integrity passes for the repository and catches drift', () => {
  assert.deepEqual(workspaceProblems(), []);
  const root = copyRepoSubset(['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', '.nvmrc', 'policy/dependency-overrides.json', 'apps/web/package.json', 'packages/ui/package.json']);
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'apps/web/package.json'), 'utf8'));
    manifest.dependencies.next = '^16.3.4';
    writeFileSync(join(root, 'apps/web/package.json'), JSON.stringify(manifest));
    writeFileSync(join(root, '.nvmrc'), '24.20.0\n');
    const problems = workspaceProblems(root).join('\n');
    assert.match(problems, /next must be an exact version/);
    assert.match(problems, /\.nvmrc must be 24\.21\.0/);
    const before = snapshot(root);
    writeFileSync(join(root, 'pnpm-workspace.yaml'), `${readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')}\n`);
    assert.deepEqual(changedFiles(before, snapshot(root)), ['pnpm-workspace.yaml']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const codes = new Set(['EGP', 'USD', 'ALL']);

test('currency literals: syntax-tree tokens only, exact uppercase codes', () => {
  const ts = [
    "const a = 'EGP';",
    'const b = `amount ${x} USD`;',
    'const EGP = 1;',
    '// USD in a comment is ignored',
    "const c = 'egp'; const d = 'EGPX'; const e = 'X_EGP';",
    'const f = <p>Total ALL</p>;',
  ].join('\n');
  const found = findCurrencyLiterals('src/x.tsx', ts, codes).map((f) => `${f.line}:${f.token}`);
  assert.deepEqual(found, ['1:EGP', '2:USD', '3:EGP', '6:ALL']);
  assert.deepEqual(findCurrencyLiterals('config/x.json', '{"currency": "EGP", "note": "CVE-2026-1 and EGPish"}', codes).map((f) => f.token), ['EGP']);
});

test('currency literals: approved exclusions only', () => {
  assert.equal(exclusionFor('supabase/migrations/0001_init.sql'), 'migrations');
  assert.equal(exclusionFor('supabase/seed.sql'), 'seeds');
  assert.equal(exclusionFor('packages/money/test/money.test.ts'), 'tests');
  assert.equal(exclusionFor('packages/e2e/tests/smoke.spec.ts'), 'tests');
  assert.equal(exclusionFor('supabase/tests/tool7_tooling.test.sql'), 'tests');
  assert.equal(exclusionFor('README.md'), 'Markdown and specification files');
  assert.equal(exclusionFor('packages/money/src/index.ts'), undefined);
  assert.equal(exclusionFor('pnpm-lock.yaml'), undefined);
});

test('currency literals: the repository passes and a planted literal fails (negative control)', () => {
  assert.deepEqual(scanRepository().problems, []);
  const root = copyRepoSubset(['policy/iso4217-currencies.json', 'policy/currency-literal-allowlist.json', 'policy/osv-exceptions.json', 'packages/money/src/index.ts']);
  try {
    writeFileSync(join(root, 'packages/money/src/default.ts'), "export const DEFAULT_CURRENCY = 'EGP';\n");
    const result = scanRepository(root);
    assert.deepEqual(result.problems, ['packages/money/src/default.ts:1: currency literal EGP (syntax tree)']);
    assert.match(allowlistProblems({ entries: [{ path: 'missing.ts', reason: 'x' }, { path: 'packages/money/src/index.ts' }] }, ['packages/money/src/index.ts']).join(), /missing file.*|needs path and reason/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('workflow policy: the committed workflows pass', () => {
  assert.deepEqual(repositoryProblems().problems, []);
});

test('workflow policy: negative controls', () => {
  const approved = JSON.parse(read('toolchain/github-actions.json')).actions;
  const ci = read('.github/workflows/ci.yml');
  const check = (text) => workflowProblems('ci.yml', text, approved, '24.21.0').join('\n');
  assert.equal(check(ci), '');
  assert.match(check(ci.replace(/actions\/checkout@[0-9a-f]{40}/, 'actions/checkout@v7')), /full commit SHA/);
  assert.match(check(ci.replace(/actions\/checkout@3d3c/, 'actions/checkout@0d3c')), /must be actions\/checkout@/);
  assert.match(check(ci.replace('permissions: {}', 'permissions: read-all')), /top-level permissions/);
  assert.match(check(ci.replace('contents: read', 'contents: write')), /write permissions/);
  assert.match(check(ci.replace('  pull_request:', '  pull_request_target:')), /pull_request_target/);
  assert.match(check(ci.replace('runs-on: ubuntu-24.04', 'runs-on: ubuntu-latest')), /ubuntu-latest/);
  assert.match(check(ci.replace(/timeout-minutes: 20\n/, '')), /needs timeout-minutes/);
  assert.match(check(ci.replace('persist-credentials: false', 'persist-credentials: true')), /persist-credentials/);
  assert.match(check(ci.replace("if: github.event_name == 'push' && github.ref == 'refs/heads/main'", 'if: always()')), /main-branch pushes/);
  assert.match(check(ci.replace('test "$(node --version)" = "v24.21.0"', 'true')), /verify node --version/);
  assert.match(check(ci.replace('node-version: 24.21.0', 'node-version: 24.20.0')), /start with setup-node 24\.21\.0/);
  assert.match(check(ci.replace('retention-days: 14', 'retention-days: 90')), /14 days/);
  assert.match(check(ci.replace('run: pnpm run lint', 'run: echo ${{ secrets.TOKEN }}')), /secrets/);
  assert.match(check(ci.replace('uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0', 'uses: some/other-action@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0')), /not an approved action/);
  assert.match(check(`${ci}\n      - run: corepack enable\n`), /pnpm\/action-setup/);
});

test('dependabot and playwright policy: negative controls', () => {
  const dependabot = read('.github/dependabot.yml');
  assert.deepEqual(dependabotProblems(dependabot), []);
  assert.match(dependabot, /^    cooldown:\n      default-days: 14$/m);
  // Comments and blank lines do not matter; the effective configuration does.
  assert.deepEqual(dependabotProblems(`# note\n\n${dependabot}\n# trailing note\n`), []);
  assert.match(dependabotProblems(`${dependabot}\n  - package-ecosystem: npm\n    directory: /\n`).join(), /ecosystem npm/);
  const withoutCooldown = dependabot.replace('    cooldown:\n      default-days: 14\n', '');
  assert.match(dependabotProblems(withoutCooldown).join(), /exactly `cooldown: default-days: 14`/);
  assert.match(dependabotProblems(dependabot.replace('default-days: 14', 'default-days: 7')).join(), /exactly `cooldown: default-days: 14`/);
  assert.match(dependabotProblems(dependabot.replace('default-days: 14', 'default-days: "14"')).join(), /exactly `cooldown: default-days: 14`/);
  assert.match(dependabotProblems(dependabot.replace('      default-days: 14\n', '      default-days: 14\n      semver-major-days: 30\n')).join(), /semver cooldown keys/);
  assert.match(dependabotProblems(dependabot.replace('    cooldown:\n', '    schedule-cooldown:\n')).join(), /differs from the approved configuration/);
  assert.match(dependabotProblems(dependabot.replace('interval: weekly', 'interval: daily')).join(), /differs from the approved configuration at effective line 6/);
  assert.match(dependabotProblems(dependabot.replace('open-pull-requests-limit: 5', 'open-pull-requests-limit: 20')).join(), /differs/);
  assert.match(dependabotProblems(`${dependabot}    allow:\n      - dependency-name: "*"\n`).join(), /differs/);
  assert.match(dependabotProblems(dependabot.replace('    groups:\n      github-actions:\n        patterns:\n          - "*"\n', '')).join(), /must be grouped/);
  assert.match(dependabotProblems(`${dependabot}# auto-merge is described in a comment only\n`).join() || 'ok', /ok/);
  assert.match(dependabotProblems(`${dependabot}    automerge: true\n`).join(), /auto-merge is not allowed/);
  const pw = read('packages/e2e/playwright.config.ts');
  assert.deepEqual(playwrightProblems(pw), []);
  assert.match(playwrightProblems(pw.replace('retries: 0', 'retries: 2')).join(), /retries/);
  assert.match(playwrightProblems(pw.replace("trace: 'off'", "trace: 'on'")).join(), /traces/);
  assert.match(playwrightProblems(pw.replace("devices['Desktop Chrome'] } }]", "devices['Desktop Chrome'] } }, { name: 'firefox', use: { ...devices['Desktop Firefox'] } }]")).join(), /only project/);
});

// --- security overrides (Phase 1 Step 9) -------------------------------------------------------
const WORKSPACE = readFileSync(new URL('../../pnpm-workspace.yaml', import.meta.url), 'utf8');

test('the committed workspace file parses deterministically, overrides included', () => {
  const first = workspaceSettings(WORKSPACE);
  const second = workspaceSettings(WORKSPACE);
  assert.deepEqual(first, second);
  assert.deepEqual(first.overrides, { 'js-yaml': '4.3.2', sharp: '0.35.4', toml: '4.3.0' });
  // Existing behaviour is unchanged by the new section.
  assert.deepEqual(first.packages, ['apps/*', 'packages/*']);
  assert.equal(first.scalars.minimumReleaseAge, '20160');
  assert.equal(Object.values(first.allowBuilds).every((value) => value === false), true);
});

test('comments and quoting inside overrides are parsed, malformed lines are rejected', () => {
  const base = 'overrides:\n  js-yaml: 4.3.2\n';
  assert.deepEqual(workspaceSettings(`# a comment\n${base}  "@scope/pkg": "1.2.3" # why\n`).overrides, { 'js-yaml': '4.3.2', '@scope/pkg': '1.2.3' });
  assert.throws(() => workspaceSettings(`${base}  broken line\n`), PolicyError);
  assert.throws(() => workspaceSettings(`${base}  js-yaml: 4.3.3\n`), /duplicate override/);
});

test('overrides must pin exact versions', () => {
  for (const spec of ['^4.3.2', '~4.3.2', '>=4.3.2', '4.3.x', 'latest', '4.3']) {
    assert.match(overrideProblems({ 'js-yaml': spec }).join(), /must be an exact version/);
  }
  assert.deepEqual(overrideProblems({ 'js-yaml': '4.3.2', sharp: '0.35.4', toml: '4.3.0' }), []);
});

test('every override must be documented, and the register may not drift', () => {
  assert.match(overrideProblems({ 'js-yaml': '4.3.2', sharp: '0.35.4', toml: '4.3.0', lodash: '4.17.21' }).join(), /lodash is not documented/);
  assert.match(overrideProblems({ 'js-yaml': '4.3.3', sharp: '0.35.4', toml: '4.3.0' }).join(), /records js-yaml@4.3.2/);
  assert.match(overrideProblems({ 'js-yaml': '4.3.2', sharp: '0.35.4' }).join(), /documents toml, which pnpm-workspace.yaml does not override/);
});

