import 'server-only';
import { PROBLEM_JSON_MEDIA_TYPE } from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { addressedOrigin, checkSameOrigin } from './origin';
import { clearedSessionCookies, sessionCookies } from './session-cookies';

/**
 * The BFF half of F2.
 *
 * The browser posts here, never to the API and never to Supabase. This handler:
 *
 *   1. applies the existing Origin/CSRF check — the same one every state-changing BFF route uses, not a
 *      second mechanism;
 *   2. forwards the credentials to `POST /v1/auth/login` with the internal BFF credential attached;
 *   3. on success, turns the session into the two `__Host-` cookies of C-8 and answers `{status:'ok'}`;
 *   4. on failure, passes the API's problem details through unchanged.
 *
 * The tokens stop here. The API hands them over in a server-to-server body because the BFF is the only
 * component allowed to mint the browser's cookies (C-8, and the specification's "BFF sets httpOnly
 * cookies"); this function is the wall that body never crosses. The browser's response is built from
 * scratch, so there is no code path that could forward it by accident.
 */

const GENERIC_PROBLEM = {
  type: 'about:blank',
  title: 'Unauthorized',
  status: 401,
  detail: 'Authentication failed.',
  instance: '/auth/login',
  code: 'AUTHENTICATION_FAILED',
} as const;

const FORBIDDEN_PROBLEM = {
  type: 'about:blank',
  title: 'Forbidden',
  status: 403,
  detail: 'The request could not be processed.',
  instance: '/auth/login',
  code: 'BAD_REQUEST',
} as const;

function problemResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
  });
}

export interface LoginHandlerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}

export async function handleLogin(request: Request, options: LoginHandlerOptions = {}): Promise<Response> {
  // `addressedOrigin` supplies the origin the browser addressed; the rule itself is unchanged.
  const origin = checkSameOrigin({ method: request.method, url: addressedOrigin(request), headers: request.headers });
  if (!origin.ok) return problemResponse(FORBIDDEN_PROBLEM, 403);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // A body that is not JSON never reaches the API: it cannot be a valid login and forwarding it would
    // spend a throttle slot on nothing.
    return problemResponse({ ...GENERIC_PROBLEM, title: 'Bad Request', status: 400, code: 'VALIDATION_FAILED', detail: 'The request is invalid.' }, 400);
  }

  const config = readBffConfig(options.env);
  const call = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await call(`${config.apiBaseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return problemResponse(
      { ...GENERIC_PROBLEM, title: 'Service Unavailable', status: 503, code: 'SERVICE_UNAVAILABLE', detail: 'The service is temporarily unavailable.' },
      503,
    );
  }

  const text = await upstream.text();

  if (!upstream.ok) {
    // The API's problem details are already generic (C-2). Passing them through keeps one source of
    // truth for the wording and the code; a session is cleared in case one was present.
    const failed = new Response(text, {
      status: upstream.status,
      headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
    });
    for (const cookie of clearedSessionCookies()) failed.headers.append('set-cookie', cookie);
    return failed;
  }

  const envelope = readEnvelope(text);
  if (envelope === null) {
    return problemResponse(
      { ...GENERIC_PROBLEM, title: 'Service Unavailable', status: 503, code: 'SERVICE_UNAVAILABLE', detail: 'The service is temporarily unavailable.' },
      503,
    );
  }

  // Built from a literal, never from the upstream body: the tokens have no path to the browser.
  const response = new Response(JSON.stringify({ status: 'ok' }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
  for (const cookie of sessionCookies(envelope)) response.headers.append('set-cookie', cookie);
  return response;
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
