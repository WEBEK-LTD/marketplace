import 'server-only';
import { PROBLEM_JSON_MEDIA_TYPE, RESET_TOKEN_HEADER } from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { addressedOrigin, checkSameOrigin } from './origin';
import { clearedResetCookie, readResetCookie, resetCookie } from './reset-cookie';

/**
 * The browser half of the F3 recovery flow.
 *
 * Three handlers, one for each approved API route, and one rule that shapes all of them: **the reset
 * token never reaches the browser as data.** The API hands it over in a server-to-server body, exactly
 * as it hands over a session at login; this module turns it into the `__Host-mp_reset` cookie and builds
 * the browser's response from a literal. There is no code path that forwards the API's body, so there is
 * none that could forward a token by accident.
 *
 * The link the API builds is used for one thing here: its path. After a successful verification the
 * browser is told where to go next, with the token stripped out, so no reset token is ever in a URL the
 * browser holds, shows, stores in history or sends as a referrer.
 */

const FORBIDDEN_PROBLEM = {
  type: 'about:blank',
  title: 'Forbidden',
  status: 403,
  detail: 'The request could not be processed.',
  instance: '/auth/recovery',
  code: 'BAD_REQUEST',
} as const;

const VALIDATION_PROBLEM = {
  type: 'about:blank',
  title: 'Bad Request',
  status: 400,
  detail: 'The request is invalid.',
  instance: '/auth/recovery',
  code: 'VALIDATION_FAILED',
} as const;

const UNAVAILABLE_PROBLEM = {
  type: 'about:blank',
  title: 'Service Unavailable',
  status: 503,
  detail: 'The service is temporarily unavailable.',
  instance: '/auth/recovery',
  code: 'SERVICE_UNAVAILABLE',
} as const;

/** Where the browser is sent once the cookie is set. A path on this origin, never a URL with a token. */
const RESET_PAGE_PATH = '/reset-password';

function problemResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
  });
}

export interface RecoveryHandlerOptions {
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
  options: RecoveryHandlerOptions,
  extraHeaders: Record<string, string> = {},
): Promise<Upstream | null> {
  const config = readBffConfig(options.env);
  const call = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);
  try {
    const response = await call(`${config.apiBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extraHeaders },
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

/**
 * `POST /api/auth/recovery/start`.
 *
 * A pass-through in both directions: the API's answer is identical for every identifier, so forwarding
 * it verbatim is what keeps it that way. No cookie is set here — there is nothing to hold yet.
 */
export async function handleRecoveryStart(
  request: Request,
  options: RecoveryHandlerOptions = {},
): Promise<Response> {
  const accepted = await accept(request);
  if ('refusal' in accepted) return accepted.refusal;

  const upstream = await callApi('/v1/auth/recovery/start', accepted.body, options);
  if (upstream === null) return problemResponse(UNAVAILABLE_PROBLEM, 503);

  if (!upstream.ok) {
    return new Response(upstream.text, {
      status: upstream.status,
      headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
    });
  }

  // Rebuilt from the two fields this step has, rather than forwarded: a body assembled here cannot grow
  // a field that says something about the account, however the API changes.
  const challengeId = readChallengeId(upstream.text);
  if (challengeId === null) return problemResponse(UNAVAILABLE_PROBLEM, 503);
  return new Response(JSON.stringify({ status: 'ok', challengeId }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
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
 * `POST /api/auth/recovery/verify` — the exchange.
 *
 * This is where the reset token stops. The API verifies the code server-side and returns the token and
 * the link it built; this handler puts the token in the cookie and answers with `{ status: 'ok' }` and
 * the *path* of that link. The browser navigates there with no token in the URL.
 */
export async function handleRecoveryVerify(
  request: Request,
  options: RecoveryHandlerOptions = {},
): Promise<Response> {
  const accepted = await accept(request);
  if ('refusal' in accepted) return accepted.refusal;

  const upstream = await callApi('/v1/auth/recovery/verify', accepted.body, options);
  if (upstream === null) return problemResponse(UNAVAILABLE_PROBLEM, 503);

  if (!upstream.ok) {
    // The API's problem is already generic. A failed verification also clears any earlier reset cookie:
    // whatever the browser was holding is not the token this flow just refused to issue.
    const failed = new Response(upstream.text, {
      status: upstream.status,
      headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
    });
    failed.headers.append('set-cookie', clearedResetCookie());
    return failed;
  }

  const token = readVerification(upstream.text);
  if (token === null) return problemResponse(UNAVAILABLE_PROBLEM, 503);

  // Built from a literal. The upstream body — the only place the token exists — is dropped here.
  const response = new Response(JSON.stringify({ status: 'ok', next: RESET_PAGE_PATH }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
  response.headers.append('set-cookie', resetCookie(token));
  return response;
}

/**
 * `POST /api/auth/recovery/reset`.
 *
 * The token comes from the cookie, never from the browser's body: whatever the browser posts is reduced
 * to the new password before it is forwarded, and the token is presented to the API in the
 * `x-reset-token` header. On any outcome other than success the cookie is cleared, because a token that
 * was just refused is of no further use to anyone.
 */
export async function handleRecoveryReset(
  request: Request,
  options: RecoveryHandlerOptions = {},
): Promise<Response> {
  const accepted = await accept(request);
  if ('refusal' in accepted) return accepted.refusal;

  const token = readResetCookie(request.headers.get('cookie'));
  if (token === null) {
    // No cookie, no reset. The browser is told the same thing an invalid token earns.
    const refused = problemResponse({ ...VALIDATION_PROBLEM, title: 'Unauthorized', status: 401, code: 'AUTHENTICATION_FAILED', detail: 'Authentication failed.' }, 401);
    refused.headers.append('set-cookie', clearedResetCookie());
    return refused;
  }

  // Only the password is forwarded. A `resetToken` field in the browser's body is dropped here rather
  // than passed on, so the API can never receive a token that came from a browser.
  const newPassword = (accepted.body as { newPassword?: unknown } | null)?.newPassword;
  const upstream = await callApi(
    '/v1/auth/recovery/reset',
    { newPassword },
    options,
    { [RESET_TOKEN_HEADER]: token },
  );
  if (upstream === null) return problemResponse(UNAVAILABLE_PROBLEM, 503);

  const response = new Response(upstream.ok ? JSON.stringify({ status: 'ok' }) : upstream.text, {
    status: upstream.status,
    headers: {
      'content-type': upstream.ok ? 'application/json' : PROBLEM_JSON_MEDIA_TYPE,
      'cache-control': 'no-store',
    },
  });
  // Cleared either way: a spent token is useless, and a refused one must not be retried from a cookie.
  response.headers.append('set-cookie', clearedResetCookie());
  return response;
}

/** Reads the reset token out of the server-to-server envelope, or null if it is not the expected shape. */
function readVerification(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const reset = (parsed as Record<string, unknown>)['reset'];
  if (typeof reset !== 'object' || reset === null) return null;
  const token = (reset as Record<string, unknown>)['token'];
  return typeof token === 'string' && token !== '' ? token : null;
}
