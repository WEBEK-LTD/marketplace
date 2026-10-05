import 'server-only';
import {
  LISTING_SLUG_PATTERN,
  PROBLEM_JSON_MEDIA_TYPE,
  SESSION_TOKEN_HEADER,
  SELLER_SERVICES_DEFAULT_LIMIT,
  SELLER_SERVICES_MAX_LIMIT,
  SellerListingMutationResponseSchema,
  SellerServiceCreateRequestSchema,
  SellerServiceUpdateRequestSchema,
  SellerServicesResponseSchema,
  type SellerService,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readAccessToken } from './session-cookies';

/**
 * The BFF half of the seller's own services (Phase 6-G).
 *
 * The same write conventions 5-E established and 6-C, 6-D, 6-E and 6-F reuse, and for the same reasons: the
 * Origin check before the session cookie is read; the token upstream in `x-session-token` beside the internal
 * credential and the browser's own `Cookie` never forwarded; both directions validated against the shared
 * contract with the *validated* value forwarded; one exact success status per operation; nothing logged.
 *
 * **Three handlers, not five.** A service is submitted and archived through the listing routes on this
 * origin — `/api/sellers/me/listings/{slug}/submission` and `.../archive` — because those move the same
 * `listings` row and the API's submitter is already service-aware. A second pair here would be a second
 * path to the same two moves.
 *
 * **The slug is never trusted and never used to authorize anything.** Its shape is checked so an obviously
 * malformed address costs no upstream hop, and it is percent-encoded into the internal URL. Ownership — and
 * whether the listing at that address is a service at all — is resolved in the database from the caller's own
 * account, and both refusals come back as the same 404.
 */

const PROBLEM = {
  type: 'about:blank',
  status: 503,
  title: 'Service Unavailable',
  detail: 'The service is temporarily unavailable.',
  instance: '/sellers/me/services',
  code: 'SERVICE_UNAVAILABLE',
} as const;

export interface SellerServicesHandlerOptions {
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

/** Every refusal the three service operations declare. Anything else upstream is a 503 here. */
const SERVICE_PROBLEM_STATUSES = new Set([400, 401, 403, 404, 409, 429]);

/**
 * What a server-rendered services surface learns.
 *
 * The same four outcomes 6-B's identity reader and 6-F's listings reader use, for the same reason:
 * `unavailable` must never read as "you have no services", which would be a page telling somebody their work
 * had vanished because a request timed out.
 */
export type SellerServicesLookup =
  | {
      readonly kind: 'ok';
      readonly services: readonly SellerService[];
      readonly nextCursor: string | null;
    }
  | { readonly kind: 'not_a_seller' }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'unavailable' };

function pageQuery(limit: number | undefined, cursor: string | null): string {
  const query = new URLSearchParams();
  const size = Math.min(
    Math.max(Math.trunc(limit ?? SELLER_SERVICES_DEFAULT_LIMIT), 1),
    SELLER_SERVICES_MAX_LIMIT,
  );
  query.set('limit', String(size));
  if (cursor !== null && cursor !== '') query.set('cursor', cursor);
  return query.toString();
}

/**
 * One page of the caller's own services, read on the server (Phase 6-G).
 *
 * A page-side reader rather than a client fetch, so the token never reaches a browser and the services are
 * rendered by a server component. A page cannot ask about another seller: the API accepts no identifier.
 */
export async function readSellerServices(
  options: SellerServicesHandlerOptions & { readonly limit?: number; readonly cursor?: string | null } = {},
): Promise<SellerServicesLookup> {
  const accessToken = readAccessToken(options.cookieHeader ?? null);
  // No access cookie is no session: nothing is asked upstream, because there is nothing to ask about.
  if (accessToken === null) return { kind: 'unauthenticated' };

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(
      `${config.apiBaseUrl}/v1/sellers/me/services?${pageQuery(options.limit, options.cursor ?? null)}`,
      { method: 'GET', headers: { [SESSION_TOKEN_HEADER]: accessToken } },
    );
  } catch {
    return { kind: 'unavailable' };
  }

  const text = await upstream.text().catch(() => '');
  if (upstream.status === 401) return { kind: 'unauthenticated' };
  if (upstream.status === 404) return { kind: 'not_a_seller' };
  if (upstream.status !== 200) return { kind: 'unavailable' };

  let parsed: ReturnType<typeof SellerServicesResponseSchema.safeParse>;
  try {
    parsed = SellerServicesResponseSchema.safeParse(JSON.parse(text));
  } catch {
    return { kind: 'unavailable' };
  }
  // Rebuilt from the validated fields: a field the contract does not name has nowhere to go.
  return parsed.success
    ? { kind: 'ok', services: parsed.data.services, nextCursor: parsed.data.nextCursor }
    : { kind: 'unavailable' };
}

/**
 * `GET /api/sellers/me/services`.
 *
 * A read, so no Origin check — there is nothing to forge across origins when a request changes no state, and
 * the session cookie decides whose services these are. `no-store`, so nothing is cached for the next visitor
 * of a shared machine.
 */
export async function handleSellerServices(
  request: Request,
  options: SellerServicesHandlerOptions = {},
): Promise<Response> {
  const accessToken = readAccessToken(options.cookieHeader ?? request.headers.get('cookie'));
  if (accessToken === null) return unauthenticated();

  const asked = new URL(request.url);
  const limitParam = asked.searchParams.get('limit');
  const parsedLimit = limitParam === null ? SELLER_SERVICES_DEFAULT_LIMIT : Number.parseInt(limitParam, 10);

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(
      `${config.apiBaseUrl}/v1/sellers/me/services?${pageQuery(
        Number.isFinite(parsedLimit) ? parsedLimit : SELLER_SERVICES_DEFAULT_LIMIT,
        asked.searchParams.get('cursor'),
      )}`,
      { method: 'GET', headers: { [SESSION_TOKEN_HEADER]: accessToken } },
    );
  } catch {
    return unavailable();
  }

  const text = await upstream.text().catch(() => '');
  if (upstream.status !== 200) {
    if (!SERVICE_PROBLEM_STATUSES.has(upstream.status)) return unavailable();
    // The API's own problem body, with its own status and code. One sentence, written once.
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
    });
  }

  let validated: ReturnType<typeof SellerServicesResponseSchema.safeParse>;
  try {
    validated = SellerServicesResponseSchema.safeParse(JSON.parse(text));
  } catch {
    return unavailable();
  }
  if (!validated.success) return unavailable();

  return new Response(
    JSON.stringify({ services: validated.data.services, nextCursor: validated.data.nextCursor }),
    { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
  );
}

/** The shared body of the two writes. */
async function serviceWrite(
  request: Request,
  options: SellerServicesHandlerOptions,
  method: 'POST' | 'PATCH',
  path: string,
  expected: 200 | 201,
  parseRequest: (payload: unknown) => unknown | null,
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

  const raw = await request.text().catch(() => '');
  let body: unknown;
  try {
    body = JSON.parse(raw === '' ? 'null' : raw);
  } catch {
    return invalid();
  }
  const validatedRequest = parseRequest(body);
  if (validatedRequest === null) return invalid();

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', [SESSION_TOKEN_HEADER]: accessToken },
      body: JSON.stringify(validatedRequest),
    });
  } catch {
    return unavailable();
  }

  const text = await upstream.text().catch(() => '');
  if (upstream.status !== expected) {
    if (!SERVICE_PROBLEM_STATUSES.has(upstream.status)) return unavailable();
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
 * nothing but the listings table's own alphabet reaches the internal URL. A well-formed slug belonging to
 * another seller — or to one of the caller's own products — passes here and is refused by the database,
 * which is the only place that can tell.
 */
function usableSlug(slug: string): string | null {
  return LISTING_SLUG_PATTERN.test(slug) ? encodeURIComponent(slug) : null;
}

/** `POST /api/sellers/me/services` — create one service draft. */
export async function handleSellerServiceCreate(
  request: Request,
  options: SellerServicesHandlerOptions = {},
): Promise<Response> {
  return serviceWrite(request, options, 'POST', '/v1/sellers/me/services', 201, (payload) => {
    const parsed = SellerServiceCreateRequestSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  });
}

/**
 * `PATCH /api/sellers/me/services/:slug` — edit one service draft.
 *
 * Absent, null and a value survive the round trip intact, which is the whole of the partial-update contract:
 * `JSON.stringify` drops a key the schema left absent and keeps one whose value is `null`, so "leave this
 * alone", "empty this" and — for the pricing model — "withdraw the detail row" reach the API as the three
 * different requests they are.
 */
export async function handleSellerServiceUpdate(
  request: Request,
  slug: string,
  options: SellerServicesHandlerOptions = {},
): Promise<Response> {
  const safe = usableSlug(slug);
  if (safe === null) return notFound();
  return serviceWrite(
    request,
    options,
    'PATCH',
    `/v1/sellers/me/services/${safe}`,
    200,
    (payload) => {
      const parsed = SellerServiceUpdateRequestSchema.safeParse(payload);
      return parsed.success ? parsed.data : null;
    },
  );
}
