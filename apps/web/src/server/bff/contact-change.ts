import 'server-only';
import { PROBLEM_JSON_MEDIA_TYPE, SESSION_TOKEN_HEADER } from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import {
  clearedContactChallengeCookie,
  contactChallengeCookie,
  readContactChallengeCookie,
} from './contact-challenge-cookie';
import { addressedOrigin, checkSameOrigin } from './origin';
import { SESSION_COOKIES } from './session-cookies';

/**
 * The browser half of the F4 phone contact change.
 *
 * Both steps are authenticated, and the session never leaves the server: the access token lives in the
 * `__Host-mp_access` cookie, which JavaScript cannot read, and this module is the only thing that reads
 * it — presenting it to the API on one internal hop. Nothing here sets, clears or refreshes a cookie: a
 * contact change is not a session event.
 *
 * Responses are rebuilt from the fields this layer knows rather than forwarded, so an API body can never
 * grow a field that reaches the browser by accident.
 *
 * The challenge the second step answers is server state, not browser state: the API returns its
 * identifier on the internal hop, this module puts it in the `HttpOnly`
 * `__Host-mp_contact_phone_challenge` cookie, and reads it back itself. The browser is never told which
 * challenge it is answering — its verify request carries a code and nothing else — and a `challengeId`
 * a page tried to send is dropped here rather than forwarded.
 */

const FORBIDDEN_PROBLEM = {
  type: 'about:blank',
  title: 'Forbidden',
  status: 403,
  detail: 'The request could not be processed.',
  instance: '/contact/phone',
  code: 'BAD_REQUEST',
} as const;

const VALIDATION_PROBLEM = {
  type: 'about:blank',
  title: 'Bad Request',
  status: 400,
  detail: 'The request is invalid.',
  instance: '/contact/phone',
  code: 'VALIDATION_FAILED',
} as const;

const SESSION_REQUIRED_PROBLEM = {
  type: 'about:blank',
  title: 'Unauthorized',
  status: 401,
  detail: 'Authentication is required.',
  instance: '/contact/phone',
  code: 'AUTHENTICATION_REQUIRED',
} as const;

const CHALLENGE_REQUIRED_PROBLEM = {
  type: 'about:blank',
  title: 'Unauthorized',
  status: 401,
  detail: 'Authentication failed.',
  instance: '/contact/phone',
  code: 'AUTHENTICATION_FAILED',
} as const;

const UNAVAILABLE_PROBLEM = {
  type: 'about:blank',
  title: 'Service Unavailable',
  status: 503,
  detail: 'The service is temporarily unavailable.',
  instance: '/contact/phone',
  code: 'SERVICE_UNAVAILABLE',
} as const;

function problemResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
  });
}

export interface ContactChangeHandlerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}

/** Reads the caller's access token from the session cookie, or null when there is no session. */
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

/** The Origin/CSRF check, the session and the JSON body — or the response that refuses the request. */
async function accept(
  request: Request,
): Promise<{ body: unknown; token: string } | { refusal: Response }> {
  const origin = checkSameOrigin({
    method: request.method,
    url: addressedOrigin(request),
    headers: request.headers,
  });
  if (!origin.ok) return { refusal: problemResponse(FORBIDDEN_PROBLEM, 403) };

  const token = readSessionToken(request.headers.get('cookie'));
  if (token === null) return { refusal: problemResponse(SESSION_REQUIRED_PROBLEM, 401) };

  try {
    return { body: await request.json(), token };
  } catch {
    return { refusal: problemResponse(VALIDATION_PROBLEM, 400) };
  }
}

interface Upstream {
  readonly ok: boolean;
  readonly status: number;
  readonly text: string;
}

/** Posts to the API with the internal credential and the caller's token, or reports it unreachable. */
async function callApi(
  path: string,
  body: unknown,
  token: string,
  options: ContactChangeHandlerOptions,
): Promise<Upstream | null> {
  const config = readBffConfig(options.env);
  const call = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);
  try {
    const response = await call(`${config.apiBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_TOKEN_HEADER]: token },
      body: JSON.stringify(body),
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

/**
 * `POST /api/auth/contact/phone/start`.
 *
 * Forwards the new number and returns the challenge identifier the second step needs. The identifier is
 * opaque and useless on its own: the code itself went to the number being claimed.
 */
export async function handleContactPhoneStart(
  request: Request,
  options: ContactChangeHandlerOptions = {},
): Promise<Response> {
  const accepted = await accept(request);
  if ('refusal' in accepted) return accepted.refusal;

  // Only the phone is forwarded: a field the browser adds — an account id, say — is dropped here and
  // would be refused by the API's strict schema anyway.
  const phone = (accepted.body as { phone?: unknown } | null)?.phone;
  const upstream = await callApi('/v1/users/me/contact/phone/start', { phone }, accepted.token, options);
  if (upstream === null) return problemResponse(UNAVAILABLE_PROBLEM, 503);
  if (!upstream.ok) return forwardProblem(upstream);

  const challengeId = readChallengeId(upstream.text);
  if (challengeId === null) return problemResponse(UNAVAILABLE_PROBLEM, 503);

  // The approved browser body, exactly: a status and nothing else. The identifier goes into the cookie.
  const response = new Response(JSON.stringify({ status: 'ok' }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
  response.headers.append('set-cookie', contactChallengeCookie(challengeId));
  return response;
}

/**
 * `POST /api/auth/contact/phone/verify`.
 *
 * Forwards the challenge and the code, and answers with a literal. No cookie is set, cleared or renewed:
 * the person's session is exactly what it was before the change.
 */
export async function handleContactPhoneVerify(
  request: Request,
  options: ContactChangeHandlerOptions = {},
): Promise<Response> {
  const accepted = await accept(request);
  if ('refusal' in accepted) return accepted.refusal;

  // The challenge comes from the cookie, never from the browser's body. A page that sent a
  // `challengeId` would be answering a challenge it chose; this line is why it cannot.
  const challengeId = readContactChallengeCookie(request.headers.get('cookie'));
  if (challengeId === null) {
    const refused = problemResponse(CHALLENGE_REQUIRED_PROBLEM, 401);
    refused.headers.append('set-cookie', clearedContactChallengeCookie());
    return refused;
  }

  const body = accepted.body as { otp?: unknown } | null;
  const upstream = await callApi(
    '/v1/users/me/contact/phone/verify',
    { challengeId, otp: body?.otp },
    accepted.token,
    options,
  );
  if (upstream === null) return problemResponse(UNAVAILABLE_PROBLEM, 503);

  if (!upstream.ok) {
    const failed = forwardProblem(upstream);
    // A 401 is the API's one answer for a refused code, an expired challenge, a spent one, exhausted
    // attempts and a challenge belonging to someone else. The BFF cannot tell them apart — that is the
    // point of the generic answer — so it treats every one of them as the end of this challenge and
    // clears the cookie. A throttle or an outage leaves it in place: those are worth retrying.
    if (upstream.status === 401) failed.headers.append('set-cookie', clearedContactChallengeCookie());
    return failed;
  }

  const response = new Response(JSON.stringify({ status: 'ok' }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
  // Spent: the challenge is consumed and the cookie has nothing left to authorise.
  response.headers.append('set-cookie', clearedContactChallengeCookie());
  return response;
}

/** Reads the challenge identifier out of the API's envelope, or null if it is not the expected shape. */
function readChallengeId(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const challenge = (parsed as Record<string, unknown>)['challenge'];
  if (typeof challenge !== 'object' || challenge === null) return null;
  const id = (challenge as Record<string, unknown>)['id'];
  return typeof id === 'string' && id !== '' ? id : null;
}
