import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ENV_INVENTORY, variablesFor } from '../../packages/server-config/dist/index.js';
import {
  DOC_END,
  DOC_START,
  envBoundaryViolations,
  envExampleProblems,
  findEnvAccess,
  forbiddenEnvFiles,
  inventoryTable,
  scanClientBundles,
  withGeneratedDocs,
} from './env-tooling.mjs';

const kinds = (code, file = 'apps/api/src/x.ts') => findEnvAccess(file, code).map((u) => `${u.kind}${u.name ? ` ${u.name}` : ''}`);

test('R7: finds direct, indirect and aliased environment access', () => {
  assert.deepEqual(kinds('const a = process.env.API_HOST;'), ['read API_HOST']);
  assert.deepEqual(kinds("const a = process.env['API_PORT'];"), ['read API_PORT']);
  assert.deepEqual(kinds('const k = "X"; const a = process.env[k];'), ['dynamic-env-access']);
  assert.deepEqual(kinds('const { API_HOST } = process.env;'), ['whole-env']);
  assert.deepEqual(kinds('load(process.env);'), ['whole-env']);
  assert.deepEqual(kinds('const all = { ...process.env };'), ['whole-env']);
  assert.deepEqual(kinds("const e = process['env']; e.X;"), ['whole-env']);
  assert.deepEqual(kinds('const p = process; p.env.X;'), ['process-alias']);
  assert.deepEqual(kinds('const { env } = process;'), ['process-alias']);
  assert.deepEqual(kinds('globalThis.process.env.SECRET;'), ['read SECRET']);
  assert.deepEqual(kinds("globalThis['process'].env.SECRET;"), ['read SECRET']);
  assert.deepEqual(kinds('const k = "env"; process[k].X;'), ['dynamic-process-access']);
  assert.deepEqual(kinds("import { env } from 'node:process';"), ['process-module-import']);
  assert.deepEqual(kinds("import proc from 'process';"), ['process-module-import']);
  assert.deepEqual(kinds("const p = require('node:process');", 'scripts/x.cjs'), ['process-module-import']);
  assert.deepEqual(kinds("const p = await import('node:process');"), ['process-module-import']);
  assert.deepEqual(kinds("export { env } from 'node:process';"), ['process-module-import']);
  assert.deepEqual(kinds('const m = import.meta.env.MODE;'), ['import-meta-env']);
  assert.deepEqual(kinds('process.env.X = "1";'), ['write X']);
  assert.deepEqual(kinds('delete process.env.X;'), ['write X']);
});

test('R7: ordinary process members and unrelated names are not reported', () => {
  assert.deepEqual(kinds('process.exit(1); process.on("SIGTERM", f); const a = process.argv; process.stdout.write("x");'), []);
  assert.deepEqual(kinds('const o = { process: 1 }; o.process; class C { process() {} } const env = 1; const x = obj.env;'), []);
  assert.deepEqual(kinds('// process.env.X in a comment\nconst s = "process.env.Y";'), []);
  assert.deepEqual(kinds('interface Q { process(job: unknown): Promise<void>; readonly process2: number } type T = { process: () => void }; class K { get process() { return 1; } }'), []);
  assert.deepEqual(kinds('const { process: handler } = definition; definition.process(job);'), []);
  assert.deepEqual(kinds('const { process } = definition; process.env.X;'), ['read X']);
  assert.deepEqual(kinds('const o = { process }; send({ process });'), ['process-alias', 'process-alias']);
});

test('R7: allowances are exact', () => {
  assert.deepEqual(envBoundaryViolations('apps/api/src/config/env.ts', 'f(process.env);'), []);
  assert.deepEqual(envBoundaryViolations('apps/api/src/main.ts', 'f(process.env);'), ['apps/api/src/main.ts:1: whole-env']);
  assert.deepEqual(envBoundaryViolations('apps/web/src/instrumentation.ts', 'if (process.env.NEXT_RUNTIME) {}'), []);
  assert.deepEqual(envBoundaryViolations('apps/web/src/instrumentation.ts', 'process.env.API_BASE_URL;'), ['apps/web/src/instrumentation.ts:1: read API_BASE_URL']);
  assert.deepEqual(envBoundaryViolations('apps/web/src/instrumentation.ts', 'process.env.NEXT_RUNTIME = "x";'), ['apps/web/src/instrumentation.ts:1: write NEXT_RUNTIME']);
  assert.deepEqual(envBoundaryViolations('apps/worker/src/runtime/pure-js-msgpack.ts', "process.env.MSGPACKR_NATIVE_ACCELERATION_DISABLED = 'true';"), []);
  assert.deepEqual(envBoundaryViolations('apps/worker/src/runtime/pure-js-msgpack.ts', 'process.env.MSGPACKR_NATIVE_ACCELERATION_DISABLED;'), ['apps/worker/src/runtime/pure-js-msgpack.ts:1: read MSGPACKR_NATIVE_ACCELERATION_DISABLED']);
  assert.deepEqual(envBoundaryViolations('apps/web/src/server/bff/env.ts', 'process.env.API_BASE_URL;'), ['apps/web/src/server/bff/env.ts:1: read API_BASE_URL']);
  assert.deepEqual(envBoundaryViolations('packages/db/src/database.ts', 'process.env.X;'), ['packages/db/src/database.ts:1: read X']);
  assert.deepEqual(envBoundaryViolations('scripts/anything.mjs', 'process.env.X;'), []);
  assert.deepEqual(envBoundaryViolations('apps/web/test/a.test.ts', 'process.env.X;'), []);
  assert.deepEqual(envBoundaryViolations('packages/contracts/scripts/check-generated.mjs', 'f({ ...process.env });'), []);
  assert.deepEqual(envBoundaryViolations('packages/contracts/orval.config.mjs', 'const t = process.env.ORVAL_OUTPUT;'), []);
  assert.deepEqual(envBoundaryViolations('packages/contracts/orval.config.mjs', 'const t = process.env.OTHER;'), ['packages/contracts/orval.config.mjs:1: read OTHER']);
  assert.deepEqual(envBoundaryViolations('packages/contracts/src/index.ts', 'process.env.ORVAL_OUTPUT;'), ['packages/contracts/src/index.ts:1: read ORVAL_OUTPUT']);
});

test('R8: .env.example files may contain names only, matching the inventory', () => {
  assert.deepEqual(envExampleProblems('apps/web', '# comment\nAPI_BASE_URL=\n', ['API_BASE_URL']), []);
  assert.match(envExampleProblems('apps/web', 'API_BASE_URL=http://x\n', ['API_BASE_URL']).join(), /without values/);
  assert.match(envExampleProblems('apps/web', 'API_BASE_URL= \n', ['API_BASE_URL']).join(), /without values/);
  assert.match(envExampleProblems('apps/web', '  API_BASE_URL=\n', ['API_BASE_URL']).join(), /without values/);
  assert.match(envExampleProblems('apps/web', 'export API_BASE_URL=\n', ['API_BASE_URL']).join(), /without values/);
  assert.match(envExampleProblems('apps/web', 'OTHER=\n', ['API_BASE_URL']).join(), /names differ/);
  assert.match(envExampleProblems('apps/web', '', ['API_BASE_URL']).join(), /names differ/);
});

test('R8: real environment files are detected anywhere in the tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'envfiles-'));
  try {
    mkdirSync(join(root, 'apps/web'), { recursive: true });
    mkdirSync(join(root, 'node_modules/x'), { recursive: true });
    writeFileSync(join(root, 'apps/web/.env.example'), 'API_BASE_URL=\n');
    writeFileSync(join(root, 'apps/web/.env.local'), 'X=1\n');
    writeFileSync(join(root, '.env'), 'X=1\n');
    writeFileSync(join(root, 'node_modules/x/.env'), 'ignored');
    assert.deepEqual(forbiddenEnvFiles(root), ['.env', 'apps/web/.env.local']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R3: the inventory table is deterministic and contains no secret values', () => {
  const table = inventoryTable(ENV_INVENTORY);
  assert.equal(table, inventoryTable(ENV_INVENTORY));
  assert.equal(table.split('\n').length, ENV_INVENTORY.length + 2);
  for (const entry of ENV_INVENTORY.filter((e) => e.secret)) assert.equal(entry.default, null);
  const readme = `before\n${DOC_START}\nold\n${DOC_END}\nafter\n`;
  const updated = withGeneratedDocs(readme, ENV_INVENTORY);
  assert.equal(withGeneratedDocs(updated, ENV_INVENTORY), updated);
  assert.throws(() => withGeneratedDocs('no markers', ENV_INVENTORY), /markers/);
});

test('R3: the committed README table and .env.example files are current', () => {
  const root = new URL('../../', import.meta.url);
  const readme = readFileSync(new URL('README.md', root), 'utf8');
  assert.equal(withGeneratedDocs(readme, ENV_INVENTORY), readme);
  for (const app of ['api', 'worker', 'web', 'admin']) {
    const text = readFileSync(new URL(`apps/${app}/.env.example`, root), 'utf8');
    assert.deepEqual(envExampleProblems(app, text, variablesFor(app).map((e) => e.name)), []);
  }
});

test('R5: client-bundle scan uses the inventory, honours only the NODE_ENV exception, and catches NEXT_PUBLIC_', () => {
  const root = mkdtempSync(join(tmpdir(), 'bundles-'));
  try {
    mkdirSync(join(root, 'chunks'), { recursive: true });
    writeFileSync(join(root, 'chunks/a.js'), 'console.warn("non-standard NODE_ENV value")');
    assert.deepEqual(scanClientBundles([root], ENV_INVENTORY).findings, []);
    for (const entry of ENV_INVENTORY.filter((e) => e.name !== 'NODE_ENV')) {
      writeFileSync(join(root, 'chunks/b.js'), `var x = "${entry.name}";`);
      assert.deepEqual(scanClientBundles([root], ENV_INVENTORY).findings.map((f) => f.term), [entry.name]);
    }
    writeFileSync(join(root, 'chunks/b.js'), 'var x = process.env.NEXT_PUBLIC_ANYTHING;');
    assert.deepEqual(scanClientBundles([root], ENV_INVENTORY).findings.map((f) => f.term), ['NEXT_PUBLIC_*']);
    writeFileSync(join(root, 'chunks/b.js'), 'var MY_API_BASE_URL_X = API_BASE_URLS;');
    assert.deepEqual(scanClientBundles([root], ENV_INVENTORY).findings, []);
    const fake = [...ENV_INVENTORY, { name: 'FUTURE_SECRET', apps: ['api'], required: true, default: null, secret: true, environments: ['local'], status: 'current', description: '' }];
    writeFileSync(join(root, 'chunks/b.js'), 'FUTURE_SECRET');
    assert.deepEqual(scanClientBundles([root], fake).findings.map((f) => f.term), ['FUTURE_SECRET']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
