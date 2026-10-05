import 'server-only';
import { PROBLEM_JSON_MEDIA_TYPE } from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { addressedOrigin, checkSameOrigin } from './origin';
import {
  clearedRegisterChallengeCookie,
  readRegisterChallengeCookie,
  registerChallengeCookie,
} from './register-challenge-cookie';

/**
 * The browser half of registration and contact verification (Phase 7-A).
 *
 * Three handlers, one for each approved API route, and four rules that shape all of them.
 *
 * **Nothing the browser receives depends on whether the address was already registered.** The API's start
 * response is identical for a free address and a taken one; this layer reduces it further, to
 * `{ status: 'ok' }`, and sets the challenge cookie **either way**. That last part matters more than it
 * looks: if the cookie were set only when an account had really been created, the verification page would
 * behave differently for the two cases before the person typed anything, and the difference would be
 * visible. Setting it always means the page looks and behaves the same, and any code typed into it earns
 * the same refusal.
 *
 * **The challenge is server state.** The API returns its identifier on the internal hop; this module puts
 * it in the `HttpOnly` `__Host-mp_register_challenge` cookie and reads it back itself. The browser is never
 * told which challenge it is answering — its verify request carries a code and nothing else — and a
 * `challengeId` a page tried to send is dropped here rather than forwarded.
 *
 * **No session is created.** VERIFY FIRST: neither handler sets, clears or refreshes a session cookie, and
 * no response carries a token. A verified account goes to the sign-in page and signs in like anyone else.
 *
 * **Responses are rebuilt, not forwarded.** Every success body is a literal assembled here, so an API body
 * cannot grow a field that reaches the browser by accident. Problems are forwarded, because their wording
 * and codes are already the approved generic ones.
 *
 * One asymmetry is left in deliberately, because removing it would mean inventing a rule the repository
 * has not approved: the resend can only succeed for a registration that really exists, so a resend answers
 * 200 where a registration that was never created answers 401. This is precisely the shape F3's approved
 * recovery flow already has — its start answers 200 for an unknown identifier but can only be rate-limited
 * on the path that actually sends — so 7-A matches the established standard rather than exceeding it on my
 * own initiative. It is noted here so a future reader finds it stated rather than hidden.
 */

const FORBIDDEN_PROBLEM = {
  type: 'about:blank',
  title: 'Forbidden',
  status: 403,
  detail: 'The request could not be processed.',
  instance: '/auth/register',
  code: 'BAD_REQUEST',
} as const;

const VALIDATION_PROBLEM = {
  type: 'about:blank',
  title: 'Bad Request',
  status: 400,
  detail: 'The request is invalid.',
  instance: '/auth/register',
  code: 'VALIDATION_FAILED',
} as const;

const CHALLENGE_REQUIRED_PROBLEM = {
  type: 'about:blank',
  title: 'Unauthorized',
  status: 401,
  detail: 'Authentication failed.',
  instance: '/auth/register',
  code: 'AUTHENTICATION_FAILED',
} as const;

const UNAVAILABLE_PROBLEM = {
  type: 'about:blank',
  title: 'Service Unavailable',
  status: 503,
  detail: 'The service is temporarily unavailable.',
  instance: '/auth/register',
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

export interface RegisterHandlerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}

interface Upstream {
  readonly ok: boolean;
  readonly status: number;
  readonly text: string;
}

/** Posts to the API with the internal credential, or reports that it could not be reached. */
async function callApi(
  path: string,
  body: unknown,
  options: RegisterHandlerOptions,
): Promise<Upstream | null> {
  const config = readBffConfig(options.env);
  const call = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);
  try {
    const response = await call(`${config.apiBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { ok: response.ok, status: response.status, text: await response.text() };
  } catch {
    return null;
  }
}

/** The Origin/CSRF check and the JSON body, or the response that refuses the request. */
async function accept(request: Request): Promise<{ body: unknown } | { refusal: Response }> {
  const origin = checkSameOrigin({
    method: request.method,
    url: addressedOrigin(request),
    headers: request.headers,
  });
  if (!origin.ok) return { refusal: problemResponse(FORBIDDEN_PROBLEM, 403) };

  try {
    return { body: await request.json() };
  } catch {
    return { refusal: problemResponse(VALIDATION_PROBLEM, 400) };
  }
}

/** Passes an API problem through; its wording and code are already the approved ones. */
function forwardProblem(upstream: Upstream): Response {
  return new Response(upstream.text, {
    status: upstream.status,
    headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
  });
}

/** Reads the challenge identifier out of the API's answer, or null if it is not the expected shape. */
function readChallengeId(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const challengeId = (parsed as Record<string, unknown>)['challengeId'];
  return typeof challengeId === 'string' && challengeId !== '' ? challengeId : null;
}

/**
 * `POST /api/auth/register`.
 *
 * Forwards exactly the four approved fields — a fifth the page tried to add is dropped here and would be
 * refused by the API's strict schema anyway — and answers with a status and nothing else. The challenge
 * goes into the cookie.
 */
export async function handleRegister(
  request: Request,
  options: RegisterHandlerOptions = {},
): Promise<Response> {
  const accepted = await accept(request);
  if ('refusal' in accepted) return accepted.refusal;

  const body = accepted.body as Record<string, unknown> | null;
  const upstream = await callApi(
    '/v1/auth/register',
    {
      email: body?.['email'],
      phone: body?.['phone'],
      password: body?.['password'],
      ...(body?.['displayName'] === undefined ? {} : { displayName: body['displayName'] }),
    },
    options,
  );
  if (upstream === null) return problemResponse(UNAVAILABLE_PROBLEM, 503);
  if (!upstream.ok) return forwardProblem(upstream);

  const challengeId = readChallengeId(upstream.text);
  if (challengeId === null) return problemResponse(UNAVAILABLE_PROBLEM, 503);

  // The approved browser body, exactly: a status and nothing else. Not even the identifier, so there is
  // nothing in the response a page could compare between one address and another.
  const response = okResponse();
  response.headers.append('set-cookie', registerChallengeCookie(challengeId));
  return response;
}

/**
 * `POST /api/auth/register/resend`.
 *
 * The challenge comes from the cookie, never from the browser. A resend issues a fresh challenge, so the
 * cookie is replaced with the new identifier; a refusal that ends the challenge clears it, and a throttle
 * or an outage leaves it alone, because those are worth retrying.
 */
export async function handleRegisterResend(
  request: Request,
  options: RegisterHandlerOptions = {},
): Promise<Response> {
  const accepted = await accept(request);
  if ('refusal' in accepted) return accepted.refusal;

  const challengeId = readRegisterChallengeCookie(request.headers.get('cookie'));
  if (challengeId === null) {
    const refused = problemResponse(CHALLENGE_REQUIRED_PROBLEM, 401);
    refused.headers.append('set-cookie', clearedRegisterChallengeCookie());
    return refused;
  }

  const upstream = await callApi('/v1/auth/register/resend', { challengeId }, options);
  if (upstream === null) return problemResponse(UNAVAILABLE_PROBLEM, 503);

  if (!upstream.ok) {
    const failed = forwardProblem(upstream);
    // A 401 is the API's one answer for a challenge that resolves nothing — unknown, spent, of another
    // purpose, or belonging to an account that has already confirmed a contact. The BFF cannot tell those
    // apart, which is the point, so it treats every one as the end of this challenge.
    if (upstream.status === 401) failed.headers.append('set-cookie', clearedRegisterChallengeCookie());
    return failed;
  }

  const fresh = readChallengeId(upstream.text);
  if (fresh === null) return problemResponse(UNAVAILABLE_PROBLEM, 503);

  const response = okResponse();
  response.headers.append('set-cookie', registerChallengeCookie(fresh));
  return response;
}

/**
 * `POST /api/auth/register/verify`.
 *
 * Forwards the challenge from the cookie and the code from the body, and answers with a literal. No
 * session cookie is set: a confirmed contact is permission to sign in, not a sign-in.
 */
export async function handleRegisterVerify(
  request: Request,
  options: RegisterHandlerOptions = {},
): Promise<Response> {
  const accepted = await accept(request);
  if ('refusal' in accepted) return accepted.refusal;

  // A page that sent a `challengeId` would be answering a challenge it chose; this line is why it cannot.
  const challengeId = readRegisterChallengeCookie(request.headers.get('cookie'));
  if (challengeId === null) {
    const refused = problemResponse(CHALLENGE_REQUIRED_PROBLEM, 401);
    refused.headers.append('set-cookie', clearedRegisterChallengeCookie());
    return refused;
  }

  const body = accepted.body as { otp?: unknown } | null;
  const upstream = await callApi('/v1/auth/register/verify', { challengeId, otp: body?.otp }, options);
  if (upstream === null) return problemResponse(UNAVAILABLE_PROBLEM, 503);

  if (!upstream.ok) {
    const failed = forwardProblem(upstream);
    if (upstream.status === 401) failed.headers.append('set-cookie', clearedRegisterChallengeCookie());
    return failed;
  }

  const response = new Response(JSON.stringify({ status: 'verified' }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
  // Spent: the challenge is consumed and the cookie has nothing left to authorise.
  response.headers.append('set-cookie', clearedRegisterChallengeCookie());
  return response;
}
