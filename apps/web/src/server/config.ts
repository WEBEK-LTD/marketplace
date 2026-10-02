import 'server-only';
import { configLoadedEvent, readWebServerConfig, WEB_SERVER_FIELDS, type WebServerConfig } from '@repo/server-config';

/**
 * The web app's only reader of the process environment (server runtime only).
 * Values are read from the environment each time they are requested at start-up or by the BFF;
 * the result is frozen and never contains a value that could reach a client bundle.
 *
 * `PUBLIC_WEB_ORIGIN` is read here with the rest. Its name says public, and the value is not a secret, but it
 * is still read server-side only: the sitemap and robots documents are built on the server, so nothing about
 * the origin needs to reach a browser, and `NEXT_PUBLIC_` would put it in a client bundle for no purpose.
 */
export function loadServerConfig(source: Readonly<Record<string, string | undefined>> = process.env): WebServerConfig {
  return readWebServerConfig(source);
}

/** Called from instrumentation.ts when the Node.js server starts. Throws if the configuration is invalid. */
export function validateServerConfigAtStartup(): void {
  loadServerConfig();
  // Safe metadata only: no configuration values and no variable names (owner decision R11).
  console.info(JSON.stringify(configLoadedEvent('web', WEB_SERVER_FIELDS)));
}
