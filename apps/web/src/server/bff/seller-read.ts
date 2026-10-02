import 'server-only';
import {
  PROBLEM_JSON_MEDIA_TYPE,
  SESSION_TOKEN_HEADER,
  SELLER_ANALYTICS_DEFAULT_DAYS,
  SELLER_ANALYTICS_MAX_DAYS,
  SELLER_READ_DEFAULT_LIMIT,
  SELLER_READ_MAX_LIMIT,
  SellerAnalyticsResponseSchema,
  SellerEarningsResponseSchema,
  SellerOrdersResponseSchema,
  SellerPromotionsResponseSchema,
  SellerReviewsResponseSchema,
  type SellerAnalyticsResponse,
  type SellerBalance,
  type SellerOrder,
  type SellerPromotion,
  type SellerReview,
  type SellerReviewSummary,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { readAccessToken } from './session-cookies';

/**
 * The BFF half of the read-only seller surfaces (Phase 6-J).
 *
 * Five reads, and **no write handler anywhere in this file**: no Origin check, because there is nothing to
 * forge across origins when a request changes no state, and no `POST`, `PATCH`, `PUT` or `DELETE` handler for
 * a route to expose. The session cookie decides whose rows these are; the token goes upstream in
 * `x-session-token` beside the internal credential, and the browser's own `Cookie` is never forwarded.
 *
 * Everything comes back validated against the shared contract and is **rebuilt from the validated fields**, so
 * a field the contract does not name has nowhere to go — which is what keeps a commission snapshot, a
 * moderation reason, a ledger account or a payout reference out of a browser even if an upstream one day
 * offered one.
 *
 * Every response is `no-store`. A balance, an order and a review are private to one seller, and none of them
 * belongs in a shared machine's cache.
 *
 * **The page-side readers are the important half.** Each returns a small tagged union with `unavailable`
 * distinct from `empty`, because a failing request must never render as "you have no orders" — that would
 * tell somebody their business had vanished because a socket timed out.
 */

const PROBLEM = {
  type: 'about:blank',
  status: 503,
  title: 'Service Unavailable',
  detail: 'The service is temporarily unavailable.',
  instance: '/sellers/me',
  code: 'SERVICE_UNAVAILABLE',
} as const;

export interface SellerReadHandlerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header, when a caller has it already. */
  readonly cookieHeader?: string | null;
}

function problemResponse(status: number, title: string, code: string, detail: string): Response {
  return new Response(JSON.stringify({ ...PROBLEM, status, title, code, detail }), {
    status,
    headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
  });
}

const unavailable = (): Response =>
  problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', PROBLEM.detail);
const unauthenticated = (): Response =>
  problemResponse(401, 'Unauthorized', 'AUTHENTICATION_REQUIRED', 'Authentication is required.');

/** Every refusal the five read operations declare. Anything else upstream is a 503 here. */
const READ_PROBLEM_STATUSES = new Set([400, 401, 403, 404]);

/** The page size, clamped here as well as upstream so a hand-edited URL costs nothing. */
function pageQuery(limit: number | undefined, cursor: string | null): string {
  const query = new URLSearchParams();
  const size = Math.min(
    Math.max(Math.trunc(limit ?? SELLER_READ_DEFAULT_LIMIT), 1),
    SELLER_READ_MAX_LIMIT,
  );
  query.set('limit', String(size));
  if (cursor !== null && cursor !== '') query.set('cursor', cursor);
  return query.toString();
}

function windowQuery(days: number | undefined): string {
  const query = new URLSearchParams();
  query.set(
    'days',
    String(
      Math.min(Math.max(Math.trunc(days ?? SELLER_ANALYTICS_DEFAULT_DAYS), 1), SELLER_ANALYTICS_MAX_DAYS),
    ),
  );
  return query.toString();
}

/**
 * The shape every page-side reader answers with.
 *
 * `not_a_seller` and `unavailable` are kept apart from a successful-but-empty read on purpose: only the first
 * is a wrong page, only the second is a failure, and an empty list is neither.
 */
export type SellerReadLookup<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'not_a_seller' }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'unavailable' };

async function readUpstream<T>(
  path: string,
  parse: (payload: unknown) => T | null,
  options: SellerReadHandlerOptions,
): Promise<SellerReadLookup<T>> {
  const accessToken = readAccessToken(options.cookieHeader ?? null);
  // No access cookie is no session: nothing is asked upstream, because there is nothing to ask about.
  if (accessToken === null) return { kind: 'unauthenticated' };

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(
    config.internalBffCredential,
    options.fetch ?? fetch,
  );

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}${path}`, {
      method: 'GET',
      headers: { [SESSION_TOKEN_HEADER]: accessToken },
    });
  } catch {
    return { kind: 'unavailable' };
  }

  const text = await upstream.text().catch(() => '');
  if (upstream.status === 401) return { kind: 'unauthenticated' };
  if (upstream.status === 404) return { kind: 'not_a_seller' };
  if (upstream.status !== 200) return { kind: 'unavailable' };

  let parsed: T | null;
  try {
    parsed = parse(JSON.parse(text));
  } catch {
    return { kind: 'unavailable' };
  }
  return parsed === null ? { kind: 'unavailable' } : { kind: 'ok', data: parsed };
}

async function handleRead<T>(
  request: Request,
  path: (search: URLSearchParams) => string,
  parse: (payload: unknown) => T | null,
  options: SellerReadHandlerOptions,
): Promise<Response> {
  const accessToken = readAccessToken(options.cookieHeader ?? request.headers.get('cookie'));
  if (accessToken === null) return unauthenticated();

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(
    config.internalBffCredential,
    options.fetch ?? fetch,
  );

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}${path(new URL(request.url).searchParams)}`, {
      method: 'GET',
      headers: { [SESSION_TOKEN_HEADER]: accessToken },
    });
  } catch {
    return unavailable();
  }

  const text = await upstream.text().catch(() => '');
  if (upstream.status !== 200) {
    if (!READ_PROBLEM_STATUSES.has(upstream.status)) return unavailable();
    // The API's own problem body, with its own status and code. One sentence, written once.
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
    });
  }

  let parsed: T | null;
  try {
    parsed = parse(JSON.parse(text));
  } catch {
    return unavailable();
  }
  if (parsed === null) return unavailable();

  // Rebuilt from the validated fields: a field the contract does not name has nowhere to go.
  return new Response(JSON.stringify(parsed), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function intOrUndefined(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/* ---------------------------------------------------------------------------------------------------- *
 * Orders
 * ---------------------------------------------------------------------------------------------------- */

export interface SellerOrdersPage {
  readonly orders: readonly SellerOrder[];
  readonly nextCursor: string | null;
}

const parseOrders = (payload: unknown): SellerOrdersPage | null => {
  const parsed = SellerOrdersResponseSchema.safeParse(payload);
  return parsed.success
    ? { orders: parsed.data.orders, nextCursor: parsed.data.nextCursor }
    : null;
};

export async function readSellerOrders(
  options: SellerReadHandlerOptions & { readonly limit?: number; readonly cursor?: string | null } = {},
): Promise<SellerReadLookup<SellerOrdersPage>> {
  return readUpstream(
    `/v1/sellers/me/orders?${pageQuery(options.limit, options.cursor ?? null)}`,
    parseOrders,
    options,
  );
}

/** `GET /api/sellers/me/orders`. */
export async function handleSellerOrders(
  request: Request,
  options: SellerReadHandlerOptions = {},
): Promise<Response> {
  return handleRead(
    request,
    (search) =>
      `/v1/sellers/me/orders?${pageQuery(intOrUndefined(search.get('limit')), search.get('cursor'))}`,
    parseOrders,
    options,
  );
}

/* ---------------------------------------------------------------------------------------------------- *
 * Reviews, with the rating summary
 * ---------------------------------------------------------------------------------------------------- */

export interface SellerReviewsPage {
  readonly summary: SellerReviewSummary | null;
  readonly reviews: readonly SellerReview[];
  readonly nextCursor: string | null;
}

const parseReviews = (payload: unknown): SellerReviewsPage | null => {
  const parsed = SellerReviewsResponseSchema.safeParse(payload);
  return parsed.success
    ? {
        summary: parsed.data.summary,
        reviews: parsed.data.reviews,
        nextCursor: parsed.data.nextCursor,
      }
    : null;
};

export async function readSellerReviews(
  options: SellerReadHandlerOptions & { readonly limit?: number; readonly cursor?: string | null } = {},
): Promise<SellerReadLookup<SellerReviewsPage>> {
  return readUpstream(
    `/v1/sellers/me/reviews?${pageQuery(options.limit, options.cursor ?? null)}`,
    parseReviews,
    options,
  );
}

/** `GET /api/sellers/me/reviews`. */
export async function handleSellerReviews(
  request: Request,
  options: SellerReadHandlerOptions = {},
): Promise<Response> {
  return handleRead(
    request,
    (search) =>
      `/v1/sellers/me/reviews?${pageQuery(intOrUndefined(search.get('limit')), search.get('cursor'))}`,
    parseReviews,
    options,
  );
}

/* ---------------------------------------------------------------------------------------------------- *
 * Earnings
 * ---------------------------------------------------------------------------------------------------- */

export interface SellerEarnings {
  readonly balances: readonly SellerBalance[];
}

const parseEarnings = (payload: unknown): SellerEarnings | null => {
  const parsed = SellerEarningsResponseSchema.safeParse(payload);
  return parsed.success ? { balances: parsed.data.balances } : null;
};

export async function readSellerEarnings(
  options: SellerReadHandlerOptions = {},
): Promise<SellerReadLookup<SellerEarnings>> {
  return readUpstream('/v1/sellers/me/earnings', parseEarnings, options);
}

/**
 * `GET /api/sellers/me/earnings`.
 *
 * A read, and the only thing this origin will ever do with a balance. There is no withdrawal handler here, no
 * payout handler, and no route that moves money.
 */
export async function handleSellerEarnings(
  request: Request,
  options: SellerReadHandlerOptions = {},
): Promise<Response> {
  return handleRead(request, () => '/v1/sellers/me/earnings', parseEarnings, options);
}

/* ---------------------------------------------------------------------------------------------------- *
 * Promotions
 * ---------------------------------------------------------------------------------------------------- */

export interface SellerPromotionsPage {
  readonly promotions: readonly SellerPromotion[];
  readonly nextCursor: string | null;
}

const parsePromotions = (payload: unknown): SellerPromotionsPage | null => {
  const parsed = SellerPromotionsResponseSchema.safeParse(payload);
  return parsed.success
    ? { promotions: parsed.data.promotions, nextCursor: parsed.data.nextCursor }
    : null;
};

export async function readSellerPromotions(
  options: SellerReadHandlerOptions & { readonly limit?: number; readonly cursor?: string | null } = {},
): Promise<SellerReadLookup<SellerPromotionsPage>> {
  return readUpstream(
    `/v1/sellers/me/promotions?${pageQuery(options.limit, options.cursor ?? null)}`,
    parsePromotions,
    options,
  );
}

/** `GET /api/sellers/me/promotions`. */
export async function handleSellerPromotions(
  request: Request,
  options: SellerReadHandlerOptions = {},
): Promise<Response> {
  return handleRead(
    request,
    (search) =>
      `/v1/sellers/me/promotions?${pageQuery(intOrUndefined(search.get('limit')), search.get('cursor'))}`,
    parsePromotions,
    options,
  );
}

/* ---------------------------------------------------------------------------------------------------- *
 * Analytics
 * ---------------------------------------------------------------------------------------------------- */

const parseAnalytics = (payload: unknown): SellerAnalyticsResponse | null => {
  const parsed = SellerAnalyticsResponseSchema.safeParse(payload);
  return parsed.success ? { days: parsed.data.days, promotions: parsed.data.promotions } : null;
};

export async function readSellerAnalytics(
  options: SellerReadHandlerOptions & { readonly days?: number } = {},
): Promise<SellerReadLookup<SellerAnalyticsResponse>> {
  return readUpstream(
    `/v1/sellers/me/analytics?${windowQuery(options.days)}`,
    parseAnalytics,
    options,
  );
}

/** `GET /api/sellers/me/analytics`. */
export async function handleSellerAnalytics(
  request: Request,
  options: SellerReadHandlerOptions = {},
): Promise<Response> {
  return handleRead(
    request,
    (search) => `/v1/sellers/me/analytics?${windowQuery(intOrUndefined(search.get('days')))}`,
    parseAnalytics,
    options,
  );
}
