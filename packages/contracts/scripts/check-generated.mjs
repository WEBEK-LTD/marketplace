// Fails if the committed OpenAPI document or generated client differs from a fresh generation.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeOpenApiDocument } from '../dist/openapi/document.js';

const root = fileURLToPath(new URL('..', import.meta.url));
let failed = false;

const committedDocument = readFileSync(join(root, 'openapi/openapi.json'), 'utf8');
if (committedDocument !== serializeOpenApiDocument()) {
  console.error('openapi/openapi.json is out of date. Run "pnpm run generate".');
  failed = true;
}

const tempDir = mkdtempSync(join(tmpdir(), 'orval-check-'));
try {
  const output = join(tempDir, 'api-client.ts');
  execFileSync('orval', ['--config', 'orval.config.mjs'], {
    cwd: root,
    env: { ...process.env, ORVAL_OUTPUT: output },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const fresh = readFileSync(output, 'utf8').replace(/from '(?:\.\.\/)+[^']*client\/api-fetch(?:\.js)?'/, "from '../client/api-fetch.js'");
  const committed = readFileSync(join(root, 'src/generated/api-client.ts'), 'utf8');
  if (fresh !== committed) {
    console.error('src/generated/api-client.ts is out of date. Run "pnpm run generate".');
    failed = true;
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

if (failed) {
  process.exit(1);
}
console.log('Generated OpenAPI document and client are up to date.');
