// `pnpm run check:env`: process.env boundary (R7), .env files (R8) and inventory documentation (R3).
// `pnpm run check:env -- --write-docs` regenerates the README inventory table.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENV_INVENTORY, variablesFor } from '../packages/server-config/dist/index.js';
import { REPO_ROOT } from './toolchain/deno.mjs';
import { envBoundaryViolations, envExampleProblems, forbiddenEnvFiles, sourceFiles, withGeneratedDocs } from './toolchain/env-tooling.mjs';

const problems = [];

const files = sourceFiles(REPO_ROOT);
for (const file of files) problems.push(...envBoundaryViolations(file, readFileSync(join(REPO_ROOT, file), 'utf8')));

for (const app of ['api', 'worker', 'web', 'admin']) {
  const path = join(REPO_ROOT, 'apps', app, '.env.example');
  if (!existsSync(path)) problems.push(`apps/${app}/.env.example is missing`);
  else problems.push(...envExampleProblems(`apps/${app}`, readFileSync(path, 'utf8'), variablesFor(app).map((e) => e.name)));
}
for (const file of forbiddenEnvFiles(REPO_ROOT)) problems.push(`${file}: environment files must not be in the repository`);

const readmePath = join(REPO_ROOT, 'README.md');
const readme = readFileSync(readmePath, 'utf8');
const generated = withGeneratedDocs(readme, ENV_INVENTORY);
if (process.argv.includes('--write-docs')) {
  writeFileSync(readmePath, generated);
  console.log('README inventory table regenerated.');
} else if (generated !== readme) {
  problems.push('README.md inventory table is out of date (run `pnpm run check:env -- --write-docs`)');
}

if (problems.length > 0) {
  console.error(`check:env failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`check:env passed: ${files.length} source files checked for process.env use; 4 .env.example files match the inventory; no environment files present; README inventory table current.`);
