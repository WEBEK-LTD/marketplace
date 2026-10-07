// R4-B: local `start` preflight for the Next.js app. Validates the server configuration with the same
// shared rules as the app and exits with code 1 before `next start` runs if anything is missing or invalid.
// Prints variable names only, never values.
//
// One app since 0108: the staff console moved from its own deployment to `/admin` on the public one, so there is one
// field map to read rather than a choice between two. `readWebServerConfig` is that map — the two required variables
// plus the optional `PUBLIC_WEB_ORIGIN` — and it covers both surfaces, because both are served by this one runtime.
import { EnvValidationError, readWebServerConfig } from '../packages/server-config/dist/index.js';

const app = process.argv[2];
if (app !== 'web') {
  console.error('Usage: node scripts/preflight-next-env.mjs web');
  process.exit(2);
}
try {
  readWebServerConfig(process.env);
} catch (error) {
  console.error(error instanceof EnvValidationError ? `${app}: ${error.message}` : `${app}: configuration check failed`);
  process.exit(1);
}
