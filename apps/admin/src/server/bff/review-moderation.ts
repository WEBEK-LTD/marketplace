import 'server-only';
import {
  ModerateReviewRequestSchema,
  ModerateReviewResponseSchema,
  PROBLEM_JSON_MEDIA_TYPE,
  REVIEW_STATUSES,
  ReviewDetailResponseSchema,
  ReviewModerationActionsResponseSchema,
  ReviewQueueResponseSchema,
  SESSION_TOKEN_HEADER,
  type ReviewDetail,
  type ReviewModerationActionsResponse,
  type ReviewQueueResponse,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readAdminAccessToken } from './staff-session';

/**
 * Review moderation, on the admin origin (Phase 7-P).
 *
 * Three reads a page performs before it renders, and one write a colleague posts to. The rules are 7-F's,
 * 7-L's, 7-N's and 7-O's, applied to a surface where the subjects are things buyers and sellers wrote about
 * each other.
 *
 * **The session never leaves the server.** The caller's access token lives in `__Host-mp_admin_access`, which
 * JavaScript cannot read; it is presented to the API on one internal hop in the session-token header, and the
 * browser's own `Cookie` header is never forwarded.
 *
 * **Nothing about the caller crosses in a request.** No account, no role, no permission key and no assurance
 * level appears in anything built here. The API resolves all of it from the session, and the database
 * re-applies each permission test with the key as a literal.
 *
 * **The body is rebuilt, never forwarded.** A decision sends one of four statuses and a reason, and nothing
 * else. A screen that added a `moderatorUserId`, a `moderatedAt`, an `autoHiddenReason`, a `publishedAt`, a
 * `rating` or anything naming the order would have it dropped before the request left this origin, and the
 * API's strict schema would refuse it anyway. Two independent walls, neither relying on the other.
 *
 * ---------------------------------------------------------------------------------------------------
 * **THERE IS NO REPLY WRITE IN THIS MODULE, AND THERE IS NO ROUTE FOR ONE.**
 *
 * `public.review_replies` is written by nothing in this repository outside the seller's own insert, so a
 * request arriving at this origin asking to hide or remove a reply has nothing here to reach. The reply is
 * read as part of the review so a moderator can judge the whole exchange, and that is all.
 * ---------------------------------------------------------------------------------------------------
 *
 * **A review is named by its id, in the route, never in a body**, and the id is checked here for shape, so a
 * made-up address never becomes an upstream call.
 *
 * **Responses are validated, not forwarded.** A drifted body becomes a clean failure here instead of a
 * half-rendered page, and a field the contract does not name cannot reach a browser even if the API sent one
 * — which is the third wall in front of the buyer's account, the seller's account and the order behind the
 * review, none of which the API returns.
 *
 * **Cursors stay opaque.** A cursor is passed along as text and never parsed or reconstructed here.
 *
 * **Nothing here logs.** A review body is what one person wrote about another and a moderation reason is why
 * a colleague hid it; the way to keep either out of a log is to have no log line that could take one.
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

const UNAVAILABLE = (): Response =>
  problemResponse(
    503,
    'Service Unavailable',
    'SERVICE_UNAVAILABLE',
    'The service is temporarily unavailable.',
  );
const SESSION_REQUIRED = (): Response =>
  problemResponse(401, 'Unauthorized', 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
const VALIDATION_FAILED = (): Response =>
  problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');

/** The statuses the API may refuse a write with. Anything else becomes the generic outage. */
const WRITE_PROBLEM_STATUSES = new Set([400, 401, 403, 404, 409, 429, 503]);

export interface ReviewModerationOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

/**
 * What a read resolved to.
 *
 * `notFound` is the API's one neutral answer: no such review, or a caller without the key the operation
 * needs. The console does not try to tell those apart, because the API deliberately does not — and on three
 * keys that are not held together, that is the whole protection.
 */
export type ReviewModerationResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' };

/** base64url, which is the whole of what a cursor can be. Refused here rather than forwarded. */
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function identifier(value: string | undefined | null): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

/**
 * Builds a query string from what the caller passed, dropping what it did not.
 *
 * The status filter is checked against 0026's own four rather than forwarded as free text: an unknown value
 * would match nothing upstream anyway, and dropping it here keeps a mistyped bookmark showing the whole queue
 * instead of an empty one.
 */
function query(input: {
  readonly cursor?: string | null;
  readonly limit?: string | null;
  readonly status?: string | null;
}): string {
  const params = new URLSearchParams();
  if (typeof input.limit === 'string' && /^\d{1,3}$/.test(input.limit)) params.set('limit', input.limit);
  if (
    typeof input.status === 'string' &&
    (REVIEW_STATUSES as readonly string[]).includes(input.status)
  ) {
    params.set('status', input.status);
  }
  if (typeof input.cursor === 'string' && CURSOR_PATTERN.test(input.cursor)) {
    // Passed along as text. This layer does not know what a cursor contains and must not learn.
    params.set('cursor', input.cursor);
  }
  return params.size === 0 ? '' : `?${params.toString()}`;
}

async function read<T>(
  path: string,
  options: ReviewModerationOptions,
  parse: (body: unknown) => { success: true; data: T } | { success: false },
): Promise<ReviewModerationResult<T>> {
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

/* ------------------------------------------------------------------------------------------------ */
/* Reads                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

/** One page of the queue, newest first. */
export async function readReviewQueue(
  input: {
    readonly cursor?: string | null;
    readonly limit?: string | null;
    readonly status?: string | null;
  } = {},
  options: ReviewModerationOptions = {},
): Promise<ReviewModerationResult<ReviewQueueResponse>> {
  return await read(`/v1/admin/reviews${query(input)}`, options, (body) =>
    ReviewQueueResponseSchema.safeParse(body),
  );
}

/**
 * One review.
 *
 * A malformed id is `notFound` here rather than a validation failure: the value came from the address
 * somebody typed, and the honest answer to a made-up address is that there is nothing at it.
 */
export async function readReview(
  reviewId: string | undefined,
  options: ReviewModerationOptions = {},
): Promise<ReviewModerationResult<ReviewDetail>> {
  const id = identifier(reviewId ?? null);
  if (id === null) return { kind: 'notFound' };
  const result = await read(`/v1/admin/reviews/${encodeURIComponent(id)}`, options, (body) =>
    ReviewDetailResponseSchema.safeParse(body),
  );
  return result.kind === 'ok' ? { kind: 'ok', data: result.data.review } : result;
}

/**
 * The moderation trail of one review.
 *
 * Gated upstream on `moderation.action.read`, which is neither review key, so an empty list means either
 * nothing recorded or the key not held — and this layer cannot tell, which is the point.
 */
export async function readReviewModerationActions(
  reviewId: string | undefined,
  options: ReviewModerationOptions = {},
): Promise<ReviewModerationResult<ReviewModerationActionsResponse>> {
  const id = identifier(reviewId ?? null);
  if (id === null) return { kind: 'notFound' };
  return await read(`/v1/admin/reviews/${encodeURIComponent(id)}/actions`, options, (body) =>
    ReviewModerationActionsResponseSchema.safeParse(body),
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* The one write                                                                                     */
/* ------------------------------------------------------------------------------------------------ */

async function acceptWrite(
  request: Request,
  options: ReviewModerationOptions,
): Promise<{ refusal: Response } | { accessToken: string; body: Record<string, unknown> }> {
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

  const accessToken = readAdminAccessToken(options.cookieHeader ?? request.headers.get('cookie'));
  if (accessToken === null) return { refusal: SESSION_REQUIRED() };

  let body: unknown;
  try {
    const raw = await request.text();
    body = raw === '' ? {} : JSON.parse(raw);
  } catch {
    return { refusal: VALIDATION_FAILED() };
  }
  if (typeof body !== 'object' || body === null) return { refusal: VALIDATION_FAILED() };
  return { accessToken, body: body as Record<string, unknown> };
}

async function callWrite(
  path: string,
  accessToken: string,
  body: unknown,
  options: ReviewModerationOptions,
): Promise<Response | null> {
  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);
  try {
    return await fetcher(`${config.apiBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_TOKEN_HEADER]: accessToken },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}

/**
 * Turns one upstream write response into the browser's.
 *
 * A recognised refusal is forwarded with the API's own problem body, so a screen can say "a colleague who is
 * not a party has to take this one" rather than a generic failure — which is exactly what the moderator who
 * turns out to be the review's buyer needs to be told. Anything else becomes the generic 503, and success is
 * the expected status exactly, re-validated before a byte of it reaches a browser.
 */
async function writeOutcome<T>(
  upstream: Response | null,
  expected: number,
  parse: (body: unknown) => { success: true; data: T } | { success: false },
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
  const validated = parse(parsed);
  if (!validated.success) return UNAVAILABLE();

  return new Response(JSON.stringify(validated.data), {
    status: expected,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * `POST /api/reviews/moderation` — record a decision on one review.
 *
 * The review is named in the body here because this origin exposes one route rather than a route per review,
 * and it is turned into a path segment after being checked for shape; nothing that is not an identifier
 * becomes an upstream call. The two contract fields are rebuilt from the body and everything else is dropped.
 *
 * **There is no companion handler that moderates a reply**, because no writer for one exists. A body naming a
 * reply has nothing here that reads it.
 */
export async function handleReviewModeration(
  request: Request,
  options: ReviewModerationOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(
    typeof accepted.body['reviewId'] === 'string' ? accepted.body['reviewId'] : null,
  );
  if (id === null) return VALIDATION_FAILED();

  const reason = accepted.body['reason'];
  const validated = ModerateReviewRequestSchema.safeParse({
    status: accepted.body['status'],
    reason: typeof reason === 'string' ? reason.trim() : reason,
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    `/v1/admin/reviews/${encodeURIComponent(id)}/moderation`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => ModerateReviewResponseSchema.safeParse(body));
}
