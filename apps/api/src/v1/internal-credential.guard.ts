import { createHash, timingSafeEqual } from 'node:crypto';
import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

/** The header the BFF presents on every `/v1` request (owner decision C-2d). */
export const INTERNAL_CREDENTIAL_HEADER = 'x-internal-credential';

/**
 * Requires the internal BFF credential on every `/v1` route.
 *
 *   > Every `/v1` route except webhooks, hooks and health checks requires the internal BFF credential;
 *   > user authentication and authorization are checked separately on every request.
 *
 * **This guard authorizes nothing about a user.** It answers one question — is the caller an approved
 * internal runtime — and it attaches nothing to the request, deliberately, so that no downstream handler
 * can mistake it for a principal. The specification is explicit that the credential is "an extra
 * boundary only" and must never be treated as user authorization.
 *
 * `/health` and `/ready` live outside `/v1` and are untouched.
 *
 * Webhook and hook routes are the specification's stated exemptions, but none exist yet, so this guard
 * requires the credential on **all** of `/v1`. Requiring it somewhere it will later be exempt fails
 * closed and is visible the moment that route is built; pre-exempting a path that does not exist would
 * fail open against nothing.
 *
 * ## Scope is decided by the matched route, never by the raw URL
 *
 * Fastify's router percent-decodes path segments before matching, so `GET /%76%31/foundation` resolves
 * to the registered route `/v1/foundation`. An earlier version of this guard read `request.url`, which
 * stays raw, saw a path that did not look like `/v1`, and let the request through to the handler — a
 * fail-open bypass of the whole boundary. The guard therefore asks Fastify which route it matched
 * (`request.routeOptions.url`, the literal registered pattern) and never parses caller-controlled URL
 * text. There is deliberately no decoder here: reimplementing the router's normalization rules is how
 * the two disagreed in the first place.
 */
@Injectable()
export class InternalCredentialGuard implements CanActivate {
  /**
   * SHA-256 digests of the accepted credentials, computed once.
   *
   * Digests rather than raw values so that comparison is fixed-width: `timingSafeEqual` throws on
   * length mismatch, and branching on length would leak how long the real credential is.
   */
  readonly #accepted: readonly Buffer[];

  constructor(accepted: readonly string[]) {
    if (accepted.length === 0) throw new RangeError('At least one internal credential is required.');
    this.#accepted = accepted.map((value) => digest(value));
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ routeOptions?: { url?: string }; headers: Record<string, unknown> }>();
    if (!isProtectedRoutePattern(request.routeOptions?.url)) return true;

    const presented = request.headers[INTERNAL_CREDENTIAL_HEADER];
    // A duplicated header arrives as an array. That is malformed, and malformed is refused exactly like
    // missing and wrong — the caller learns nothing from which mistake they made.
    if (typeof presented !== 'string' || !this.#matches(presented)) {
      // No message, no `WWW-Authenticate`, no hint. The filter renders 403 + HTTP_ERROR, which is
      // byte-identical whichever of the three failures occurred.
      throw new ForbiddenException();
    }

    return true;
  }

  #matches(presented: string): boolean {
    const candidate = digest(presented);
    let matched = false;
    for (const accepted of this.#accepted) {
      // `timingSafeEqual(...) || matched`, never `matched || timingSafeEqual(...)`: the comparison must
      // run for every accepted value, so the work done does not reveal which one matched, or whether an
      // earlier one already did.
      matched = timingSafeEqual(candidate, accepted) || matched;
    }
    return matched;
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * True when the route Fastify matched belongs to the protected `/v1` group.
 *
 * The argument is the **registered route pattern** (`request.routeOptions.url`), not a request URL: it
 * is a literal string the application itself registered, so it carries no percent-encoding, no query
 * string and nothing a caller can influence. That is what makes this decision safe without a decoder.
 *
 * Any pattern beginning `/v1` is protected, so a future route group registered as, say, `/v1x` is
 * covered rather than silently exempt. Erring wide is the fail-closed direction: an over-protected
 * route returns 403 to an internal caller and is noticed immediately, whereas an under-protected one
 * is a silent hole.
 *
 * An absent or empty pattern means the matched route could not be determined, which is treated as
 * protected. In practice Fastify only leaves it unset when no route matched at all — those requests
 * never reach a handler — so failing closed here costs nothing and removes the possibility that a
 * future routing change quietly turns "unknown" into "unprotected".
 */
export function isProtectedRoutePattern(routePattern: string | undefined): boolean {
  if (typeof routePattern !== 'string' || routePattern === '') return true;
  return routePattern.startsWith('/v1');
}
