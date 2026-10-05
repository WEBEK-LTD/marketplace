/**
 * Where the smoke run points.
 *
 * By default, the two local servers `playwright.config.ts` starts — unchanged from before, so a plain
 * `pnpm --filter @repo/e2e run test:e2e` behaves exactly as it always has.
 *
 * `E2E_WEB_URL` and `E2E_ADMIN_URL` each redirect one app at a deployed target instead. They are independent:
 * set one and that app is addressed remotely while the other still starts locally, which is what makes it
 * possible to verify a deployed web site against a local admin console or the reverse. With neither set, no
 * environment variable is read at all.
 *
 * **A malformed value fails the run rather than being ignored.** A smoke suite that silently fell back to
 * localhost after a typo in a deployment URL would report a green deployment that was never visited, which is
 * the one outcome worse than a red one.
 */

/** Local addresses of the two apps started by `playwright.config.ts` for the smoke tests. */
export const WEB_PORT = 3100;
export const ADMIN_PORT = 3101;

const LOCAL_WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const LOCAL_ADMIN_URL = `http://127.0.0.1:${ADMIN_PORT}`;

/**
 * An origin and nothing else: scheme, host and port, with no path, query, fragment, credentials or trailing
 * slash. The specs join paths onto these, so a value carrying a path would silently address the wrong URLs.
 */
function deployedTarget(name: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${name} is not a URL: expected something like https://example.netlify.app`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must be an http or https URL`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(`${name} must not contain credentials`);
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error(`${name} must be an origin with no query string or fragment`);
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error(`${name} must be an origin with no path (found ${parsed.pathname})`);
  }
  return parsed.origin;
}

const deployedWeb = deployedTarget('E2E_WEB_URL', process.env['E2E_WEB_URL']);
const deployedAdmin = deployedTarget('E2E_ADMIN_URL', process.env['E2E_ADMIN_URL']);

export const WEB_URL = deployedWeb ?? LOCAL_WEB_URL;
export const ADMIN_URL = deployedAdmin ?? LOCAL_ADMIN_URL;

/** Whether this run has to start that app itself. False when it is pointed at something already running. */
export const WEB_IS_LOCAL = deployedWeb === null;
export const ADMIN_IS_LOCAL = deployedAdmin === null;

/**
 * True when at least one target is a deployment.
 *
 * The specs use it only where a deployed target genuinely cannot answer the same way as a local one — not to
 * weaken an assertion, but for facts that are about the local servers themselves, such as the placeholder API
 * address they are started with.
 */
export const HAS_DEPLOYED_TARGET = !WEB_IS_LOCAL || !ADMIN_IS_LOCAL;
