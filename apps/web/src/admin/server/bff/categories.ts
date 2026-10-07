import 'server-only';
import {
  AdminCategoryDetailResponseSchema,
  AdminCategoryTreeResponseSchema,
  CategoryStateRequestSchema,
  CategoryWriteResponseSchema,
  CreateCategoryRequestSchema,
  CreateCategoryResponseSchema,
  PROBLEM_JSON_MEDIA_TYPE,
  SESSION_TOKEN_HEADER,
  SaveCategoryTranslationRequestSchema,
  UpdateCategoryRequestSchema,
  type AdminCategoryDetailResponse,
  type AdminCategoryTreeResponse,
} from '@repo/contracts';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { readAdminAccessToken } from './staff-session';

/**
 * The category tree, on the admin origin.
 *
 * **The session never leaves the server.** The caller's access token lives in `__Host-mp_admin_access`, which
 * JavaScript cannot read; it is presented to the API on one internal hop in the session-token header, and the
 * browser's own `Cookie` header is never forwarded.
 *
 * **Nothing about the caller crosses in a request.** No account, no role, no permission key and no assurance
 * level appears in anything built here. The API resolves all of it from the session, and the database re-applies
 * the test with `catalog.category.read` or `catalog.category.manage` as a literal.
 *
 * **Responses are validated, not forwarded**, so a drifted body becomes a clean failure rather than a
 * half-rendered tree, and a field the contract does not name cannot reach a browser even if the API sent one.
 *
 * **Every write is same-origin and rebuilt** from the shared contract, which is also what makes a rename
 * unexpressible from a browser: `UpdateCategoryRequestSchema` is strict and has no `slug`, so a submitted one is
 * a validation failure here, upstream, and in the database's own signature.
 *
 * **Refusals are forwarded with the API's own problem body**, because this surface has four a person must be
 * able to read apart: the tree refused the move, the address is taken, the category has to be named first, and a
 * value is too long. A generic failure would leave somebody guessing which.
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCALE_PATTERN = /^[a-z]{2}$/;

export interface CategoriesOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

/**
 * What a read resolved to.
 *
 * `notFound` is the API's one neutral answer: no such category, or a caller without the key the operation needs.
 * The console does not try to tell those apart, because the API deliberately does not.
 */
export type CategoriesResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' };

function identifier(value: string | null | undefined): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function localeCode(value: string | null | undefined): string | null {
  return typeof value === 'string' && LOCALE_PATTERN.test(value) ? value : null;
}

async function read<T>(
  path: string,
  options: CategoriesOptions,
  parse: (body: unknown) => { success: true; data: T } | { success: false },
): Promise<CategoriesResult<T>> {
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
/* Reads                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

/** The whole tree, including the inactive. */
export async function readCategoryTree(
  options: CategoriesOptions = {},
): Promise<CategoriesResult<AdminCategoryTreeResponse>> {
  return await read('/v1/admin/categories', options, (body) => AdminCategoryTreeResponseSchema.safeParse(body));
}

/**
 * One category and every locale it has been written in.
 *
 * A malformed id is `notFound` rather than a validation failure: the value came from the address somebody typed,
 * and the honest answer to a made-up address is that there is nothing at it.
 */
export async function readCategoryDetail(
  categoryId: string | undefined,
  options: CategoriesOptions = {},
): Promise<CategoriesResult<AdminCategoryDetailResponse>> {
  const id = identifier(categoryId);
  if (id === null) return { kind: 'notFound' };
  return await read(`/v1/admin/categories/${encodeURIComponent(id)}`, options, (body) =>
    AdminCategoryDetailResponseSchema.safeParse(body),
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Writes                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

async function acceptWrite(
  request: Request,
  options: CategoriesOptions,
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
  options: CategoriesOptions,
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

/** `POST /api/categories` — create one category, always hidden. */
export async function handleCategoryCreate(request: Request, options: CategoriesOptions = {}): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const parsed = CreateCategoryRequestSchema.safeParse(accepted.body);
  if (!parsed.success) return VALIDATION_FAILED();

  const upstream = await callWrite('POST', '/v1/admin/categories', accepted.accessToken, parsed.data, options);
  return await writeOutcome(upstream, 201, (body) => CreateCategoryResponseSchema.safeParse(body));
}

/** `PATCH /api/categories` — parent, surface and ordering. Never the slug, and never the state. */
export async function handleCategoryUpdate(request: Request, options: CategoriesOptions = {}): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(typeof accepted.body.categoryId === 'string' ? accepted.body.categoryId : null);
  if (id === null) return VALIDATION_FAILED();

  const { categoryId: _categoryId, ...rest } = accepted.body;
  const parsed = UpdateCategoryRequestSchema.safeParse(rest);
  if (!parsed.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PATCH',
    `/v1/admin/categories/${encodeURIComponent(id)}`,
    accepted.accessToken,
    parsed.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => CategoryWriteResponseSchema.safeParse(body));
}

/** `PUT /api/categories/state` — show or hide one category. */
export async function handleCategoryState(request: Request, options: CategoriesOptions = {}): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(typeof accepted.body.categoryId === 'string' ? accepted.body.categoryId : null);
  if (id === null) return VALIDATION_FAILED();

  const parsed = CategoryStateRequestSchema.safeParse({ isActive: accepted.body.isActive });
  if (!parsed.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PUT',
    `/v1/admin/categories/${encodeURIComponent(id)}/state`,
    accepted.accessToken,
    parsed.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => CategoryWriteResponseSchema.safeParse(body));
}

/** `PUT /api/categories/translations` — write one locale. */
export async function handleCategoryTranslationSave(
  request: Request,
  options: CategoriesOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(typeof accepted.body.categoryId === 'string' ? accepted.body.categoryId : null);
  const locale = localeCode(typeof accepted.body.localeCode === 'string' ? accepted.body.localeCode : null);
  if (id === null || locale === null) return VALIDATION_FAILED();

  const { categoryId: _categoryId, localeCode: _localeCode, ...rest } = accepted.body;
  const parsed = SaveCategoryTranslationRequestSchema.safeParse(rest);
  if (!parsed.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PUT',
    `/v1/admin/categories/${encodeURIComponent(id)}/translations/${encodeURIComponent(locale)}`,
    accepted.accessToken,
    parsed.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => CategoryWriteResponseSchema.safeParse(body));
}

/**
 * `POST /api/categories/translations/remove` — remove one locale.
 *
 * A browser form cannot send a `DELETE`, so the removal is a `POST` on its own path here and a `DELETE` upstream.
 * The verb the API offers is the one that is used; this is a form submitting to it.
 */
export async function handleCategoryTranslationRemove(
  request: Request,
  options: CategoriesOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(typeof accepted.body.categoryId === 'string' ? accepted.body.categoryId : null);
  const locale = localeCode(typeof accepted.body.localeCode === 'string' ? accepted.body.localeCode : null);
  if (id === null || locale === null) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'DELETE',
    `/v1/admin/categories/${encodeURIComponent(id)}/translations/${encodeURIComponent(locale)}`,
    accepted.accessToken,
    undefined,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => CategoryWriteResponseSchema.safeParse(body));
}
