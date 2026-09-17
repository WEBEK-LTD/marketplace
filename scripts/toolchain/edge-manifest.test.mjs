import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkEntryExports, compareEdgeManifests, expectedPattern } from './edge-manifest.mjs';

const PATTERN = '^(?:\\/(_next\\/data\\/[^/]{1,}))?(?:\\/((?!_next\\/|_vercel\\/).*))(\\.json|\\.rsc|\\.segments\\/.+\\.segment\\.rsc)?[\\/#\\?]?$';
const runtime = {
  version: 1,
  functions: [{ function: 'mw', name: 'Next.js Middleware Handler', pattern: PATTERN, generator: '@netlify/plugin-nextjs@5.15.13' }],
};
const bundled = () => ({
  bundles: [{ asset: 'x.eszip', format: 'eszip2' }],
  routes: [{ function: 'mw', pattern: expectedPattern(PATTERN), excluded_patterns: [] }],
  post_cache_routes: [],
  function_config: { mw: { name: 'Next.js Middleware Handler', generator: '@netlify/plugin-nextjs@5.15.13' } },
});

test('matching manifests pass (pattern normalised like the bundler)', () => {
  assert.equal(expectedPattern(PATTERN), '^(?:/(_next/data/[^/]{1,}))?(?:/((?!_next/|_vercel/).*))(\\.json|\\.rsc|\\.segments/.+\\.segment\\.rsc)?[/#\\?]?$');
  assert.deepEqual(compareEdgeManifests(runtime, bundled()), []);
});

test('a changed or missing route fails', () => {
  const b = bundled();
  b.routes[0].pattern = '^/.*$';
  assert.equal(compareEdgeManifests(runtime, b).length, 1);
  const c = bundled();
  c.routes = [];
  assert.match(compareEdgeManifests(runtime, c)[0], /routes entry differs/);
});

test('lost or extra function config fails', () => {
  const b = bundled();
  delete b.function_config.mw.generator;
  assert.match(compareEdgeManifests(runtime, b)[0], /function_config differs/);
  const c = bundled();
  c.function_config.mw.path = '/x';
  assert.match(compareEdgeManifests(runtime, c)[0], /function_config differs/);
});

test('lost exclusions, cache placement and undeclared functions fail', () => {
  const r = structuredClone(runtime);
  r.functions[0].excludedPattern = '^\\/api\\/.*$';
  assert.match(compareEdgeManifests(r, bundled())[0], /routes entry differs/);
  const m = structuredClone(runtime);
  m.functions[0].cache = 'manual';
  assert.ok(compareEdgeManifests(m, bundled()).length >= 1);
  const u = bundled();
  u.routes.push({ function: 'other', pattern: '^/$', excluded_patterns: [] });
  assert.match(compareEdgeManifests(runtime, u).join('\n'), /undeclared function other/);
});

test('unknown declaration features fail closed', () => {
  const r = structuredClone(runtime);
  r.functions[0].header = { 'x-a': true };
  assert.match(compareEdgeManifests(r, bundled())[0], /not handled by the verifier: header/);
  const p = { version: 1, functions: [{ function: 'mw', path: '/*' }] };
  assert.match(compareEdgeManifests(p, bundled()).join('\n'), /only pattern-based/);
  assert.deepEqual(compareEdgeManifests({ version: 2, functions: [] }, bundled()), ['runtime manifest: unsupported format or no functions']);
});

test('entry modules may export only a default handler', () => {
  assert.deepEqual(checkEntryExports('mw', "import x from './a.js';\nexport default (req) => x(req);\n"), []);
  assert.equal(checkEntryExports('mw', 'export default () => 1;\nexport const config = { path: "/" };').length, 1);
  assert.equal(checkEntryExports('mw', "export * from './a.js';\nexport default () => 1;").length, 1);
  assert.equal(checkEntryExports('mw', "export { config } from './a.js';\nexport default () => 1;").length, 1);
  assert.equal(checkEntryExports('mw', 'const a = 1;').length, 1);
});
