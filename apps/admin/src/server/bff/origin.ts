import 'server-only';
export type OriginCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'origin_mismatch' | 'missing_origin' };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for future BFF handlers: state-changing requests must come from this origin.
 * The Origin header must equal the request's own origin; without Origin, only a browser-set
 * `Sec-Fetch-Site: same-origin` is accepted.
 */
export function checkSameOrigin(request: { readonly method: string; readonly url: string; readonly headers: Headers }): OriginCheck {
  if (SAFE_METHODS.has(request.method.toUpperCase())) {
    return { ok: true };
  }
  const expected = new URL(request.url).origin;
  const origin = request.headers.get('origin');
  if (origin !== null) {
    return origin === expected ? { ok: true } : { ok: false, reason: 'origin_mismatch' };
  }
  return request.headers.get('sec-fetch-site') === 'same-origin' ? { ok: true } : { ok: false, reason: 'missing_origin' };
}

/**
 * The origin the browser actually addressed, for the check above to compare the `Origin` header with.
 *
 * `new URL(request.url).origin` is not that origin in every deployment: a Node server that does not
 * rebuild absolute URLs from the request line reports its own listening origin instead (`next start`
 * reports `http://localhost:<port>` whatever `Host` says), so comparing against it would refuse every
 * same-origin login behind a proxy. The host the request was addressed to is what the browser used to
 * build `Origin`, so that is what this derives: the forwarded host if a proxy set one, otherwise
 * `Host`, and only the request URL when neither exists.
 *
 * This does not loosen the rule — `Origin` must still equal this site's origin exactly, and a request
 * without `Origin` still needs `Sec-Fetch-Site: same-origin`. A cross-site page cannot set `Host` or
 * `X-Forwarded-Host` on a request the browser makes with this site's cookies, so neither header gives
 * an attacker a way to make a foreign `Origin` match.
 */
export function addressedOrigin(request: { readonly url: string; readonly headers: Headers }): string {
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  const requested = new URL(request.url);
  if (host === null || host.trim() === '') return requested.origin;
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const scheme = forwardedProto === 'http' || forwardedProto === 'https' ? forwardedProto : requested.protocol.replace(':', '');
  return `${scheme}://${host.split(',')[0]?.trim() ?? host}`;
}
