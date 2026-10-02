import 'server-only';
import {
  CounterOfferRequestSchema,
  CreateOfferRequestSchema,
  OfferDecisionResponseSchema,
  OfferMutationResponseSchema,
  OffersResponseSchema,
  PROBLEM_JSON_MEDIA_TYPE,
  SESSION_TOKEN_HEADER,
  SellerOffersResponseSchema,
  type OffersResponse,
  type SellerOffersResponse,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readAccessToken } from './session-cookies';

/**
 * The BFF half of offers (Phase 7-H).
 *
 * Two reads a server component calls directly and five writes a browser posts to. The rules are 7-E's,
 * applied to a surface where the stakes are a price two people agreed and a deadline for paying it.
 *
 * **The session never leaves the server.** The access token lives in the `__Host-mp_access` cookie, which
 * JavaScript cannot see; it is presented to the API on one internal hop in `x-session-token`, and the
 * browser's own `Cookie` header is never forwarded.
 *
 * **Request bodies are rebuilt, never forwarded.** Each write parses what the page sent, validates it
 * against the shared contract, and sends a body assembled here from the fields that contract names. A page
 * that added a `paymentDueAt`, a `status`, a `sellerUserId` or a `parentOfferId` would have it dropped
 * before the request left this origin — and the API's strict schema would refuse it anyway, which is the
 * point: two independent walls, neither relying on the other.
 *
 * **An offer is named in the route, never in a body.** The four transitions and the counter take their
 * subject from the URL path, checked here for shape, so there is no field a browser could use to redirect a
 * decision at somebody else's negotiation.
 *
 * **Responses are validated, not forwarded.** A drifted body becomes a clean failure here instead of a
 * half-rendered list, and a field the contract does not name cannot reach a browser even if the API sent
 * one.
 *
 * **Cursors stay opaque.** A cursor is passed along as text and never parsed or reconstructed here: the API
 * owns the format, and a second place that understood it would be a second place that has to agree.
 *
 * **Nothing here logs.** An offer is a price under negotiation; the way to keep one out of a log is to have
 * no log line that could take it.
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
  instance: '/offers',
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
 * 404 and 409 are here because this surface has refusals a form must act on: an offer that is not the
 * caller's, one already decided, one whose window has passed, a listing that cannot be offered on. 503 is
 * here too, unlike on the account surfaces, because one of its meanings is specific and actionable — the
 * payment window is unusable, so the acceptance did not happen — and a browser that was told only
 * "unavailable" would not know whether it had. Anything outside the set becomes the generic 503, so an
 * unexpected upstream status can never arrive as a success.
 */
const WRITE_PROBLEM_STATUSES = new Set([400, 401, 403, 404, 409, 429, 503]);

export interface OffersHandlerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

/**
 * What an offers read resolved to.
 *
 * `unauthenticated` and `unavailable` are kept apart deliberately: a session that has ended is a different
 * thing from a service that could not answer, and a page that conflated them would tell somebody they had
 * been signed out because a database was busy. `invalid` is the API's cursor refusal, which a page recovers
 * from by dropping the cursor rather than by reporting an outage.
 */
export type OffersResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' };

async function callRead(
  path: string,
  accessToken: string,
  options: OffersHandlerOptions,
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
  options: OffersHandlerOptions,
): Promise<OffersResult<T>> {
  const accessToken = readAccessToken(options.cookieHeader ?? null);
  if (accessToken === null) return { kind: 'unauthenticated' };

  const upstream = await callRead(path, accessToken, options);
  if (upstream === null) return { kind: 'unavailable' };
  if (!upstream.ok) {
    await upstream.text().catch(() => '');
    if (upstream.status === 401) return { kind: 'unauthenticated' };
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

/** The offers the caller has made, as a buyer. */
export async function readOffersMade(
  input: { limit?: string | null; cursor?: string | null } = {},
  options: OffersHandlerOptions = {},
): Promise<OffersResult<OffersResponse>> {
  return await read(`/v1/offers/made${query(input)}`, OffersResponseSchema, options);
}

/** The offers made to the caller's storefront. A separate operation, so neither page can show the other. */
export async function readOffersReceived(
  input: { limit?: string | null; cursor?: string | null } = {},
  options: OffersHandlerOptions = {},
): Promise<OffersResult<SellerOffersResponse>> {
  return await read(`/v1/offers/received${query(input)}`, SellerOffersResponseSchema, options);
}

/* ------------------------------------------------------------------------------------------------ */
/* Writes                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

/** The Origin/CSRF check, the session and the parsed body, or the response that refuses the request. */
async function acceptWrite(
  request: Request,
  options: OffersHandlerOptions,
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
  options: OffersHandlerOptions,
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
 * A recognised refusal is forwarded with the API's own problem body, so a form can say "this offer has
 * already been decided" or "you already have an open offer on this listing" rather than a generic failure.
 * Anything else becomes the generic 503. Success is the expected status exactly, and its body is
 * re-validated before a single byte of it reaches a browser.
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

/** A path segment a browser supplied. Checked here so nothing but an identifier reaches a URL. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function identifier(value: string | undefined): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

/**
 * `POST /api/offers` — open an offer.
 *
 * Rebuilt from the contract, so exactly a listing, an amount, a quantity and an optional note cross. A
 * seller, a currency, an expiry, a status, an acceptance time or a payment deadline sent by a page is
 * dropped here and would be refused upstream as well.
 */
export async function handleCreateOffer(
  request: Request,
  options: OffersHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const fields = (accepted.body ?? {}) as Record<string, unknown>;
  const validated = CreateOfferRequestSchema.safeParse({
    listingId: fields['listingId'],
    amountMinor: fields['amountMinor'],
    ...(fields['quantity'] === undefined ? {} : { quantity: fields['quantity'] }),
    ...(typeof fields['message'] === 'string' && fields['message'].trim() !== ''
      ? { message: fields['message'] }
      : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite('/v1/offers', accepted.accessToken, validated.data, options);
  return await writeOutcome(upstream, 201, OfferMutationResponseSchema);
}

/**
 * `POST /api/offers/{offerId}/counter` — replace your own offer.
 *
 * The offer being replaced is the one in the route. There is no `parentOfferId` in the body and the
 * contract has no field for one, so a counter cannot be pointed at a different negotiation.
 */
export async function handleCounterOffer(
  request: Request,
  offerId: string | undefined,
  options: OffersHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(offerId);
  if (id === null) return VALIDATION_FAILED();

  const fields = (accepted.body ?? {}) as Record<string, unknown>;
  const validated = CounterOfferRequestSchema.safeParse({
    amountMinor: fields['amountMinor'],
    ...(fields['quantity'] === undefined ? {} : { quantity: fields['quantity'] }),
    ...(typeof fields['message'] === 'string' && fields['message'].trim() !== ''
      ? { message: fields['message'] }
      : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    `/v1/offers/${encodeURIComponent(id)}/counter`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 201, OfferMutationResponseSchema);
}

/**
 * The three transitions that take no body at all.
 *
 * One handler, because they differ only in the segment they address and in who the database will let
 * through — and neither of those is this layer's to decide. Whatever a page put in the body is dropped:
 * nothing is forwarded.
 */
async function handleDecision(
  // Named `move` deliberately: the CSS build scans these files for utility-class candidates, and the
  // obvious alternative name is also a Tailwind utility, which would make it emit a rule nothing asked for.
  move: 'accept' | 'reject' | 'withdraw',
  request: Request,
  offerId: string | undefined,
  options: OffersHandlerOptions,
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(offerId);
  if (id === null) return VALIDATION_FAILED();

  const upstream = await callWrite(
    `/v1/offers/${encodeURIComponent(id)}/${move}`,
    accepted.accessToken,
    undefined,
    options,
  );
  return await writeOutcome(upstream, 200, OfferDecisionResponseSchema);
}

/** `POST /api/offers/{offerId}/accept` — the seller accepts, and the obligation is recorded. */
export async function handleAcceptOffer(
  request: Request,
  offerId: string | undefined,
  options: OffersHandlerOptions = {},
): Promise<Response> {
  return await handleDecision('accept', request, offerId, options);
}

/** `POST /api/offers/{offerId}/reject` — the seller declines. */
export async function handleRejectOffer(
  request: Request,
  offerId: string | undefined,
  options: OffersHandlerOptions = {},
): Promise<Response> {
  return await handleDecision('reject', request, offerId, options);
}

/** `POST /api/offers/{offerId}/withdraw` — the buyer takes their own offer back. */
export async function handleWithdrawOffer(
  request: Request,
  offerId: string | undefined,
  options: OffersHandlerOptions = {},
): Promise<Response> {
  return await handleDecision('withdraw', request, offerId, options);
}
