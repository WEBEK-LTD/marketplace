import 'server-only';
import { DEVICE_ID_HEADER, DEVICE_ROTATED_HEADER, PROBLEM_JSON_MEDIA_TYPE } from '@repo/contracts';
import { DeviceIdentity } from '@repo/server-config';
import { deviceCookie, readDeviceCookie } from './device-cookie';
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
 * C-15 adds one thing and changes none of the above: the browser's device value travels with the
 * request so the API can record which device signed in. A browser without a usable one is given a fresh
 * random value here — this is the only place one is issued — and keeps it for a year. The session
 * cookies, the response body, the statuses and the failure path are exactly what they were.
 *
 * If the device the browser presented had been revoked, the API issues a replacement and names it in an
 * internal response header; this handler writes that value into the cookie. The revoked device stays
 * revoked in the database — only the browser's cookie moves on.
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

  // C-15: the device this browser already carries, or a fresh one. `issued` is what decides whether a
  // `Set-Cookie` is needed below — a browser that already had a usable value keeps the cookie it has.
  const existingDevice = readDeviceCookie(request.headers.get('cookie'));
  const deviceId = existingDevice ?? DeviceIdentity.issue();

  let upstream: Response;
  try {
    upstream = await call(`${config.apiBaseUrl}/v1/auth/login`, {
      method: 'POST',
      // The device value goes as a header, not in the body: the login request schema is the approved
      // F2 contract and is not widened by an observation about the browser.
      headers: { 'content-type': 'application/json', [DEVICE_ID_HEADER]: deviceId },
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

  // Three cases, one line each. A replacement for a revoked device wins, because the value the browser
  // holds is no longer usable. Otherwise a browser that arrived without a usable device keeps the one
  // issued for it above. A browser with a live device is left alone — its cookie is already correct.
  //
  // A failed login sets no device cookie at all: C-15 registers a device on *successful authenticated*
  // login, and a cookie handed to an unauthenticated caller would be a tracker rather than a device.
  const replacement = rotatedDevice(upstream.headers);
  const cookieValue = replacement ?? (existingDevice === null ? deviceId : null);
  if (cookieValue !== null) response.headers.append('set-cookie', deviceCookie(cookieValue));
  return response;
}

/**
 * The replacement device value the API issued for a revoked one, or null when there was none.
 *
 * A header that is not the shape this server issues is ignored rather than written: the cookie may only
 * ever carry a value that came from `DeviceIdentity.issue()`.
 */
function rotatedDevice(headers: Headers): string | null {
  const value = headers.get(DEVICE_ROTATED_HEADER);
  return DeviceIdentity.isWellFormed(value) ? value : null;
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
