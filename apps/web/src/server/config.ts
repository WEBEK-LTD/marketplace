import 'server-only';
import { configLoadedEvent, NEXT_SERVER_FIELDS, readNextServerConfig, type NextServerConfig } from '@repo/server-config';

/**
 * The web app's only reader of the process environment (server runtime only).
 * Values are read from the environment each time they are requested at start-up or by the BFF;
 * the result is frozen and never contains a value that could reach a client bundle.
 */
export function loadServerConfig(source: Readonly<Record<string, string | undefined>> = process.env): NextServerConfig {
  return readNextServerConfig('web', source);
}

/** Called from instrumentation.ts when the Node.js server starts. Throws if the configuration is invalid. */
export function validateServerConfigAtStartup(): void {
  loadServerConfig();
  // Safe metadata only: no configuration values and no variable names (owner decision R11).
  console.info(JSON.stringify(configLoadedEvent('web', NEXT_SERVER_FIELDS)));
}
