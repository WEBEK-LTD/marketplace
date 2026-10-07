/**
 * Where the smoke run points.
 *
 * By default, the one local server `playwright.config.ts` starts — which serves both surfaces, because since 0108
 * the staff console lives at `/admin` on the public origin rather than on a subdomain of its own.
 *
 * `E2E_WEB_URL` redirects the run at a deployed target instead. With it unset, no environment variable is read
 * at all.
 *
 * **A malformed value fails the run rather than being ignored.** A smoke suite that silently fell back to
 * localhost after a typo in a deployment URL would report a green deployment that was never visited, which is
 * the one outcome worse than a red one.
 *
 * **The origin-only rule is kept, deliberately** (owner decision DR-7). The obvious way to express the new
 * topology would have been to let `E2E_ADMIN_URL` carry a path — `https://site.example/admin` — and that is
 * exactly what {@link deployedTarget} refuses, because the specs join their own paths onto these values and a
 * target carrying a path would silently address the wrong URLs. The console is therefore expressed as the web
 * origin plus {@link ADMIN_PATH_PREFIX}, which is the same statement without weakening the guard that makes
 * every other target safe.
 */

/** Local address of the app started by `playwright.config.ts` for the smoke tests. */
export const WEB_PORT = 3100;

const LOCAL_WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

/**
 * Where the staff console is mounted on the web origin.
 *
 * A literal rather than an import: `.dependency-cruiser.cjs` forbids `packages/e2e` from importing workspace
 * code (`e2e-no-workspace-imports`), because the smoke suite must address the deployment over HTTP exactly as a
 * browser does and prove nothing by sharing a constant with the code under test. The application's own copy
 * lives in `@repo/config` as `ADMIN_SURFACE_PREFIX`, and `public-surface.spec.ts` asserts the two agree by
 * observing the deployment rather than by comparing strings.
 */
export const ADMIN_PATH_PREFIX = '/admin';

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

export const WEB_URL = deployedWeb ?? LOCAL_WEB_URL;

/**
 * The console's base address: the web origin plus the mount point.
 *
 * It is not an origin, and nothing treats it as one — which is the point of keeping the two apart. A spec that
 * needs the console's origin (for a crawl document, say, which belongs to the origin rather than to a surface)
 * uses {@link WEB_URL}.
 */
export const ADMIN_URL = `${WEB_URL}${ADMIN_PATH_PREFIX}`;

/** Whether this run has to start the app itself. False when it is pointed at something already running. */
export const WEB_IS_LOCAL = deployedWeb === null;

/**
 * True when the target is a deployment.
 *
 * The specs use it only where a deployed target genuinely cannot answer the same way as a local one — not to
 * weaken an assertion, but for facts that are about the local server itself, such as the placeholder API
 * address it is started with.
 */
export const HAS_DEPLOYED_TARGET = !WEB_IS_LOCAL;
