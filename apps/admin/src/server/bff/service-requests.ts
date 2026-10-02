import 'server-only';
import {
  AdminServiceRequestDecisionResponseSchema,
  AdminServiceRequestDetailResponseSchema,
  AdminServiceRequestsResponseSchema,
  PROBLEM_JSON_MEDIA_TYPE,
  SERVICE_REQUEST_STATUSES,
  SESSION_TOKEN_HEADER,
  ServiceRequestPaymentInformationResponseSchema,
  type AdminServiceRequestDetail,
  type AdminServiceRequestsResponse,
  type ServiceRequestPaymentInformation,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readAdminAccessToken } from './staff-session';

/**
 * The Admin Only service request surface, on the admin origin — Option 2 (Phase 7-J).
 *
 * Three reads a page performs before it renders, and one write. The rules are 7-F's and 7-G's, applied to a
 * surface that carries somebody's brief and, behind a second permission, two sentences about how they would
 * like to pay.
 *
 * **The session never leaves the server.** The caller's access token lives in `__Host-mp_admin_access`, which
 * JavaScript cannot read; it is presented to the API on one internal hop in the session-token header, and the
 * browser's own `Cookie` header is never forwarded.
 *
 * **Nothing about the caller crosses in a request.** No account, no role, no permission and no assurance level
 * appears in anything built here. The only value that crosses is the request a staff member is looking at.
 *
 * **The payment information is a separate read, and its absence is the point.** It is fetched by its own
 * function, from its own endpoint, which the API refuses to anybody without
 * `service_requests.payment_info.read`. A page that holds only the request permission receives `notFound` from
 * it and renders no section — so the fields are **absent from the document**, not hidden in it. There is no
 * branch here that could include them by mistake, because the request read has no field for them at all.
 *
 * **Answers are validated, not forwarded.** A drifted body becomes a clean failure rather than a
 * half-rendered screen, and a payment field the request contract does not name could not reach a page even if
 * the API somehow sent one.
 *
 * **A refusal is not an outage, and an outage is not a refusal.** They stay distinct, because a console that
 * rendered "no such request" during a database hiccup would send somebody looking for a case that is waiting.
 *
 * **Nothing here logs.** A brief is somebody's project and the payment fields are their own words; the way to
 * keep either out of a log is to have no log line that could take it.
 */

const PROBLEM = {
  type: 'about:blank',
  status: 503,
  title: 'Service Unavailable',
  detail: 'The service is temporarily unavailable.',
  instance: '/admin',
  code: 'SERVICE_UNAVAILABLE',
} as const;

function problemResponse(status: number, title: string, code: string, detail: string): Response {
  return new Response(JSON.stringify({ ...PROBLEM, status, title, code, detail }), {
    status,
    headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
  });
}

export interface AdminServiceRequestOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

/**
 * What a read resolved to.
 *
 * `notFound` is the API's one neutral answer: no such request, a seller-routed one, or a caller who holds
 * neither the request permission nor — for the payment read — the payment one. The console does not try to tell
 * those apart, because the API deliberately does not.
 */
export type AdminServiceRequestResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' };

const STATUSES = new Set<string>(SERVICE_REQUEST_STATUSES);

/** base64url, which is the whole of what a cursor can be. Refused here rather than forwarded. */
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function read<T>(
  path: string,
  options: AdminServiceRequestOptions,
  parse: (body: unknown) => { success: true; data: T } | { success: false },
): Promise<AdminServiceRequestResult<T>> {
  const accessToken = readAdminAccessToken(options.cookieHeader ?? null);
  if (accessToken === null) return { kind: 'unauthenticated' };

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}${path}`, {
      method: 'GET',
      headers: { [SESSION_TOKEN_HEADER]: accessToken },
    });
  } catch {
    return { kind: 'unavailable' };
  }

  if (!upstream.ok) {
    await upstream.text().catch(() => '');
    if (upstream.status === 401) return { kind: 'unauthenticated' };
    if (upstream.status === 404) return { kind: 'notFound' };
    if (upstream.status === 400) return { kind: 'invalid' };
    return { kind: 'unavailable' };
  }

  try {
    const parsed = parse(JSON.parse(await upstream.text()));
    return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/**
 * One page of the Admin Only queue, oldest first.
 *
 * Both inputs are checked here rather than forwarded: a status the schema does not define and a cursor that is
 * not a cursor never reach the API, so a mistyped address is a clean first page instead of a round trip that
 * ends in a problem document.
 */
export async function readAdminServiceRequests(
  input: { readonly status?: string | null; readonly cursor?: string | null } = {},
  options: AdminServiceRequestOptions = {},
): Promise<AdminServiceRequestResult<AdminServiceRequestsResponse>> {
  const query = new URLSearchParams();
  if (typeof input.status === 'string' && STATUSES.has(input.status)) query.set('status', input.status);
  if (typeof input.cursor === 'string' && CURSOR_PATTERN.test(input.cursor)) {
    // Passed along as text. This layer does not know what a cursor contains and must not learn.
    query.set('cursor', input.cursor);
  }
  const suffix = query.toString() === '' ? '' : `?${query.toString()}`;

  return await read<AdminServiceRequestsResponse>(
    `/v1/admin/service-requests${suffix}`,
    options,
    (body) => AdminServiceRequestsResponseSchema.safeParse(body),
  );
}

/** One Admin Only request, in full. Carries neither payment field: the contract has no place for one. */
export async function readAdminServiceRequest(
  requestId: string,
  options: AdminServiceRequestOptions = {},
): Promise<AdminServiceRequestResult<AdminServiceRequestDetail>> {
  if (!UUID_PATTERN.test(requestId)) return { kind: 'notFound' };

  const result = await read(
    `/v1/admin/service-requests/${encodeURIComponent(requestId.toLowerCase())}`,
    options,
    (body) => AdminServiceRequestDetailResponseSchema.safeParse(body),
  );
  return result.kind === 'ok' ? { kind: 'ok', data: result.data.request } : result;
}

/**
 * The two descriptive payment fields (D7-09).
 *
 * A **separate read**, so the section it feeds is either rendered or not rendered at all. `notFound` covers
 * both "this caller may not" and "there is no such request", which is what the API answers for each — so a
 * page that gets it renders nothing rather than an empty Payment Information heading that would tell a
 * colleague there was something they could not see.
 */
export async function readServiceRequestPaymentInformation(
  requestId: string,
  options: AdminServiceRequestOptions = {},
): Promise<AdminServiceRequestResult<ServiceRequestPaymentInformation>> {
  if (!UUID_PATTERN.test(requestId)) return { kind: 'notFound' };

  const result = await read(
    `/v1/admin/service-requests/${encodeURIComponent(requestId.toLowerCase())}/payment-information`,
    options,
    (body) => ServiceRequestPaymentInformationResponseSchema.safeParse(body),
  );
  return result.kind === 'ok' ? { kind: 'ok', data: result.data.paymentInformation } : result;
}

/**
 * `POST /api/service-requests/decline` — the approved staff closure.
 *
 * The body is rebuilt from exactly one field, a request identifier, which is a value the staff member is
 * already looking at rather than an authorization: the API resolves them from their own session and the
 * database refuses the write for anybody without `service_requests.request.manage` in a strong enough session.
 *
 * There is no reason field, because the approved decision records none, and no status field, because the
 * transition is named by the operation rather than chosen by the caller.
 */
export async function handleAdminServiceRequestDecline(
  request: Request,
  options: AdminServiceRequestOptions = {},
): Promise<Response> {
  const origin = checkSameOrigin({
    method: request.method,
    url: addressedOrigin(request),
    headers: request.headers,
  });
  if (!origin.ok) {
    return problemResponse(403, 'Forbidden', 'BAD_REQUEST', 'The request could not be processed.');
  }

  const accessToken = readAdminAccessToken(options.cookieHeader ?? request.headers.get('cookie'));
  if (accessToken === null) {
    return problemResponse(401, 'Unauthorized', 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  }

  let body: unknown;
  try {
    const raw = await request.text();
    body = raw === '' ? {} : JSON.parse(raw);
  } catch {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }

  const requestId = ((body ?? {}) as Record<string, unknown>)['requestId'];
  if (typeof requestId !== 'string' || !UUID_PATTERN.test(requestId)) {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    // No body at all: the transition is the path, and there is nothing else to say.
    upstream = await fetcher(
      `${config.apiBaseUrl}/v1/admin/service-requests/${encodeURIComponent(requestId.toLowerCase())}/decline`,
      { method: 'POST', headers: { [SESSION_TOKEN_HEADER]: accessToken } },
    );
  } catch {
    return problemResponse(
      503,
      'Service Unavailable',
      'SERVICE_UNAVAILABLE',
      'The service is temporarily unavailable.',
    );
  }

  const text = await upstream.text();
  if (upstream.status !== 200) {
    // 404 and 409 are the two a screen must act on: not yours to close, and already closed. Anything else
    // becomes the generic outage, so an unexpected status can never arrive as a closure.
    if (![400, 401, 403, 404, 409].includes(upstream.status)) {
      return problemResponse(
        503,
        'Service Unavailable',
        'SERVICE_UNAVAILABLE',
        'The service is temporarily unavailable.',
      );
    }
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return problemResponse(
      503,
      'Service Unavailable',
      'SERVICE_UNAVAILABLE',
      'The service is temporarily unavailable.',
    );
  }
  const validated = AdminServiceRequestDecisionResponseSchema.safeParse(parsed);
  if (!validated.success) {
    return problemResponse(
      503,
      'Service Unavailable',
      'SERVICE_UNAVAILABLE',
      'The service is temporarily unavailable.',
    );
  }

  return new Response(JSON.stringify(validated.data), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
