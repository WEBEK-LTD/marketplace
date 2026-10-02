import 'server-only';
import {
  CreateAdminOnlyServiceRequestSchema,
  CreateServiceQuoteSchema,
  CreateServiceRequestSchema,
  PROBLEM_JSON_MEDIA_TYPE,
  SESSION_TOKEN_HEADER,
  ServiceQuoteDecisionResponseSchema,
  ServiceQuoteMutationResponseSchema,
  ServiceRequestDetailResponseSchema,
  ServiceRequestMutationResponseSchema,
  ServiceRequestStatusResponseSchema,
  ServiceRequestsResponseSchema,
  type ServiceRequestDetailResponse,
  type ServiceRequestsResponse,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readAccessToken } from './session-cookies';

/**
 * The BFF half of service requests — Option 1 (Phase 7-I).
 *
 * Three reads a server component calls directly and seven writes a browser posts to. The rules are 7-E's and
 * 7-H's, applied to a surface where the stakes are somebody's project brief, a seller's price for it, and a
 * deadline for paying that price.
 *
 * **The session never leaves the server.** The access token lives in the `__Host-mp_access` cookie, which
 * JavaScript cannot see; it is presented to the API on one internal hop in `x-session-token`, and the
 * browser's own `Cookie` header is never forwarded.
 *
 * **Request bodies are rebuilt, never forwarded.** Each write parses what the page sent, validates it against
 * the shared contract, and sends a body assembled here from the fields that contract names. A page that added
 * a `paymentDueAt`, a `status`, a `sellerUserId`, a `currencyCode` or an `expiresAt` would have it dropped
 * before the request left this origin — and the API's strict schema would refuse it anyway. Two independent
 * walls, neither relying on the other.
 *
 * **A request and a quote are named in the route, never in a body.** Every write takes its subject from the
 * URL path, checked here for shape, and each quote decision is addressed **through its own request** — so
 * there is no field a browser could use to point a decision at somebody else's negotiation, and a quote
 * identifier cannot be spent from the wrong page.
 *
 * **Responses are validated, not forwarded.** A drifted body becomes a clean failure here instead of a
 * half-rendered page, and a field the contract does not name cannot reach a browser even if the API sent one.
 *
 * **Cursors stay opaque.** A cursor is passed along as text and never parsed or reconstructed here: the API
 * owns the format, and a second place that understood it would be a second place that has to agree.
 *
 * **Nothing here logs.** A brief is somebody's project and a quote is a price; the way to keep either out of
 * a log is to have no log line that could take it.
 *
 * Nothing in this file routes anything to staff. Option 2 belongs to 7-J and has no surface here.
 */

/**
 * The one thing this module needs from a contract schema.
 *
 * Structural rather than imported: this app has no dependency on the validation library, and the shared
 * contracts are the only place a schema is written.
 */
interface Validator<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

const PROBLEM = {
  type: 'about:blank',
  status: 503,
  title: 'Service Unavailable',
  detail: 'The service is temporarily unavailable.',
  instance: '/service-requests',
  code: 'SERVICE_UNAVAILABLE',
} as const;

function problemResponse(status: number, title: string, code: string, detail: string): Response {
  return new Response(JSON.stringify({ ...PROBLEM, status, title, code, detail }), {
    status,
    headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
  });
}

const SESSION_REQUIRED = (): Response =>
  problemResponse(401, 'Unauthorized', 'AUTHENTICATION_REQUIRED', 'Authentication is required.');

const UNAVAILABLE = (): Response =>
  problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.');

const VALIDATION_FAILED = (): Response =>
  problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');

/**
 * The statuses the API is allowed to refuse a write with.
 *
 * 404 and 409 are here because this surface has refusals a form must act on: a request or a quote that is not
 * the caller's, one already decided, a quote whose window has passed, a service that cannot be briefed, a
 * fixed-price service that is bought instead. 503 is here too, as it is on offers, because one of its
 * meanings is specific and actionable — the payment window is unusable, so the acceptance did not happen —
 * and a browser told only "unavailable" would not know whether it had. Anything outside the set becomes the
 * generic 503, so an unexpected upstream status can never arrive as a success.
 */
const WRITE_PROBLEM_STATUSES = new Set([400, 401, 403, 404, 409, 429, 503]);

export interface ServiceRequestsHandlerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

/**
 * What a service request read resolved to.
 *
 * `unauthenticated` and `unavailable` are kept apart deliberately: a session that has ended is a different
 * thing from a service that could not answer. `notFound` is the API's one neutral answer for a request that
 * does not exist and for one that is not the caller's, which is why a page renders the same thing for both.
 * `invalid` is the API's cursor refusal, which a page recovers from by dropping the cursor rather than by
 * reporting an outage.
 */
export type ServiceRequestsResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' };

/** A path segment a browser or a route supplied. Checked here so nothing but an identifier reaches a URL. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function identifier(value: string | undefined | null): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

async function callRead(
  path: string,
  accessToken: string,
  options: ServiceRequestsHandlerOptions,
): Promise<Response | null> {
  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);
  try {
    return await fetcher(`${config.apiBaseUrl}${path}`, {
      method: 'GET',
      headers: { [SESSION_TOKEN_HEADER]: accessToken },
    });
  } catch {
    return null;
  }
}

/** One read, validated against the contract before any of it is returned. */
async function read<T>(
  path: string,
  schema: Validator<T>,
  options: ServiceRequestsHandlerOptions,
): Promise<ServiceRequestsResult<T>> {
  const accessToken = readAccessToken(options.cookieHeader ?? null);
  if (accessToken === null) return { kind: 'unauthenticated' };

  const upstream = await callRead(path, accessToken, options);
  if (upstream === null) return { kind: 'unavailable' };
  if (!upstream.ok) {
    await upstream.text().catch(() => '');
    if (upstream.status === 401) return { kind: 'unauthenticated' };
    if (upstream.status === 404) return { kind: 'notFound' };
    if (upstream.status === 400) return { kind: 'invalid' };
    return { kind: 'unavailable' };
  }

  try {
    const parsed = schema.safeParse(JSON.parse(await upstream.text()));
    return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** Builds the query string from what the caller passed, dropping what it did not. */
function query(input: { limit?: string | null; cursor?: string | null }): string {
  const params = new URLSearchParams();
  if (input.limit !== undefined && input.limit !== null && input.limit !== '') {
    params.set('limit', input.limit);
  }
  // Passed through verbatim. This layer does not know what a cursor contains and must not learn.
  if (input.cursor !== undefined && input.cursor !== null && input.cursor !== '') {
    params.set('cursor', input.cursor);
  }
  return params.size === 0 ? '' : `?${params.toString()}`;
}

/* ------------------------------------------------------------------------------------------------ */
/* Reads                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

/** The briefs the caller has sent, as a buyer. */
export async function readServiceRequestsMade(
  input: { limit?: string | null; cursor?: string | null } = {},
  options: ServiceRequestsHandlerOptions = {},
): Promise<ServiceRequestsResult<ServiceRequestsResponse>> {
  return await read(`/v1/service-requests/made${query(input)}`, ServiceRequestsResponseSchema, options);
}

/** The briefs sent to the caller's storefront. A separate operation, so neither page can show the other. */
export async function readServiceRequestsReceived(
  input: { limit?: string | null; cursor?: string | null } = {},
  options: ServiceRequestsHandlerOptions = {},
): Promise<ServiceRequestsResult<ServiceRequestsResponse>> {
  return await read(`/v1/service-requests/received${query(input)}`, ServiceRequestsResponseSchema, options);
}

/**
 * One brief in full, with its quotes, for whichever side is asking.
 *
 * A malformed identifier is `notFound` here rather than a validation failure: the value came from the
 * address somebody typed, and the honest answer to a made-up address is that there is nothing at it. The
 * detail itself reports which side the caller is on; this layer derives nothing.
 */
export async function readServiceRequestDetail(
  requestId: string | undefined,
  options: ServiceRequestsHandlerOptions = {},
): Promise<ServiceRequestsResult<ServiceRequestDetailResponse>> {
  const id = identifier(requestId);
  if (id === null) return { kind: 'notFound' };
  return await read(
    `/v1/service-requests/${encodeURIComponent(id)}`,
    ServiceRequestDetailResponseSchema,
    options,
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Writes                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

/** The Origin/CSRF check, the session and the parsed body, or the response that refuses the request. */
async function acceptWrite(
  request: Request,
  options: ServiceRequestsHandlerOptions,
): Promise<{ accessToken: string; body: unknown } | { refusal: Response }> {
  const origin = checkSameOrigin({
    method: request.method,
    url: addressedOrigin(request),
    headers: request.headers,
  });
  if (!origin.ok) {
    return {
      refusal: problemResponse(403, 'Forbidden', 'BAD_REQUEST', 'The request could not be processed.'),
    };
  }

  const accessToken = readAccessToken(options.cookieHeader ?? request.headers.get('cookie'));
  if (accessToken === null) return { refusal: SESSION_REQUIRED() };

  const raw = await request.text().catch(() => '');
  if (raw === '') return { accessToken, body: {} };
  try {
    return { accessToken, body: JSON.parse(raw) };
  } catch {
    return { refusal: VALIDATION_FAILED() };
  }
}

async function callWrite(
  path: string,
  accessToken: string,
  body: unknown,
  options: ServiceRequestsHandlerOptions,
): Promise<Response | null> {
  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);
  try {
    return await fetcher(`${config.apiBaseUrl}${path}`, {
      method: 'POST',
      headers:
        body === undefined
          ? { [SESSION_TOKEN_HEADER]: accessToken }
          : { 'content-type': 'application/json', [SESSION_TOKEN_HEADER]: accessToken },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return null;
  }
}

/**
 * Turns one upstream write response into the browser's.
 *
 * A recognised refusal is forwarded with the API's own problem body, so a form can say "this service is
 * bought directly rather than quoted" or "this has already been decided" rather than a generic failure.
 * Anything else becomes the generic 503. Success is the expected status exactly, and its body is re-validated
 * before a single byte of it reaches a browser.
 */
async function writeOutcome<T>(
  upstream: Response | null,
  expected: number,
  schema: Validator<T>,
): Promise<Response> {
  if (upstream === null) return UNAVAILABLE();

  const text = await upstream.text();
  if (upstream.status !== expected) {
    if (!WRITE_PROBLEM_STATUSES.has(upstream.status)) return UNAVAILABLE();
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return UNAVAILABLE();
  }
  const validated = schema.safeParse(parsed);
  if (!validated.success) return UNAVAILABLE();

  return new Response(JSON.stringify(validated.data), {
    status: expected,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * `POST /api/service-requests` — send one brief.
 *
 * Rebuilt from the contract, so exactly a listing, a title, a brief and optionally a budget and a date
 * cross. A seller, a currency, a status, an acceptance time, a payment deadline or anything that looks like
 * routing is dropped here and would be refused upstream as well.
 */
export async function handleCreateServiceRequest(
  request: Request,
  options: ServiceRequestsHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const fields = (accepted.body ?? {}) as Record<string, unknown>;
  const validated = CreateServiceRequestSchema.safeParse({
    listingId: fields['listingId'],
    title: fields['title'],
    brief: fields['brief'],
    // Both are optional in the contract, and an empty form field is an absence rather than a value.
    ...(typeof fields['budgetMinor'] === 'string' && fields['budgetMinor'].trim() !== ''
      ? { budgetMinor: fields['budgetMinor'].trim() }
      : {}),
    ...(typeof fields['neededBy'] === 'string' && fields['neededBy'].trim() !== ''
      ? { neededBy: fields['neededBy'].trim() }
      : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite('/v1/service-requests', accepted.accessToken, validated.data, options);
  return await writeOutcome(upstream, 201, ServiceRequestMutationResponseSchema);
}

/**
 * `POST /api/service-requests/admin-only` — send a brief for the platform to handle (Phase 7-J).
 *
 * Rebuilt from the contract, so exactly a title, a brief, how they would prefer to pay, and optionally a
 * budget and a date cross. **There is no listing, no seller, no currency and no routing field**, and a page
 * that added one would have it dropped here and refused upstream as well: the server decides which flow a
 * brief belongs to, by which operation was called.
 *
 * The two payment fields are descriptive text. They are passed through as written and go nowhere else.
 */
export async function handleCreateAdminOnlyServiceRequest(
  request: Request,
  options: ServiceRequestsHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const fields = (accepted.body ?? {}) as Record<string, unknown>;
  const validated = CreateAdminOnlyServiceRequestSchema.safeParse({
    title: fields['title'],
    brief: fields['brief'],
    preferredPaymentMethod: fields['preferredPaymentMethod'],
    // An empty form field is an absence rather than a value, on all three optional fields.
    ...(typeof fields['paymentNotes'] === 'string' && fields['paymentNotes'].trim() !== ''
      ? { paymentNotes: fields['paymentNotes'].trim() }
      : {}),
    ...(typeof fields['budgetMinor'] === 'string' && fields['budgetMinor'].trim() !== ''
      ? { budgetMinor: fields['budgetMinor'].trim() }
      : {}),
    ...(typeof fields['neededBy'] === 'string' && fields['neededBy'].trim() !== ''
      ? { neededBy: fields['neededBy'].trim() }
      : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    '/v1/service-requests/admin-only',
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 201, ServiceRequestMutationResponseSchema);
}

/**
 * `POST /api/service-requests/{requestId}/quotes` — answer one brief with a price.
 *
 * The brief is the one in the route; the contract has no `serviceRequestId`, so a quote cannot be pointed at
 * a different brief. `validForDays` is how long the quote stands and is the only duration a seller states;
 * the payment deadline is derived in the database on acceptance and appears nowhere in this body.
 */
export async function handleCreateServiceQuote(
  request: Request,
  requestId: string | undefined,
  options: ServiceRequestsHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(requestId);
  if (id === null) return VALIDATION_FAILED();

  const fields = (accepted.body ?? {}) as Record<string, unknown>;
  const validated = CreateServiceQuoteSchema.safeParse({
    amountMinor: fields['amountMinor'],
    deliveryDays: fields['deliveryDays'],
    ...(fields['revisionsIncluded'] === undefined
      ? {}
      : { revisionsIncluded: fields['revisionsIncluded'] }),
    scope: fields['scope'],
    validForDays: fields['validForDays'],
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    `/v1/service-requests/${encodeURIComponent(id)}/quotes`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 201, ServiceQuoteMutationResponseSchema);
}

/**
 * The two request closures that take no body at all.
 *
 * One helper, because they differ only in the segment they address and in who the database will let
 * through — and neither of those is this layer's to decide. Whatever a page put in the body is dropped:
 * nothing is forwarded.
 */
async function handleRequestClosure(
  step: 'cancel' | 'decline',
  request: Request,
  requestId: string | undefined,
  options: ServiceRequestsHandlerOptions,
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(requestId);
  if (id === null) return VALIDATION_FAILED();

  const upstream = await callWrite(
    `/v1/service-requests/${encodeURIComponent(id)}/${step}`,
    accepted.accessToken,
    undefined,
    options,
  );
  return await writeOutcome(upstream, 200, ServiceRequestStatusResponseSchema);
}

/** `POST /api/service-requests/{requestId}/cancel` — the buyer withdraws their own brief. */
export async function handleCancelServiceRequest(
  request: Request,
  requestId: string | undefined,
  options: ServiceRequestsHandlerOptions = {},
): Promise<Response> {
  return await handleRequestClosure('cancel', request, requestId, options);
}

/** `POST /api/service-requests/{requestId}/decline` — the seller declines to quote. */
export async function handleDeclineServiceRequest(
  request: Request,
  requestId: string | undefined,
  options: ServiceRequestsHandlerOptions = {},
): Promise<Response> {
  return await handleRequestClosure('decline', request, requestId, options);
}

/**
 * The three quote decisions, each addressed through its own brief.
 *
 * Both identifiers are checked for shape and both travel in the path, so the API can refuse a quote that
 * belongs to a different brief. Which side may take which step is the database's to decide, not this
 * layer's.
 */
async function handleQuoteDecision(
  step: 'accept' | 'reject' | 'withdraw',
  request: Request,
  requestId: string | undefined,
  quoteId: string | undefined,
  options: ServiceRequestsHandlerOptions,
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(requestId);
  const quote = identifier(quoteId);
  if (id === null || quote === null) return VALIDATION_FAILED();

  const upstream = await callWrite(
    `/v1/service-requests/${encodeURIComponent(id)}/quotes/${encodeURIComponent(quote)}/${step}`,
    accepted.accessToken,
    undefined,
    options,
  );
  return await writeOutcome(upstream, 200, ServiceQuoteDecisionResponseSchema);
}

/** The buyer accepts a quote. The only step that records a payment obligation. */
export async function handleAcceptServiceQuote(
  request: Request,
  requestId: string | undefined,
  quoteId: string | undefined,
  options: ServiceRequestsHandlerOptions = {},
): Promise<Response> {
  return await handleQuoteDecision('accept', request, requestId, quoteId, options);
}

/** The buyer declines one quote. The brief stays open to another. */
export async function handleRejectServiceQuote(
  request: Request,
  requestId: string | undefined,
  quoteId: string | undefined,
  options: ServiceRequestsHandlerOptions = {},
): Promise<Response> {
  return await handleQuoteDecision('reject', request, requestId, quoteId, options);
}

/** The seller takes their own quote back. */
export async function handleWithdrawServiceQuote(
  request: Request,
  requestId: string | undefined,
  quoteId: string | undefined,
  options: ServiceRequestsHandlerOptions = {},
): Promise<Response> {
  return await handleQuoteDecision('withdraw', request, requestId, quoteId, options);
}
