import 'server-only';
import { PROBLEM_JSON_MEDIA_TYPE, SESSION_TOKEN_HEADER } from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { addressedOrigin, checkSameOrigin } from './origin';
import { SESSION_COOKIES, sessionCookies } from './session-cookies';
import {
  clearedTotpChallengeCookie,
  readTotpChallengeCookie,
  totpChallengeCookie,
} from './totp-challenge-cookie';

/**
 * The browser half of TOTP enrolment and the AAL2 challenge, on the admin origin (Phase 7-B).
 *
 * Four handlers, one per approved API route, and four rules that shape all of them.
 *
 * **The session never leaves the server.** The caller's access token lives in `__Host-mp_admin_access`,
 * which JavaScript cannot read, and this module is the only thing that reads it — presenting it to the
 * API on one internal hop. When a satisfied challenge produces the provider's new `aal2` session, that
 * session arrives here and stops: this module turns it into the same two `__Host-mp_admin_*` cookies the
 * sign-in wrote, and the browser is answered with a literal. There is no code path that forwards the
 * API's body, so there is none that could forward a token by accident.
 *
 * **The challenge is server state.** Which factor, which challenge, and which operation a correct code
 * will authorise all travel to the BFF on the internal hop and live in the `HttpOnly`
 * `__Host-mp_admin_totp_challenge` cookie. A page never learns any of them, and a `factorId`,
 * `challengeId` or `operation` a page tried to send is dropped here rather than forwarded.
 *
 * **The secret crosses once and is not stored.** The enrolment response is the one body this module
 * passes on rather than rebuilds, because the screen genuinely needs the secret and the Key URI. It goes
 * out under `no-store`, it is never written to a cookie, and asking again is refused by the API once a
 * factor is verified — so there is no second copy and no way to request one.
 *
 * **A satisfied challenge replaces the session it was raised against.** That is not an optimisation: the
 * old token is `aal1`, the new one is `aal2`, and the whole point of the challenge is that staff RLS
 * should see the second. Verifying also ends other sessions at the provider, which is documented
 * behaviour for a first enrolment, so leaving the old cookies in place would leave the browser holding a
 * token that no longer works.
 */

const FORBIDDEN_PROBLEM = {
  type: 'about:blank',
  title: 'Forbidden',
  status: 403,
  detail: 'The request could not be processed.',
  instance: '/auth/totp',
  code: 'BAD_REQUEST',
} as const;

const VALIDATION_PROBLEM = {
  type: 'about:blank',
  title: 'Bad Request',
  status: 400,
  detail: 'The request is invalid.',
  instance: '/auth/totp',
  code: 'VALIDATION_FAILED',
} as const;

const SESSION_REQUIRED_PROBLEM = {
  type: 'about:blank',
  title: 'Unauthorized',
  status: 401,
  detail: 'Authentication is required.',
  instance: '/auth/totp',
  code: 'AUTHENTICATION_REQUIRED',
} as const;

const CHALLENGE_REQUIRED_PROBLEM = {
  type: 'about:blank',
  title: 'Unauthorized',
  status: 401,
  detail: 'Authentication failed.',
  instance: '/auth/totp',
  code: 'AUTHENTICATION_FAILED',
} as const;

const UNAVAILABLE_PROBLEM = {
  type: 'about:blank',
  title: 'Service Unavailable',
  status: 503,
  detail: 'The service is temporarily unavailable.',
  instance: '/auth/totp',
  code: 'SERVICE_UNAVAILABLE',
} as const;

function problemResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export interface TotpHandlerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}

interface Upstream {
  readonly ok: boolean;
  readonly status: number;
  readonly text: string;
}

/** Reads the caller's access token from the admin session cookie, or null when there is no session. */
function readSessionToken(cookieHeader: string | null): string | null {
  if (cookieHeader === null) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIES.access.name) continue;
    const value = part.slice(separator + 1).trim();
    return value === '' ? null : value;
  }
  return null;
}

/** Calls the API with the internal credential and the caller's token, or reports it unreachable. */
async function callApi(
  path: string,
  method: 'GET' | 'POST',
  body: unknown,
  token: string,
  options: TotpHandlerOptions,
): Promise<Upstream | null> {
  const config = readBffConfig(options.env);
  const call = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);
  try {
    const response = await call(`${config.apiBaseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', [SESSION_TOKEN_HEADER]: token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { ok: response.ok, status: response.status, text: await response.text() };
  } catch {
    return null;
  }
}

/** Passes an API problem through; its wording and code are already the approved ones. */
function forwardProblem(upstream: Upstream): Response {
  return new Response(upstream.text, {
    status: upstream.status,
    headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
  });
}

/** The Origin/CSRF check and the session, or the response that refuses the request. */
function accept(request: Request): { token: string } | { refusal: Response } {
  const origin = checkSameOrigin({
    method: request.method,
    url: addressedOrigin(request),
    headers: request.headers,
  });
  if (!origin.ok) return { refusal: problemResponse(FORBIDDEN_PROBLEM, 403) };

  const token = readSessionToken(request.headers.get('cookie'));
  if (token === null) return { refusal: problemResponse(SESSION_REQUIRED_PROBLEM, 401) };
  return { token };
}

function parsed(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * `GET /api/auth/totp` — whether the caller has an authenticator.
 *
 * Rebuilt from the one field this layer understands, so an API body cannot grow one that reaches the
 * browser by accident.
 */
export async function handleTotpStatus(
  request: Request,
  options: TotpHandlerOptions = {},
): Promise<Response> {
  // A read, so the Origin check does not apply; the session still does.
  const token = readSessionToken(request.headers.get('cookie'));
  if (token === null) return problemResponse(SESSION_REQUIRED_PROBLEM, 401);

  const upstream = await callApi('/v1/auth/totp', 'GET', undefined, token, options);
  if (upstream === null) return problemResponse(UNAVAILABLE_PROBLEM, 503);
  if (!upstream.ok) return forwardProblem(upstream);

  const status = parsed(upstream.text)?.['status'];
  if (status !== 'enrolled' && status !== 'not_enrolled') return problemResponse(UNAVAILABLE_PROBLEM, 503);
  return jsonResponse({ status });
}

/**
 * `POST /api/auth/totp/enrol` — begin enrolling an authenticator.
 *
 * The one response this module passes on rather than rebuilds, and only after checking it really is the
 * approved shape. No cookie is set: nothing has been challenged yet and nothing has been proved.
 */
export async function handleTotpEnrol(
  request: Request,
  options: TotpHandlerOptions = {},
): Promise<Response> {
  const accepted = accept(request);
  if ('refusal' in accepted) return accepted.refusal;

  const upstream = await callApi('/v1/auth/totp/enrol', 'POST', {}, accepted.token, options);
  if (upstream === null) return problemResponse(UNAVAILABLE_PROBLEM, 503);
  if (!upstream.ok) return forwardProblem(upstream);

  const body = parsed(upstream.text);
  const secret = body?.['secret'];
  const otpauthUri = body?.['otpauthUri'];
  const qrSvg = body?.['qrSvg'];
  if (typeof secret !== 'string' || secret === '' || typeof otpauthUri !== 'string' || otpauthUri === '') {
    return problemResponse(UNAVAILABLE_PROBLEM, 503);
  }

  // Assembled here from the three fields the setup screen uses, so nothing else the API said travels on.
  return jsonResponse({
    status: 'ok',
    secret,
    otpauthUri,
    qrSvg: typeof qrSvg === 'string' && qrSvg !== '' ? qrSvg : null,
  });
}

/**
 * `POST /api/auth/totp/challenge` — raise a challenge.
 *
 * The operation the page asks for is forwarded, and then — this is the part that matters — kept in the
 * cookie written here. From this point the choice is sealed: the verification below takes the operation
 * from the cookie and never from a request.
 */
export async function handleTotpChallenge(
  request: Request,
  options: TotpHandlerOptions = {},
): Promise<Response> {
  const accepted = accept(request);
  if ('refusal' in accepted) return accepted.refusal;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return problemResponse(VALIDATION_PROBLEM, 400);
  }

  // Only the operation is forwarded. A `factorId` or `challengeId` a page added is dropped here and
  // would be refused by the API's strict schema anyway.
  const operation = (body as { operation?: unknown } | null)?.operation;
  const upstream = await callApi(
    '/v1/auth/totp/challenge',
    'POST',
    operation === undefined ? {} : { operation },
    accepted.token,
    options,
  );
  if (upstream === null) return problemResponse(UNAVAILABLE_PROBLEM, 503);
  if (!upstream.ok) return forwardProblem(upstream);

  const challenge = parsed(upstream.text)?.['challenge'];
  const factorId = typeof challenge === 'object' && challenge !== null
    ? (challenge as Record<string, unknown>)['factorId']
    : undefined;
  const challengeId = typeof challenge === 'object' && challenge !== null
    ? (challenge as Record<string, unknown>)['challengeId']
    : undefined;
  if (typeof factorId !== 'string' || typeof challengeId !== 'string') {
    return problemResponse(UNAVAILABLE_PROBLEM, 503);
  }

  const cookie = totpChallengeCookie({
    factorId,
    challengeId,
    operation: typeof operation === 'string' ? operation : null,
  });
  // A challenge this module could not write back is a challenge nobody could answer. Refusing is the
  // honest outcome; pretending it was raised would leave a code box that can never succeed.
  if (cookie === null) return problemResponse(UNAVAILABLE_PROBLEM, 503);

  const response = jsonResponse({ status: 'ok' });
  response.headers.append('set-cookie', cookie);
  return response;
}

/**
 * `POST /api/auth/totp/verify` — submit the code.
 *
 * The factor, the challenge and the operation come from the cookie; only the code comes from the page.
 * On success the provider's `aal2` session replaces the admin cookies and the challenge cookie is
 * cleared, because it has nothing left to authorise.
 */
export async function handleTotpVerify(
  request: Request,
  options: TotpHandlerOptions = {},
): Promise<Response> {
  const accepted = accept(request);
  if ('refusal' in accepted) return accepted.refusal;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return problemResponse(VALIDATION_PROBLEM, 400);
  }

  const challenge = readTotpChallengeCookie(request.headers.get('cookie'));
  if (challenge === null) {
    const refused = problemResponse(CHALLENGE_REQUIRED_PROBLEM, 401);
    refused.headers.append('set-cookie', clearedTotpChallengeCookie());
    return refused;
  }

  const upstream = await callApi(
    '/v1/auth/totp/verify',
    'POST',
    {
      factorId: challenge.factorId,
      challengeId: challenge.challengeId,
      code: (body as { code?: unknown } | null)?.code,
      ...(challenge.operation === null ? {} : { operation: challenge.operation }),
    },
    accepted.token,
    options,
  );
  if (upstream === null) return problemResponse(UNAVAILABLE_PROBLEM, 503);

  if (!upstream.ok) {
    const failed = forwardProblem(upstream);
    // A 401 is the API's one answer for a refused code, an expired challenge, one already spent and a
    // factor that is not the caller's. The BFF cannot tell them apart — that is the point — so it treats
    // every one as the end of this challenge. A throttle or an outage leaves the cookie: those are worth
    // retrying, and the challenge may still be good.
    if (upstream.status === 401) failed.headers.append('set-cookie', clearedTotpChallengeCookie());
    return failed;
  }

  const session = parsed(upstream.text)?.['session'];
  const tokens = typeof session === 'object' && session !== null ? (session as Record<string, unknown>) : null;
  const accessToken = tokens?.['accessToken'];
  const refreshToken = tokens?.['refreshToken'];
  if (typeof accessToken !== 'string' || accessToken === '' || typeof refreshToken !== 'string' || refreshToken === '') {
    return problemResponse(UNAVAILABLE_PROBLEM, 503);
  }

  // Built from a literal. The upstream body — the only place the session exists — is dropped here.
  const response = jsonResponse({ status: 'verified' });
  for (const cookie of sessionCookies({ accessToken, refreshToken })) {
    response.headers.append('set-cookie', cookie);
  }
  response.headers.append('set-cookie', clearedTotpChallengeCookie());
  return response;
}
