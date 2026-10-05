import 'server-only';
import { PROBLEM_JSON_MEDIA_TYPE, REFRESH_TOKEN_HEADER, SESSION_TOKEN_HEADER } from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { addressedOrigin, checkSameOrigin } from './origin';
import {
  clearedSessionCookies,
  readAccessToken,
  readRefreshToken,
  sessionCookies,
} from './session-cookies';

/**
 * The BFF half of session continuity (Phase 5-A): renewal and sign-out.
 *
 * F2 put the session in two `__Host-` cookies and stopped. The access cookie lives fifteen minutes, so
 * without these two routes every signed-in surface was fifteen minutes long. Neither route creates a
 * session — login still does that, untouched — and neither is reachable by a page's JavaScript with a
 * token in hand: the browser holds no token it can read, and both routes take their credential from a
 * cookie only this server can see.
 *
 * **Renewal.** The refresh cookie goes to `POST /v1/auth/refresh` on the internal hop, in its own
 * header. What comes back is the same server-to-server envelope login uses, and it stops here: the
 * browser's response is built from a literal, so no token has a path to it. Both cookies are then
 * replaced — the new refresh token as well as the new access token, so the browser stops presenting the
 * old one from this moment.
 *
 * The failure behaviour is the part worth stating. A refusal from the API means the session is over, so
 * both cookies are cleared; an *unreachable* API means nothing about the session, so the cookies are
 * left exactly as they were. Clearing them on a transient outage would sign people out of a working
 * session, which is the opposite of what this route exists for.
 *
 * **Sign-out.** Always succeeds from the browser's point of view, and always clears both cookies — on a
 * refusal, on an outage, and when there was no session to begin with. The upstream call is what tidies
 * up the provider's side; it is not what ends the browser's session, so its outcome cannot leave someone
 * holding cookies they asked to be rid of. It ends the caller's own session and nothing else: there is
 * no route here, and no call from here, that revokes an account's other sessions.
 */

const FORBIDDEN_PROBLEM = {
  type: 'about:blank',
  title: 'Forbidden',
  status: 403,
  detail: 'The request could not be processed.',
  instance: '/auth/session',
  code: 'BAD_REQUEST',
} as const;

const SESSION_REQUIRED_PROBLEM = {
  type: 'about:blank',
  title: 'Unauthorized',
  status: 401,
  detail: 'Authentication is required.',
  instance: '/auth/refresh',
  code: 'AUTHENTICATION_REQUIRED',
} as const;

const UNAVAILABLE_PROBLEM = {
  type: 'about:blank',
  title: 'Service Unavailable',
  status: 503,
  detail: 'The service is temporarily unavailable.',
  instance: '/auth/refresh',
  code: 'SERVICE_UNAVAILABLE',
} as const;

function problemResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
  });
}

function okResponse(): Response {
  return new Response(JSON.stringify({ status: 'ok' }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export interface SessionHandlerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}

/** Reads the server-to-server session envelope, or null if it is not the shape this BFF expects. */
function readEnvelope(text: string): { accessToken: string; refreshToken: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const session = (parsed as Record<string, unknown>)['session'];
  if (typeof session !== 'object' || session === null) return null;
  const { accessToken, refreshToken } = session as Record<string, unknown>;
  if (typeof accessToken !== 'string' || accessToken === '') return null;
  if (typeof refreshToken !== 'string' || refreshToken === '') return null;
  return { accessToken, refreshToken };
}

/**
 * `POST /api/auth/refresh`.
 *
 * The browser asks for a longer session; it never says which one, because it cannot see either token.
 */
export async function handleSessionRefresh(
  request: Request,
  options: SessionHandlerOptions = {},
): Promise<Response> {
  const origin = checkSameOrigin({
    method: request.method,
    url: addressedOrigin(request),
    headers: request.headers,
  });
  if (!origin.ok) return problemResponse(FORBIDDEN_PROBLEM, 403);

  const refreshToken = readRefreshToken(request.headers.get('cookie'));
  // No refresh cookie is no session. Nothing is forwarded, so a browser that has already been signed
  // out cannot spend an upstream call discovering it.
  if (refreshToken === null) {
    const refused = problemResponse(SESSION_REQUIRED_PROBLEM, 401);
    for (const cookie of clearedSessionCookies()) refused.headers.append('set-cookie', cookie);
    return refused;
  }

  const config = readBffConfig(options.env);
  const call = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await call(`${config.apiBaseUrl}/v1/auth/refresh`, {
      method: 'POST',
      headers: { [REFRESH_TOKEN_HEADER]: refreshToken },
    });
  } catch {
    // An outage says nothing about the session, so the cookies are left alone.
    return problemResponse(UNAVAILABLE_PROBLEM, 503);
  }

  const text = await upstream.text();

  if (!upstream.ok) {
    if (upstream.status >= 500) {
      // Same reasoning: a failing API is not an ended session.
      return problemResponse(UNAVAILABLE_PROBLEM, 503);
    }
    // A refusal is the session ending. The API's problem details are already the approved wording.
    const failed = new Response(text, {
      status: upstream.status,
      headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
    });
    for (const cookie of clearedSessionCookies()) failed.headers.append('set-cookie', cookie);
    return failed;
  }

  const envelope = readEnvelope(text);
  if (envelope === null) return problemResponse(UNAVAILABLE_PROBLEM, 503);

  // Built from a literal, never from the upstream body: the tokens have no path to the browser.
  const response = okResponse();
  for (const cookie of sessionCookies(envelope)) response.headers.append('set-cookie', cookie);
  return response;
}

/**
 * `POST /api/auth/logout`.
 *
 * Idempotent, and clears the cookies whatever else happens. A browser that asks to be signed out is
 * signed out.
 */
export async function handleLogout(
  request: Request,
  options: SessionHandlerOptions = {},
): Promise<Response> {
  const origin = checkSameOrigin({
    method: request.method,
    url: addressedOrigin(request),
    headers: request.headers,
  });
  if (!origin.ok) return problemResponse(FORBIDDEN_PROBLEM, 403);

  const accessToken = readAccessToken(request.headers.get('cookie'));

  if (accessToken !== null) {
    const config = readBffConfig(options.env);
    const call = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);
    try {
      const upstream = await call(`${config.apiBaseUrl}/v1/auth/logout`, {
        method: 'POST',
        headers: { [SESSION_TOKEN_HEADER]: accessToken },
      });
      // Read and discard. The provider's answer does not change what the browser is told, and an
      // unread body leaves a socket open.
      await upstream.text().catch(() => '');
    } catch {
      // Deliberately swallowed. The cookies are cleared below either way; a failed upstream sign-out
      // leaves a provider-side session that expires on its own, and telling the browser it is still
      // signed in would be worse than both.
    }
  }

  const response = okResponse();
  for (const cookie of clearedSessionCookies()) response.headers.append('set-cookie', cookie);
  return response;
}
