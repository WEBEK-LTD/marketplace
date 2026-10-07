import 'server-only';
import {
  CreateSeoRedirectRequestSchema,
  CreateSeoRedirectResponseSchema,
  PROBLEM_JSON_MEDIA_TYPE,
  SESSION_TOKEN_HEADER,
  SeoRedirectDetailResponseSchema,
  SeoRedirectStateRequestSchema,
  SeoRedirectWriteResponseSchema,
  SeoRedirectsResponseSchema,
  UpdateSeoRedirectRequestSchema,
  type SeoRedirectDetail,
  type SeoRedirectsResponse,
} from '@repo/contracts';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { readAdminAccessToken } from './staff-session';

/**
 * The SEO redirect map, on the admin origin.
 *
 * **The session never leaves the server.** The caller's access token lives in `__Host-mp_admin_access`, which
 * JavaScript cannot read; it is presented to the API on one internal hop in the session-token header, and the
 * browser's own `Cookie` header is never forwarded.
 *
 * **Nothing about the caller crosses in a request.** No account, no role, no permission key and no assurance level
 * appears in anything built here. The API resolves all of it from the session, and the database re-applies the
 * permission test with `seo.redirect.read` or `seo.redirect.manage` as a literal.
 *
 * **Responses are validated, not forwarded.** A drifted body becomes a clean failure here instead of a
 * half-rendered screen, and a field the contract does not name cannot reach a browser even if the API sent one.
 *
 * **Every write is same-origin and rebuilt.** The body a browser submits is parsed, validated against the shared
 * contract, and re-serialised from the validated value — so a field nobody declared cannot travel upstream, and a
 * cross-origin form cannot submit one at all. That is what keeps `isActive` out of an edit: the contract drops it,
 * so a rename cannot switch a redirect on even if a browser asks it to.
 *
 * **Refusals are forwarded with the API's own problem body**, because this surface has two of them an operator has
 * to be able to read: another entry already claims the address, or the entry is not a legal one. A generic failure
 * would leave somebody guessing which.
 *
 * **Cursors stay opaque.** A cursor is passed along as text and never parsed or reconstructed here.
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
  problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.');
const SESSION_REQUIRED = (): Response =>
  problemResponse(401, 'Unauthorized', 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
const VALIDATION_FAILED = (): Response =>
  problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');

/** The statuses the API may refuse a write with. Anything else becomes the generic outage. */
const WRITE_PROBLEM_STATUSES = new Set([400, 401, 403, 404, 409, 429, 503]);

export interface SeoRedirectsOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

/**
 * What a read resolved to.
 *
 * `notFound` is the API's one neutral answer: no such entry, or a caller without the key the operation needs. The
 * console does not try to tell those apart, because the API deliberately does not.
 */
export type SeoRedirectsResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' };

/** base64url, which is the whole of what a cursor can be. Refused here rather than forwarded. */
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function identifier(value: string | null): string | null {
  return value !== null && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function query(input: {
  readonly cursor?: string | null;
  readonly limit?: string | null;
  readonly search?: string | null;
  readonly active?: string | null;
}): string {
  const params = new URLSearchParams();
  if (typeof input.limit === 'string' && /^\d{1,3}$/.test(input.limit)) params.set('limit', input.limit);
  // The search is a literal substring upstream, so there is nothing to escape; it is bounded only so a
  // pathological value cannot travel.
  if (typeof input.search === 'string' && input.search !== '' && input.search.length <= 2048) {
    params.set('search', input.search);
  }
  if (input.active === 'true' || input.active === 'false') params.set('active', input.active);
  if (typeof input.cursor === 'string' && CURSOR_PATTERN.test(input.cursor)) {
    // Passed along as text. This layer does not know what a cursor contains and must not learn.
    params.set('cursor', input.cursor);
  }
  return params.size === 0 ? '' : `?${params.toString()}`;
}

async function read<T>(
  path: string,
  options: SeoRedirectsOptions,
  parse: (body: unknown) => { success: true; data: T } | { success: false },
): Promise<SeoRedirectsResult<T>> {
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

/** One page of the map, newest edit first. */
export async function readSeoRedirectList(
  input: {
    readonly cursor?: string | null;
    readonly limit?: string | null;
    readonly search?: string | null;
    readonly active?: string | null;
  } = {},
  options: SeoRedirectsOptions = {},
): Promise<SeoRedirectsResult<SeoRedirectsResponse>> {
  return await read(`/v1/admin/seo/redirects${query(input)}`, options, (body) =>
    SeoRedirectsResponseSchema.safeParse(body),
  );
}

/**
 * One entry, with the manage capability and where its chain ends.
 *
 * A malformed id is `notFound` here rather than a validation failure: the value came from the address somebody
 * typed, and the honest answer to a made-up address is that there is nothing at it.
 */
export async function readSeoRedirectDetail(
  redirectId: string | undefined,
  options: SeoRedirectsOptions = {},
): Promise<SeoRedirectsResult<SeoRedirectDetail>> {
  const id = identifier(redirectId ?? null);
  if (id === null) return { kind: 'notFound' };
  const result = await read(`/v1/admin/seo/redirects/${encodeURIComponent(id)}`, options, (body) =>
    SeoRedirectDetailResponseSchema.safeParse(body),
  );
  return result.kind === 'ok' ? { kind: 'ok', data: result.data.redirect } : result;
}

/* ------------------------------------------------------------------------------------------------ */
/* Writes                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

async function acceptWrite(
  request: Request,
  options: SeoRedirectsOptions,
): Promise<{ refusal: Response } | { accessToken: string; body: Record<string, unknown> }> {
  const origin = checkSameOrigin({
    method: request.method,
    url: addressedOrigin(request),
    headers: request.headers,
  });
  if (!origin.ok) {
    return { refusal: problemResponse(403, 'Forbidden', 'BAD_REQUEST', 'The request could not be processed.') };
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
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  accessToken: string,
  body: unknown,
  options: SeoRedirectsOptions,
): Promise<Response | null> {
  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);
  try {
    return await fetcher(`${config.apiBaseUrl}${path}`, {
      method,
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
 * A recognised refusal is forwarded with the API's own problem body, so a screen can say "another redirect already
 * starts from that address" rather than a generic failure. Anything else becomes the generic 503, and success is
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

/** `POST /api/seo/redirects` — add an entry. */
export async function handleSeoRedirectCreate(
  request: Request,
  options: SeoRedirectsOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const validated = CreateSeoRedirectRequestSchema.safeParse({
    fromPath: accepted.body['fromPath'],
    toPath: accepted.body['toPath'],
    ...('statusCode' in accepted.body ? { statusCode: accepted.body['statusCode'] } : {}),
    ...('note' in accepted.body ? { note: accepted.body['note'] } : {}),
    ...('isActive' in accepted.body ? { isActive: accepted.body['isActive'] } : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite('POST', '/v1/admin/seo/redirects', accepted.accessToken, validated.data, options);
  return await writeOutcome(upstream, 201, (body) => CreateSeoRedirectResponseSchema.safeParse(body));
}

/**
 * `PATCH /api/seo/redirects` — change an entry's addresses, status code or note.
 *
 * The entry is named in the body because this origin exposes one route rather than a route per entry, and it is
 * turned into a path segment after being checked for shape. **An `isActive` field in the body is dropped**, not
 * forwarded: switching an entry on has its own route, and a rename must not be able to do it.
 */
export async function handleSeoRedirectUpdate(
  request: Request,
  options: SeoRedirectsOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(typeof accepted.body['redirectId'] === 'string' ? accepted.body['redirectId'] : null);
  if (id === null) return VALIDATION_FAILED();

  const validated = UpdateSeoRedirectRequestSchema.safeParse({
    ...('fromPath' in accepted.body ? { fromPath: accepted.body['fromPath'] } : {}),
    ...('toPath' in accepted.body ? { toPath: accepted.body['toPath'] } : {}),
    ...('statusCode' in accepted.body ? { statusCode: accepted.body['statusCode'] } : {}),
    ...('note' in accepted.body ? { note: accepted.body['note'] } : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PATCH',
    `/v1/admin/seo/redirects/${encodeURIComponent(id)}`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => SeoRedirectWriteResponseSchema.safeParse(body));
}

/** `PUT /api/seo/redirects/state` — switch an entry on or off. The only route that can. */
export async function handleSeoRedirectState(
  request: Request,
  options: SeoRedirectsOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(typeof accepted.body['redirectId'] === 'string' ? accepted.body['redirectId'] : null);
  if (id === null) return VALIDATION_FAILED();

  const validated = SeoRedirectStateRequestSchema.safeParse({ isActive: accepted.body['isActive'] });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PUT',
    `/v1/admin/seo/redirects/${encodeURIComponent(id)}/state`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => SeoRedirectWriteResponseSchema.safeParse(body));
}

/**
 * `POST /api/seo/redirects/remove` — remove an entry.
 *
 * A `POST` carrying what to remove rather than a `DELETE` on this origin, because the same-origin check this module
 * applies reads a submitted body and the browser form that drives it submits one. The upstream call is a `DELETE`,
 * which is the verb the API actually has.
 */
export async function handleSeoRedirectRemove(
  request: Request,
  options: SeoRedirectsOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(typeof accepted.body['redirectId'] === 'string' ? accepted.body['redirectId'] : null);
  if (id === null) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'DELETE',
    `/v1/admin/seo/redirects/${encodeURIComponent(id)}`,
    accepted.accessToken,
    undefined,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => SeoRedirectWriteResponseSchema.safeParse(body));
}
