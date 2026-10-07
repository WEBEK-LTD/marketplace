import 'server-only';
import {
  ListingAnalyticsResponseSchema,
  SESSION_TOKEN_HEADER,
  type ListingAnalyticsResponse,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { readAdminAccessToken } from './staff-session';

/**
 * Listing analytics, on the admin origin (0102).
 *
 * ---------------------------------------------------------------------------------------------------
 * **ONE READ, AND NOTHING ELSE. THIS MODULE HAS NO WRITE PATH AT ALL.**
 *
 * Every BFF module on this origin that submits anything carries an `acceptWrite`, a `callWrite` and a
 * `writeOutcome` — the same-origin check, the rebuilt body, the forwarded refusal. **None of them is here.**
 * There is no `POST` helper, no origin check (nothing is submitted) and no `Request` parameter anywhere in the
 * file. A day is corrected by re-running the scheduled job for it, so there is nothing upstream to call, and a
 * request arriving here asking to change an aggregate has nothing to reach.
 * ---------------------------------------------------------------------------------------------------
 *
 * **The session never leaves the server.** The caller's access token lives in `__Host-mp_admin_access`, which
 * JavaScript cannot read; it is presented to the API on one internal hop in the session-token header, and the
 * browser's own `Cookie` header is never forwarded.
 *
 * **Nothing about the caller crosses in a request.** No account, no role, no permission key and no assurance
 * level appears in anything built here. The API resolves all of it from the session, and the database
 * re-applies the test with `analytics.listing.read` as a literal.
 *
 * **An empty page is a real answer.** A caller who does not hold the key at AAL2 receives one, and so does a
 * window with nothing in it. This layer does not try to tell them apart, because the API deliberately does not:
 * a distinguishable refusal would tell a colleague without the key that this section has something in it.
 *
 * **Responses are validated, not forwarded.** A drifted body becomes a clean failure here rather than a
 * half-rendered page, which is the third wall in front of the things that must never appear on this screen: an
 * account identifier, a session digest, and anything from a raw event.
 *
 * **Cursors stay opaque.** A cursor is passed along as text and never parsed or reconstructed here.
 */

export interface ListingAnalyticsOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

export type ListingAnalyticsResult =
  | { readonly kind: 'ok'; readonly data: ListingAnalyticsResponse }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' };

/** base64url, which is the whole of what a cursor can be. Dropped here rather than forwarded. */
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;

/**
 * The query string, built from what the caller passed and nothing else.
 *
 * A malformed window is dropped rather than forwarded, so a mistyped bookmark shows the default window instead
 * of an error. A malformed page size is dropped for the same reason; the API refuses one it cannot parse, and
 * there is no reason to make it do that for a value this layer can already see is not a number.
 */
function query(input: {
  readonly days?: string | null;
  readonly limit?: string | null;
  readonly cursor?: string | null;
}): string {
  const params = new URLSearchParams();
  if (typeof input.days === 'string' && /^\d{1,5}$/.test(input.days)) params.set('days', input.days);
  if (typeof input.limit === 'string' && /^\d{1,3}$/.test(input.limit)) params.set('limit', input.limit);
  if (typeof input.cursor === 'string' && CURSOR_PATTERN.test(input.cursor)) {
    // Passed along as text. This layer does not know what a cursor contains and must not learn.
    params.set('cursor', input.cursor);
  }
  return params.size === 0 ? '' : `?${params.toString()}`;
}

/** One page of the rollup, newest day first. */
export async function readListingAnalytics(
  input: {
    readonly days?: string | null;
    readonly limit?: string | null;
    readonly cursor?: string | null;
  } = {},
  options: ListingAnalyticsOptions = {},
): Promise<ListingAnalyticsResult> {
  const accessToken = readAdminAccessToken(options.cookieHeader ?? null);
  if (accessToken === null) return { kind: 'unauthenticated' };

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}/v1/admin/analytics/listings${query(input)}`, {
      method: 'GET',
      headers: { [SESSION_TOKEN_HEADER]: accessToken },
    });
  } catch {
    return { kind: 'unavailable' };
  }

  if (!upstream.ok) {
    await upstream.text().catch(() => '');
    if (upstream.status === 401) return { kind: 'unauthenticated' };
    // A cursor this API did not issue. Reported so the console can clear it and start again.
    if (upstream.status === 400) return { kind: 'invalid' };
    return { kind: 'unavailable' };
  }

  try {
    const parsed = ListingAnalyticsResponseSchema.safeParse(JSON.parse(await upstream.text()));
    return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}
