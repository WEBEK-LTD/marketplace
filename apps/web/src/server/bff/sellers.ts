import 'server-only';
import {
  PROBLEM_JSON_MEDIA_TYPE,
  SESSION_TOKEN_HEADER,
  SellerIdentityResponseSchema,
  SellerOnboardingRequestSchema,
  SellerOnboardingResponseSchema,
  SellerProfileResponseSchema,
  SellerMediaAttachRequestSchema,
  SellerMediaAttachResponseSchema,
  SellerMediaUploadRequestSchema,
  SellerMediaUploadResponseSchema,
  SellerProfileUpdateRequestSchema,
  SellerProfileUpdateResponseSchema,
  type PublicSellerProfile,
  type SellerAvailability,
  type SellerIdentity,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readAccessToken } from './session-cookies';

/**
 * The BFF half of the public seller profile (Phase 4-E).
 *
 * The browser asks this origin; this module makes the one credentialled internal hop. No session is read
 * and none is set: a seller's public profile is the same for everyone.
 *
 * The response is **validated** against the shared contract rather than forwarded, so a body that has
 * drifted becomes a clean failure here instead of a broken profile — and, more to the point, so a field
 * the contract does not allow cannot reach a browser even if the API somehow sent one.
 */

const PROBLEM = {
  type: 'about:blank',
  status: 503,
  title: 'Service Unavailable',
  detail: 'The service is temporarily unavailable.',
  instance: '/sellers',
  code: 'SERVICE_UNAVAILABLE',
} as const;

export interface SellersHandlerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}

function problemResponse(status: number, title: string, code: string, detail: string): Response {
  return new Response(JSON.stringify({ ...PROBLEM, status, title, code, detail }), {
    status,
    headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
  });
}

/**
 * What a profile read resolved to.
 *
 * Two words that look alike and are not: `kind: 'unavailable'` means *this service could not answer*,
 * while `availability: 'unavailable'` means *the seller is suspended* and their page says so. The first
 * is a 503, the second is a perfectly good 200.
 */
export type SellerLookup =
  | {
      readonly kind: 'found';
      readonly seller: PublicSellerProfile;
      readonly availability: SellerAvailability;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unavailable' };

/** One seller by slug, a 404, or a failure — the three a page must render. */
export async function readSeller(
  slug: string,
  options: SellersHandlerOptions = {},
): Promise<SellerLookup> {
  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}/v1/sellers/${encodeURIComponent(slug)}`, {
      method: 'GET',
    });
  } catch {
    return { kind: 'unavailable' };
  }

  if (upstream.status === 404) return { kind: 'not_found' };
  if (!upstream.ok) return { kind: 'unavailable' };

  try {
    const result = SellerProfileResponseSchema.safeParse(JSON.parse(await upstream.text()));
    return result.success
      ? { kind: 'found', seller: result.data.seller, availability: result.data.availability }
      : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/**
 * `GET /api/sellers/:slug`.
 *
 * A read with no side effect and no session, so there is no Origin check to make: a cross-origin reader
 * learns exactly what any visitor to the public profile already sees.
 */
export async function handleSeller(
  _request: Request,
  slug: string,
  options: SellersHandlerOptions = {},
): Promise<Response> {
  const found = await readSeller(slug, options);

  if (found.kind === 'not_found') {
    return problemResponse(404, 'Not Found', 'NOT_FOUND', 'The requested resource was not found.');
  }
  if (found.kind === 'unavailable') {
    return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.');
  }

  // Rebuilt from the validated fields rather than forwarded, so nothing the contract does not name can
  // travel onward.
  return new Response(JSON.stringify({ seller: found.seller, availability: found.availability }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * The authenticated seller's own identity (Phase 6-A).
 *
 * The same origin, the same internal hop and the same validate-then-rebuild rule as the public read
 * above — and one difference that matters: this one carries the caller's session. The access token comes
 * from the `__Host-mp_access` cookie and from nowhere else, travels as one header on one internal hop, and
 * the browser's own `Cookie` header is never forwarded. Nothing here logs a token.
 *
 * A GET applies no Origin check, matching every other read on this surface: there is nothing to forge
 * across origins when a request changes no state, and the response is `no-store` so nothing is cached for
 * the next visitor.
 *
 * Three refusals stay distinct because a surface acts differently on each: no session (401), not a seller
 * (404), unavailable (503). The 404 is passed through with the API's own problem body — "you have no
 * storefront" is the API's sentence to write, not this layer's.
 *
 * There is no page-side reader here yet, only the route handler: 6-A has no frontend, and a reader with no
 * caller would be a reader with no test that means anything.
 */

const IDENTITY_PROBLEM_STATUSES = new Set([401, 403, 404]);

export interface SellerIdentityHandlerOptions extends SellersHandlerOptions {
  /** The request's `Cookie` header, when a caller has it already. */
  readonly cookieHeader?: string | null;
}

/**
 * What a server-rendered seller surface learns about the caller's own storefront (Phase 6-B).
 *
 * Four outcomes, and the difference between the last three is what a page does about it:
 *
 *   * `ok` — render the storefront's state, whatever that state is.
 *   * `not_a_seller` — the caller has no storefront. Not an error and not an empty one: a page says so
 *     and offers the way in.
 *   * `unauthenticated` — the session ended between the page's own gate and this read. The page shows the
 *     session-ended view rather than a storefront.
 *   * `unavailable` — this service could not answer. Deliberately *not* folded into `not_a_seller`: a
 *     failing API must never read as "you are not a seller", which would be a page telling somebody their
 *     shop does not exist because a request timed out.
 *
 * The same one internal hop the route handler makes, on the server, with the token read from the
 * `__Host-mp_access` cookie and the response validated against the shared contract. A page never receives
 * the token and has no way to ask about another seller: the API accepts no identifier at all.
 */
export type SellerIdentityLookup =
  | { readonly kind: 'ok'; readonly seller: SellerIdentity }
  | { readonly kind: 'not_a_seller' }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'unavailable' };

export async function readSellerIdentity(
  options: SellerIdentityHandlerOptions = {},
): Promise<SellerIdentityLookup> {
  const accessToken = readAccessToken(options.cookieHeader ?? null);
  // No access cookie is no session: nothing is asked upstream, because there is nothing to ask about.
  if (accessToken === null) return { kind: 'unauthenticated' };

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}/v1/sellers/me`, {
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

  let parsed: ReturnType<typeof SellerIdentityResponseSchema.safeParse>;
  try {
    parsed = SellerIdentityResponseSchema.safeParse(JSON.parse(text));
  } catch {
    return { kind: 'unavailable' };
  }
  // Rebuilt from the validated fields: a seventh field the API somehow sent has nowhere to go.
  return parsed.success ? { kind: 'ok', seller: parsed.data.seller } : { kind: 'unavailable' };
}

/** `GET /api/sellers/me`. */
export async function handleSellerIdentity(
  request: Request,
  options: SellerIdentityHandlerOptions = {},
): Promise<Response> {
  const accessToken = readAccessToken(options.cookieHeader ?? request.headers.get('cookie'));
  if (accessToken === null) {
    return problemResponse(401, 'Unauthorized', 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  }

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}/v1/sellers/me`, {
      headers: { [SESSION_TOKEN_HEADER]: accessToken },
    });
  } catch {
    return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', PROBLEM.detail);
  }

  const text = await upstream.text();
  if (upstream.status !== 200) {
    if (!IDENTITY_PROBLEM_STATUSES.has(upstream.status)) {
      return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', PROBLEM.detail);
    }
    // The API's own problem body, with its own status and code. One sentence, written once.
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
    });
  }

  let validated: ReturnType<typeof SellerIdentityResponseSchema.safeParse>;
  try {
    validated = SellerIdentityResponseSchema.safeParse(JSON.parse(text));
  } catch {
    return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', PROBLEM.detail);
  }
  if (!validated.success) {
    return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', PROBLEM.detail);
  }

  return new Response(JSON.stringify({ seller: validated.data.seller }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * `POST /api/sellers/me` — create the caller's own storefront (Phase 6-C).
 *
 * The one write on this origin's seller surface, and it follows the 5-E write conventions exactly.
 *
 * **The order of the first two steps is the security property.** The Origin check runs *before* the session
 * cookie is read, so a cross-site form post is refused without this handler ever touching the caller's
 * session — a CSRF defence that read the cookie first would already have done the interesting part of the
 * work before deciding not to.
 *
 * **The token travels; the browser's `Cookie` header does not.** The access token is read from
 * `__Host-mp_access`, which JavaScript cannot see, and presented upstream in `x-session-token` alongside the
 * internal credential. No cookie is forwarded, so no upstream service sees one.
 *
 * **Both directions are validated against the shared contract.** The body is parsed with the strict
 * onboarding schema and the *validated* value is what goes upstream, so a field the contract does not name
 * cannot be forwarded even if a client sent it — `userId`, `status` and `verificationStatus` included. The
 * response is parsed too and rebuilt from the validated fields, so a drifted body becomes a clean failure
 * here instead of a half-created storefront in a browser.
 *
 * **201 exactly.** Not "any 2xx": an operation that answered 200 where its contract says 201 has drifted as
 * surely as one whose body has, and a client that rendered it would be rendering a guess. Every refusal the
 * operation's contract declares — 400, 401, 403, the two 409s and 429 — is forwarded with the API's own
 * problem body, because the API's wording is the approved wording; anything else becomes the generic 503.
 *
 * Nothing here logs. An onboarding body carries a legal name, contact details and an address, and the way to
 * keep those out of a log is to have no line that could take them.
 */
const ONBOARDING_PROBLEM_STATUSES = new Set([400, 401, 403, 409, 429]);

export async function handleSellerOnboarding(
  request: Request,
  options: SellerIdentityHandlerOptions = {},
): Promise<Response> {
  // First, before anything reads a cookie.
  const origin = checkSameOrigin({
    method: request.method,
    url: addressedOrigin(request),
    headers: request.headers,
  });
  if (!origin.ok) {
    return problemResponse(403, 'Forbidden', 'BAD_REQUEST', 'The request could not be processed.');
  }

  const accessToken = readAccessToken(options.cookieHeader ?? request.headers.get('cookie'));
  if (accessToken === null) {
    return problemResponse(401, 'Unauthorized', 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  }

  const raw = await request.text().catch(() => '');
  let body: unknown;
  try {
    body = JSON.parse(raw === '' ? 'null' : raw);
  } catch {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }

  // The strict contract, applied here as well as upstream. What is forwarded is the parsed value, never the
  // text the browser sent, so an unknown field has no route through this handler at all.
  const parsedRequest = SellerOnboardingRequestSchema.safeParse(body);
  if (!parsedRequest.success) {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}/v1/sellers/me`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_TOKEN_HEADER]: accessToken },
      body: JSON.stringify(parsedRequest.data),
    });
  } catch {
    return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', PROBLEM.detail);
  }

  const text = await upstream.text().catch(() => '');
  if (upstream.status !== 201) {
    if (!ONBOARDING_PROBLEM_STATUSES.has(upstream.status)) {
      return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', PROBLEM.detail);
    }
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
    });
  }

  let validated: ReturnType<typeof SellerOnboardingResponseSchema.safeParse>;
  try {
    validated = SellerOnboardingResponseSchema.safeParse(JSON.parse(text));
  } catch {
    return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', PROBLEM.detail);
  }
  if (!validated.success) {
    return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', PROBLEM.detail);
  }

  // Rebuilt from the validated fields: a seventh field the API somehow sent has nowhere to go.
  return new Response(JSON.stringify({ seller: validated.data.seller }), {
    status: 201,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * `PATCH /api/sellers/me` — edit the caller's own storefront (Phase 6-D).
 *
 * The same write conventions the creation follows, and the same reasons, with two differences that matter.
 *
 * **The success status is 200, and it is compared exactly.** An edit creates nothing, so 201 would be a
 * lie; and accepting "any 2xx" would let an operation that had drifted from its contract arrive as a
 * success a client then rendered.
 *
 * **404 is a refusal this operation declares.** A caller with no storefront is not a failure of the
 * service, and folding it into the generic 503 would tell somebody their connection was broken when their
 * account simply has no shop.
 *
 * Everything else is as before: the Origin check runs *before* the session cookie is read, so a cross-site
 * request is refused without this handler touching the caller's session; the access token leaves in
 * `x-session-token` alongside the internal credential and the browser's own `Cookie` header is never
 * forwarded; the body is parsed with the strict update schema and the *validated* value is what goes
 * upstream, so a `slug`, `userId` or `status` a client invented has no route through here at all; and the
 * response is parsed and rebuilt from the validated fields.
 *
 * Absent and null survive that round trip intact, which is the whole of the partial-update contract:
 * `JSON.stringify` drops a key the schema left absent and keeps one whose value is `null`, so "leave this
 * alone" and "empty this" reach the API as the different requests they are.
 *
 * Nothing here logs. An edit carries a legal name, contact details and an address.
 */
const UPDATE_PROBLEM_STATUSES = new Set([400, 401, 403, 404, 409, 429]);

export async function handleSellerProfileUpdate(
  request: Request,
  options: SellerIdentityHandlerOptions = {},
): Promise<Response> {
  // First, before anything reads a cookie.
  const origin = checkSameOrigin({
    method: request.method,
    url: addressedOrigin(request),
    headers: request.headers,
  });
  if (!origin.ok) {
    return problemResponse(403, 'Forbidden', 'BAD_REQUEST', 'The request could not be processed.');
  }

  const accessToken = readAccessToken(options.cookieHeader ?? request.headers.get('cookie'));
  if (accessToken === null) {
    return problemResponse(401, 'Unauthorized', 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  }

  const raw = await request.text().catch(() => '');
  let body: unknown;
  try {
    body = JSON.parse(raw === '' ? 'null' : raw);
  } catch {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }

  const parsedRequest = SellerProfileUpdateRequestSchema.safeParse(body);
  if (!parsedRequest.success) {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}/v1/sellers/me`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', [SESSION_TOKEN_HEADER]: accessToken },
      body: JSON.stringify(parsedRequest.data),
    });
  } catch {
    return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', PROBLEM.detail);
  }

  const text = await upstream.text().catch(() => '');
  if (upstream.status !== 200) {
    if (!UPDATE_PROBLEM_STATUSES.has(upstream.status)) {
      return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', PROBLEM.detail);
    }
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
    });
  }

  let validated: ReturnType<typeof SellerProfileUpdateResponseSchema.safeParse>;
  try {
    validated = SellerProfileUpdateResponseSchema.safeParse(JSON.parse(text));
  } catch {
    return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', PROBLEM.detail);
  }
  if (!validated.success) {
    return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', PROBLEM.detail);
  }

  // Rebuilt from the validated fields: a seventh field the API somehow sent has nowhere to go.
  return new Response(JSON.stringify({ seller: validated.data.seller }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * The two seller media routes on this origin (Phase 6-E).
 *
 * `POST /api/sellers/me/media/uploads` authorizes one upload; `POST /api/sellers/me/media` confirms it. Both
 * follow the write conventions 5-E established and 6-C and 6-D reuse, so the shared part is written once
 * below: the Origin check *before* the session cookie is read, the token presented upstream in
 * `x-session-token` alongside the internal credential, the browser's own `Cookie` never forwarded, the body
 * parsed with the strict contract and the *validated* value forwarded, the response parsed and rebuilt, and
 * one exact success status per operation.
 *
 * What is specific to media is what must not appear in a log: the authorization's response carries a signed
 * upload URL, which is a short-lived credential for one object. Nothing here logs, and nothing here inspects
 * that URL beyond the contract check — the BFF passes it to the browser that asked for it and keeps no copy.
 *
 * 404 is a declared refusal for both: a caller with no storefront, and — for the confirmation — an object that
 * is not in storage. Neither is a service failure, so neither becomes a 503.
 */
const MEDIA_PROBLEM_STATUSES = new Set([400, 401, 403, 404, 409, 429]);

async function sellerMediaWrite(
  request: Request,
  options: SellerIdentityHandlerOptions,
  path: string,
  expected: 200 | 201,
  parseRequest: (payload: unknown) => unknown | null,
  parseResponse: (payload: unknown) => unknown | null,
): Promise<Response> {
  // First, before anything reads a cookie.
  const origin = checkSameOrigin({
    method: request.method,
    url: addressedOrigin(request),
    headers: request.headers,
  });
  if (!origin.ok) {
    return problemResponse(403, 'Forbidden', 'BAD_REQUEST', 'The request could not be processed.');
  }

  const accessToken = readAccessToken(options.cookieHeader ?? request.headers.get('cookie'));
  if (accessToken === null) {
    return problemResponse(401, 'Unauthorized', 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  }

  const raw = await request.text().catch(() => '');
  let body: unknown;
  try {
    body = JSON.parse(raw === '' ? 'null' : raw);
  } catch {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }

  const validatedRequest = parseRequest(body);
  if (validatedRequest === null) {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_TOKEN_HEADER]: accessToken },
      body: JSON.stringify(validatedRequest),
    });
  } catch {
    return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', PROBLEM.detail);
  }

  const text = await upstream.text().catch(() => '');
  if (upstream.status !== expected) {
    if (!MEDIA_PROBLEM_STATUSES.has(upstream.status)) {
      return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', PROBLEM.detail);
    }
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
    });
  }

  let validated: unknown;
  try {
    validated = parseResponse(JSON.parse(text));
  } catch {
    return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', PROBLEM.detail);
  }
  if (validated === null) {
    return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', PROBLEM.detail);
  }

  return new Response(JSON.stringify(validated), {
    status: expected,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** `POST /api/sellers/me/media/uploads` — authorize one seller media upload. */
export async function handleSellerMediaUpload(
  request: Request,
  options: SellerIdentityHandlerOptions = {},
): Promise<Response> {
  return sellerMediaWrite(
    request,
    options,
    '/v1/sellers/me/media/uploads',
    201,
    (payload) => {
      const parsed = SellerMediaUploadRequestSchema.safeParse(payload);
      return parsed.success ? parsed.data : null;
    },
    (payload) => {
      const parsed = SellerMediaUploadResponseSchema.safeParse(payload);
      // Rebuilt from the validated fields: a field the contract does not name has nowhere to go, and the
      // upload URL reaches the browser exactly as the API issued it.
      return parsed.success ? { upload: parsed.data.upload } : null;
    },
  );
}

/** `POST /api/sellers/me/media` — confirm one seller media upload. */
export async function handleSellerMediaAttach(
  request: Request,
  options: SellerIdentityHandlerOptions = {},
): Promise<Response> {
  return sellerMediaWrite(
    request,
    options,
    '/v1/sellers/me/media',
    200,
    (payload) => {
      const parsed = SellerMediaAttachRequestSchema.safeParse(payload);
      return parsed.success ? parsed.data : null;
    },
    (payload) => {
      const parsed = SellerMediaAttachResponseSchema.safeParse(payload);
      return parsed.success ? { media: parsed.data.media } : null;
    },
  );
}
