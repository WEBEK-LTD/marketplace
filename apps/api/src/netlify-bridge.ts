/**
 * The pure parts of running this API as a serverless function (increment 0117).
 *
 * **Why they live here rather than in the function file.** `netlify/functions/api.mts` is outside `apps/`
 * and `packages/`, so nothing type-checks it, no boundary rule covers it and no suite runs it. The rules it
 * applies — which prefix to strip, how a Fastify reply's headers become a Web `Headers`, when a request has
 * a body at all — are ordinary decisions that can be wrong in ordinary ways, so they belong in the package
 * that is tested. What is left in the function file is the shell: boot once, inject, return.
 */

/** The path prefix the deployment mounts this API under. The application knows nothing about it. */
export const FUNCTION_PATH_PREFIX = '/_api';

/**
 * The path the application should see.
 *
 * `/_api/v1/listings` is `/v1/listings` to the API: the prefix belongs to the deployment, and a route that
 * had to know about it would be a route that could not be served any other way. A request to the prefix
 * itself is `/`, not the empty string, because an empty path is not a path any router matches.
 */
export function applicationPath(pathname: string): string {
  if (pathname === FUNCTION_PATH_PREFIX) return '/';
  const stripped = pathname.startsWith(`${FUNCTION_PATH_PREFIX}/`)
    ? pathname.slice(FUNCTION_PATH_PREFIX.length)
    : pathname;
  return stripped === '' ? '/' : stripped;
}

/**
 * A Fastify reply's headers as a Web `Headers`.
 *
 * **A repeated header is appended, not overwritten**, which is the case that matters: `set-cookie` arrives
 * as an array whenever more than one cookie is set, and flattening it to a single value would silently drop
 * a session cookie. Fastify hands those back as an array, so the array branch is the important one.
 *
 * An absent value is skipped rather than written as the string `"undefined"`.
 */
export function replyHeaders(raw: Readonly<Record<string, unknown>>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, String(entry));
    } else if (value !== undefined && value !== null) {
      headers.set(key, String(value));
    }
  }
  return headers;
}

/** Whether a method may carry a body worth reading. A GET with one is a GET without one. */
export function carriesBody(method: string): boolean {
  const upper = method.toUpperCase();
  return upper !== 'GET' && upper !== 'HEAD';
}

/**
 * The body this deployment answers with when the application could not be built at all.
 *
 * It names nothing. A boot failure here is almost always a missing or malformed environment variable, and
 * the names of those belong in the function log — which only the deployment's owner can read — rather than
 * in a response, which anyone can.
 */
export function bootFailureBody(instance: string): string {
  return JSON.stringify({
    type: 'about:blank',
    title: 'Service Unavailable',
    status: 503,
    detail: 'The service is temporarily unavailable.',
    instance,
    code: 'SERVICE_UNAVAILABLE',
  });
}
