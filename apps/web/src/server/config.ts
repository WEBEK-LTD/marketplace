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

/**
 * The origin stored listing photographs are served from, for the `img-src` directive (0116).
 *
 * **Its own reader, and one that cannot throw.** The CSP is set at the top of the proxy, on every response,
 * before anything else is read — so a reader that validated the whole configuration here would turn one
 * mistyped variable into a site that serves no response at all. The strict validation still happens, in
 * `validateServerConfigAtStartup` through `WEB_SERVER_FIELDS`, where a malformed value is a named start-up
 * failure; and `buildContentSecurityPolicy` refuses anything that is not an `https` origin regardless. So
 * this reads the one variable and leaves both checks where they belong.
 *
 * Still server-side: it is read while building a response header, and `NEXT_PUBLIC_` would put a value in a
 * client bundle that no browser code uses.
 */
export function readMediaPublicOrigin(
  source: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const value = source.MEDIA_PUBLIC_ORIGIN;
  return value === undefined || value === '' ? null : value;
}
