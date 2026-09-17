// `pnpm run check:client-env` (owner decisions R5, R5-a): fails if any inventory variable name (other than
// the documented NODE_ENV exception) or any NEXT_PUBLIC_ name appears in the web/admin client bundles.
// Run after building web and admin.
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ENV_INVENTORY } from '../packages/server-config/dist/index.js';
import { REPO_ROOT } from './toolchain/deno.mjs';
import { scanClientBundles } from './toolchain/env-tooling.mjs';

const dirs = ['web', 'admin'].map((app) => join(REPO_ROOT, 'apps', app, '.next', 'static'));
const missing = dirs.filter((dir) => !existsSync(dir));
if (missing.length > 0) {
  console.error(`check:client-env failed: build web and admin first (missing ${missing.map((d) => relative(REPO_ROOT, d)).join(', ')})`);
  process.exit(1);
}
const result = scanClientBundles(dirs, ENV_INVENTORY);
const exceptions = ENV_INVENTORY.filter((e) => e.clientBundleException !== undefined).map((e) => e.name);
if (result.findings.length > 0) {
  console.error('check:client-env failed:');
  for (const f of result.findings) console.error(`  ${relative(REPO_ROOT, f.file)}: ${f.term}`);
  process.exit(1);
}
console.log(`check:client-env passed: ${result.files} client-bundle files, ${result.terms} inventory names and NEXT_PUBLIC_* checked; documented exception: ${exceptions.join(', ')}.`);
