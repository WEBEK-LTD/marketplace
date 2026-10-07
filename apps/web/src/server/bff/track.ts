import 'server-only';
import { TrackRequestSchema, TrackResponseSchema, SESSION_TOKEN_HEADER } from '@repo/contracts';
import { analyticsSessionCookie, resolveAnalyticsSession } from './analytics-session-cookie';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readAccessToken } from './session-cookies';

/**
 * `POST /api/track` — the browser's analytics beacon (0101).
 *
 * **The one write route on this origin that works without a session.** A visitor browsing the catalogue
 * signed out is the normal case, so requiring a session would mean collecting nothing from most traffic.
 * Everything else about a write still applies: the same-origin check, a JSON body, and the internal
 * credential on the hop upstream.
 *
 * **What this route adds to the request, and what it refuses to pass on.** It resolves the analytics session
 * from its own cookie — issuing one if the browser has none — and forwards the opaque value; it forwards the
 * caller's session token when there is one, so the API can resolve the account itself. It forwards the events
 * exactly as the contract validates them, and the contract has no field for an account or a digest, so a page
 * script cannot claim to be somebody or choose what is stored.
 *
 * **A failure here is silent to the page.** A beacon has nothing to show a visitor and nothing to retry for:
 * if the API refuses or cannot be reached, this answers `202` with a zero count and the page carries on. The
 * one exception is a malformed body, which is the page's own bug and is told so.
 */

export interface TrackHandlerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly cookieHeader?: string | null;
}

/** 202 with a count, and the session cookie when one was issued. The page reads neither. */
function accepted(count: number, setCookie: string | null): Response {
  const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
  if (setCookie !== null) headers.append('set-cookie', setCookie);
  return new Response(JSON.stringify({ accepted: count }), { status: 202, headers });
}

export async function handleTrack(request: Request, options: TrackHandlerOptions = {}): Promise<Response> {
  const origin = checkSameOrigin({
    method: request.method,
    url: addressedOrigin(request),
    headers: request.headers,
  });
  if (!origin.ok) {
    return new Response(JSON.stringify({ status: 403, code: 'BAD_REQUEST' }), {
      status: 403,
      headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' },
    });
  }

  const raw = await request.text().catch(() => '');
  let parsed: unknown;
  try {
    parsed = raw === '' ? {} : JSON.parse(raw);
  } catch {
    return new Response(JSON.stringify({ status: 400, code: 'VALIDATION_FAILED' }), {
      status: 400,
      headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' },
    });
  }

  const cookieHeader = options.cookieHeader ?? request.headers.get('cookie');
  const session = resolveAnalyticsSession(cookieHeader);
  const setCookie = session.isNew ? analyticsSessionCookie(session.sessionId) : null;

  const fields = (parsed ?? {}) as Record<string, unknown>;
  // The session identifier is this server's, never the body's: a value sent in the body is dropped here
  // rather than forwarded, so a page cannot choose which session its events belong to.
  const validated = TrackRequestSchema.safeParse({
    events: fields['events'],
    sessionId: session.sessionId,
  });
  if (!validated.success) {
    return new Response(JSON.stringify({ status: 400, code: 'VALIDATION_FAILED' }), {
      status: 400,
      headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' },
    });
  }

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);
  const accessToken = readAccessToken(cookieHeader);

  let upstream: Response | null;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}/v1/track`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Only when the visitor has one. Its absence is what "anonymous" means upstream.
        ...(accessToken === null ? {} : { [SESSION_TOKEN_HEADER]: accessToken }),
      },
      body: JSON.stringify(validated.data),
    });
  } catch {
    upstream = null;
  }

  // Anything other than the API's own 202 is reported to the page as nothing accepted. A beacon that is
  // rate-limited or unavailable is not an error a visitor can act on, and retrying would make a flood worse.
  if (upstream === null || upstream.status !== 202) return accepted(0, setCookie);

  const body = await upstream.json().catch(() => null);
  const response = TrackResponseSchema.safeParse(body);
  return accepted(response.success ? response.data.accepted : 0, setCookie);
}
