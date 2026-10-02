// R4-B: local `start` preflight for the Next.js apps. Validates the server configuration with the same
// shared rules as the app and exits with code 1 before `next start` runs if anything is missing or invalid.
// Prints variable names only, never values.
// Each app is read with its own field map, because the public web has one variable the admin console does
// not: `PUBLIC_WEB_ORIGIN`. Reading either app with the other's map is an inventory mismatch, which is a
// programming error rather than a configuration one and would print the generic message below.
import { EnvValidationError, readNextServerConfig, readWebServerConfig } from '../packages/server-config/dist/index.js';

const app = process.argv[2];
if (app !== 'web' && app !== 'admin') {
  console.error('Usage: node scripts/preflight-next-env.mjs <web|admin>');
  process.exit(2);
}
try {
  if (app === 'web') readWebServerConfig(process.env);
  else readNextServerConfig(app, process.env);
} catch (error) {
  console.error(error instanceof EnvValidationError ? `${app}: ${error.message}` : `${app}: configuration check failed`);
  process.exit(1);
}
