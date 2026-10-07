// `pnpm run check:client-env` (owner decisions R5, R5-a): fails if any inventory variable name (other than
// the documented NODE_ENV exception) or any NEXT_PUBLIC_ name appears in the client bundles.
// Run after building the web app.
//
// One build directory since 0108. That is a tightening rather than a reduction: the staff console's client bundles
// now land in `apps/web/.next/static` alongside the marketplace's, so one scan covers both surfaces and neither can
// be built without being scanned.
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ENV_INVENTORY } from '../packages/server-config/dist/index.js';
import { REPO_ROOT } from './toolchain/deno.mjs';
import { scanClientBundles } from './toolchain/env-tooling.mjs';

const dirs = [join(REPO_ROOT, 'apps', 'web', '.next', 'static')];
const missing = dirs.filter((dir) => !existsSync(dir));
if (missing.length > 0) {
  console.error(`check:client-env failed: build the web app first (missing ${missing.map((d) => relative(REPO_ROOT, d)).join(', ')})`);
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
