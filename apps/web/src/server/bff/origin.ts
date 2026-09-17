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
