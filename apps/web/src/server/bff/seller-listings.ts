import 'server-only';
import {
  LISTING_SLUG_PATTERN,
  PROBLEM_JSON_MEDIA_TYPE,
  SESSION_TOKEN_HEADER,
  SELLER_LISTINGS_DEFAULT_LIMIT,
  SELLER_LISTINGS_MAX_LIMIT,
  SellerListingCreateRequestSchema,
  SellerListingMutationResponseSchema,
  SellerListingUpdateRequestSchema,
  SellerListingsResponseSchema,
  type SellerListing,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readAccessToken } from './session-cookies';

/**
 * The BFF half of the seller's own listings (Phase 6-F).
 *
 * The same write conventions 5-E established and 6-C, 6-D and 6-E reuse, and for the same reasons:
 *
 *   * **The Origin check runs before the session cookie is read.** A cross-site form post is refused
 *     without this module ever touching the caller's session, which is the part a CSRF defence that read
 *     the cookie first would already have got wrong.
 *   * **The token travels; the browser's `Cookie` header does not.** It is read from `__Host-mp_access`,
 *     which JavaScript cannot see, and presented upstream in `x-session-token` beside the internal
 *     credential. No cookie is forwarded to any upstream service.
 *   * **Both directions are validated against the shared contract, and what is forwarded is the validated
 *     value** — never the text a browser sent. So a `status`, `sellerUserId`, `listingId` or timestamp a
 *     client invented has no route through this layer at all, whatever the API would have done with it.
 *   * **One exact success status per operation.** Not "any 2xx": an operation that answered 200 where its
 *     contract says 201 has drifted as surely as one whose body has, and a client rendering it would be
 *     rendering a guess.
 *   * **Nothing here logs.** A listing carries seller-written prose, a price and a location.
 *
 * **The slug in the path is never trusted and never used to authorize anything.** This module checks its
 * shape only so an obviously malformed address costs no upstream hop, and it percent-encodes it into the
 * internal URL. Ownership is resolved in the database from the caller's own account, so a slug belonging to
 * somebody else produces the same 404 as one that does not exist — this layer does not, and could not, make
 * that decision.
 */

const PROBLEM = {
  type: 'about:blank',
  status: 503,
  title: 'Service Unavailable',
  detail: 'The service is temporarily unavailable.',
  instance: '/sellers/me/listings',
  code: 'SERVICE_UNAVAILABLE',
} as const;

export interface SellerListingsHandlerOptions {
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

const forbidden = (): Response =>
  problemResponse(403, 'Forbidden', 'BAD_REQUEST', 'The request could not be processed.');

const invalid = (): Response =>
  problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');

const notFound = (): Response =>
  problemResponse(404, 'Not Found', 'NOT_FOUND', 'The requested resource was not found.');

/** Every refusal the five listing operations declare. Anything else upstream is a 503 here. */
const LISTING_PROBLEM_STATUSES = new Set([400, 401, 403, 404, 409, 429]);

/**
 * What a server-rendered listings surface learns.
 *
 * Four outcomes, and the difference between the last three is what a page does about it — the same shape
 * 6-B's identity reader uses, for the same reason: `unavailable` must never read as "you have no listings",
 * which would be a page telling somebody their work had vanished because a request timed out.
 */
export type SellerListingsLookup =
  | {
      readonly kind: 'ok';
      readonly listings: readonly SellerListing[];
      readonly nextCursor: string | null;
    }
  | { readonly kind: 'not_a_seller' }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'unavailable' };

/**
 * One page of the caller's own listings, read on the server (Phase 6-F).
 *
 * A page-side reader rather than a client fetch, so the token never reaches a browser and the listings are
 * rendered by a server component. A page cannot ask about another seller: the API accepts no identifier.
 */
export async function readSellerListings(
  options: SellerListingsHandlerOptions & { readonly limit?: number; readonly cursor?: string | null } = {},
): Promise<SellerListingsLookup> {
  const accessToken = readAccessToken(options.cookieHeader ?? null);
  // No access cookie is no session: nothing is asked upstream, because there is nothing to ask about.
  if (accessToken === null) return { kind: 'unauthenticated' };

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  const query = new URLSearchParams();
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? SELLER_LISTINGS_DEFAULT_LIMIT), 1),
    SELLER_LISTINGS_MAX_LIMIT,
  );
  query.set('limit', String(limit));
  const cursor = options.cursor ?? null;
  if (cursor !== null && cursor !== '') query.set('cursor', cursor);

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}/v1/sellers/me/listings?${query.toString()}`, {
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

  let parsed: ReturnType<typeof SellerListingsResponseSchema.safeParse>;
  try {
    parsed = SellerListingsResponseSchema.safeParse(JSON.parse(text));
  } catch {
    return { kind: 'unavailable' };
  }
  // Rebuilt from the validated fields: a field the contract does not name has nowhere to go.
  return parsed.success
    ? { kind: 'ok', listings: parsed.data.listings, nextCursor: parsed.data.nextCursor }
    : { kind: 'unavailable' };
}

/**
 * `GET /api/sellers/me/listings`.
 *
 * A read, so no Origin check — there is nothing to forge across origins when a request changes no state,
 * and the session cookie decides whose listings these are. `no-store`, so nothing is cached for the next
 * visitor of a shared machine.
 */
export async function handleSellerListings(
  request: Request,
  options: SellerListingsHandlerOptions = {},
): Promise<Response> {
  const accessToken = readAccessToken(options.cookieHeader ?? request.headers.get('cookie'));
  if (accessToken === null) return unauthenticated();

  const asked = new URL(request.url);
  const limitParam = asked.searchParams.get('limit');
  const parsedLimit = limitParam === null ? SELLER_LISTINGS_DEFAULT_LIMIT : Number.parseInt(limitParam, 10);

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  const query = new URLSearchParams();
  query.set(
    'limit',
    String(
      Math.min(
        Math.max(Number.isFinite(parsedLimit) ? Math.trunc(parsedLimit) : SELLER_LISTINGS_DEFAULT_LIMIT, 1),
        SELLER_LISTINGS_MAX_LIMIT,
      ),
    ),
  );
  const cursor = asked.searchParams.get('cursor');
  if (cursor !== null && cursor !== '') query.set('cursor', cursor);

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}/v1/sellers/me/listings?${query.toString()}`, {
      method: 'GET',
      headers: { [SESSION_TOKEN_HEADER]: accessToken },
    });
  } catch {
    return unavailable();
  }

  const text = await upstream.text().catch(() => '');
  if (upstream.status !== 200) {
    if (!LISTING_PROBLEM_STATUSES.has(upstream.status)) return unavailable();
    // The API's own problem body, with its own status and code. One sentence, written once.
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
    });
  }

  let validated: ReturnType<typeof SellerListingsResponseSchema.safeParse>;
  try {
    validated = SellerListingsResponseSchema.safeParse(JSON.parse(text));
  } catch {
    return unavailable();
  }
  if (!validated.success) return unavailable();

  return new Response(
    JSON.stringify({ listings: validated.data.listings, nextCursor: validated.data.nextCursor }),
    { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
  );
}

/**
 * The shared body of the four writes.
 *
 * `parseRequest` returns the validated value to forward, or null to refuse; `null` for the whole parameter
 * means the operation takes no body at all, and then nothing is read from the request and nothing is sent —
 * which is what keeps a submission from becoming a route a body could steer.
 */
async function listingWrite(
  request: Request,
  options: SellerListingsHandlerOptions,
  method: 'POST' | 'PATCH',
  path: string,
  expected: 200 | 201,
  parseRequest: ((payload: unknown) => unknown | null) | null,
): Promise<Response> {
  // First, before anything reads a cookie.
  const origin = checkSameOrigin({
    method: request.method,
    url: addressedOrigin(request),
    headers: request.headers,
  });
  if (!origin.ok) return forbidden();

  const accessToken = readAccessToken(options.cookieHeader ?? request.headers.get('cookie'));
  if (accessToken === null) return unauthenticated();

  let payload: string | null = null;
  if (parseRequest !== null) {
    const raw = await request.text().catch(() => '');
    let body: unknown;
    try {
      body = JSON.parse(raw === '' ? 'null' : raw);
    } catch {
      return invalid();
    }
    const validatedRequest = parseRequest(body);
    if (validatedRequest === null) return invalid();
    payload = JSON.stringify(validatedRequest);
  }

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}${path}`, {
      method,
      headers:
        payload === null
          ? { [SESSION_TOKEN_HEADER]: accessToken }
          : { 'content-type': 'application/json', [SESSION_TOKEN_HEADER]: accessToken },
      ...(payload === null ? {} : { body: payload }),
    });
  } catch {
    return unavailable();
  }

  const text = await upstream.text().catch(() => '');
  if (upstream.status !== expected) {
    if (!LISTING_PROBLEM_STATUSES.has(upstream.status)) return unavailable();
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
    });
  }

  let validated: ReturnType<typeof SellerListingMutationResponseSchema.safeParse>;
  try {
    validated = SellerListingMutationResponseSchema.safeParse(JSON.parse(text));
  } catch {
    return unavailable();
  }
  if (!validated.success) return unavailable();

  // Rebuilt from the validated fields: a field the contract does not name has nowhere to go.
  return new Response(JSON.stringify({ listing: validated.data.listing }), {
    status: expected,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * A slug this layer is willing to put in a URL.
 *
 * Shape only, and it authorizes nothing: it exists so a malformed address costs no upstream hop and so
 * nothing but the listings table's own alphabet can reach the internal URL. A well-formed slug belonging to
 * another seller passes here and is refused by the database, which is the only place that can tell.
 */
function usableSlug(slug: string): string | null {
  return LISTING_SLUG_PATTERN.test(slug) ? encodeURIComponent(slug) : null;
}

/** `POST /api/sellers/me/listings` — create one draft. */
export async function handleSellerListingCreate(
  request: Request,
  options: SellerListingsHandlerOptions = {},
): Promise<Response> {
  return listingWrite(request, options, 'POST', '/v1/sellers/me/listings', 201, (payload) => {
    const parsed = SellerListingCreateRequestSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  });
}

/**
 * `PATCH /api/sellers/me/listings/:slug` — edit one draft.
 *
 * Absent and null survive the round trip intact, which is the whole of the partial-update contract:
 * `JSON.stringify` drops a key the schema left absent and keeps one whose value is `null`, so "leave this
 * alone" and "empty this" reach the API as the different requests they are.
 */
export async function handleSellerListingUpdate(
  request: Request,
  slug: string,
  options: SellerListingsHandlerOptions = {},
): Promise<Response> {
  const safe = usableSlug(slug);
  if (safe === null) return notFound();
  return listingWrite(
    request,
    options,
    'PATCH',
    `/v1/sellers/me/listings/${safe}`,
    200,
    (payload) => {
      const parsed = SellerListingUpdateRequestSchema.safeParse(payload);
      return parsed.success ? parsed.data : null;
    },
  );
}

/** `POST /api/sellers/me/listings/:slug/submission` — submit one draft. No body is read or sent. */
export async function handleSellerListingSubmit(
  request: Request,
  slug: string,
  options: SellerListingsHandlerOptions = {},
): Promise<Response> {
  const safe = usableSlug(slug);
  if (safe === null) return notFound();
  return listingWrite(
    request,
    options,
    'POST',
    `/v1/sellers/me/listings/${safe}/submission`,
    200,
    null,
  );
}

/** `POST /api/sellers/me/listings/:slug/archive` — withdraw one live listing. No body either. */
export async function handleSellerListingArchive(
  request: Request,
  slug: string,
  options: SellerListingsHandlerOptions = {},
): Promise<Response> {
  const safe = usableSlug(slug);
  if (safe === null) return notFound();
  return listingWrite(request, options, 'POST', `/v1/sellers/me/listings/${safe}/archive`, 200, null);
}
