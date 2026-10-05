import 'server-only';
import {
  CMS_PAGE_STATUSES,
  CmsPageDetailResponseSchema,
  CmsPagePageResponseSchema,
  CmsPageCoverRequestSchema,
  CmsPageStatusRequestSchema,
  CmsPageWriteResponseSchema,
  CreateCmsPageRequestSchema,
  CreateCmsPageResponseSchema,
  PROBLEM_JSON_MEDIA_TYPE,
  SESSION_TOKEN_HEADER,
  SaveCmsPageTranslationRequestSchema,
  UpdateCmsPageRequestSchema,
  type CmsPageDetail,
  type CmsPagePageResponse,
} from '@repo/contracts';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { readAdminAccessToken } from './staff-session';

/**
 * CMS static pages, on the admin origin.
 *
 * **The session never leaves the server.** The caller's access token lives in `__Host-mp_admin_access`, which
 * JavaScript cannot read; it is presented to the API on one internal hop in the session-token header, and the
 * browser's own `Cookie` header is never forwarded.
 *
 * **Nothing about the caller crosses in a request.** No account, no role, no permission key and no assurance
 * level appears in anything built here. The API resolves all of it from the session, and the database
 * re-applies the permission test with `cms.page.read` or `cms.page.manage` as a literal.
 *
 * **Responses are validated, not forwarded.** A drifted body becomes a clean failure here instead of a
 * half-rendered screen, and a field the contract does not name cannot reach a browser even if the API sent one.
 *
 * **Every write is same-origin and rebuilt.** The body a browser submits is parsed, validated against the
 * shared contract, and re-serialised from the validated value — so a field nobody declared cannot travel
 * upstream, and a cross-origin form cannot submit one at all.
 *
 * **Refusals are forwarded with the API's own problem body**, because this surface has three of them that a
 * person has to be able to read: a page that cannot be published until it is written, a lifecycle change that
 * does not exist, and an address that belongs to another page's history. A generic failure would leave somebody
 * guessing which.
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

export interface CmsPagesOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

/**
 * What a read resolved to.
 *
 * `notFound` is the API's one neutral answer: no such page, or a caller without the key the operation needs.
 * The console does not try to tell those apart, because the API deliberately does not — and with two keys that
 * are not always held together, that is the whole protection.
 */
export type CmsPagesResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' };

/** base64url, which is the whole of what a cursor can be. Refused here rather than forwarded. */
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCALE_PATTERN = /^[a-z]{2}$/;

function identifier(value: string | null): string | null {
  return value !== null && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function query(input: {
  readonly cursor?: string | null;
  readonly limit?: string | null;
  readonly status?: string | null;
}): string {
  const params = new URLSearchParams();
  if (typeof input.limit === 'string' && /^\d{1,3}$/.test(input.limit)) params.set('limit', input.limit);
  if (typeof input.status === 'string' && (CMS_PAGE_STATUSES as readonly string[]).includes(input.status)) {
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
  options: CmsPagesOptions,
  parse: (body: unknown) => { success: true; data: T } | { success: false },
): Promise<CmsPagesResult<T>> {
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

/** One page of authored pages, newest edit first. */
export async function readCmsPageList(
  input: {
    readonly cursor?: string | null;
    readonly limit?: string | null;
    readonly status?: string | null;
  } = {},
  options: CmsPagesOptions = {},
): Promise<CmsPagesResult<CmsPagePageResponse>> {
  return await read(`/v1/admin/cms/pages${query(input)}`, options, (body) =>
    CmsPagePageResponseSchema.safeParse(body),
  );
}

/**
 * One page, with its previous slugs and every locale.
 *
 * A malformed id is `notFound` here rather than a validation failure: the value came from the address somebody
 * typed, and the honest answer to a made-up address is that there is nothing at it.
 */
export async function readCmsPageDetail(
  pageId: string | undefined,
  options: CmsPagesOptions = {},
): Promise<CmsPagesResult<CmsPageDetail>> {
  const id = identifier(pageId ?? null);
  if (id === null) return { kind: 'notFound' };
  const result = await read(`/v1/admin/cms/pages/${encodeURIComponent(id)}`, options, (body) =>
    CmsPageDetailResponseSchema.safeParse(body),
  );
  return result.kind === 'ok' ? { kind: 'ok', data: result.data.page } : result;
}

/* ------------------------------------------------------------------------------------------------ */
/* Writes                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

async function acceptWrite(
  request: Request,
  options: CmsPagesOptions,
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

/**
 * Calls one upstream write.
 *
 * The method is a parameter here, where other modules on this origin hardcode `POST`, because this surface has
 * a create, a partial update, two replacements and a removal — and expressing a removal as a `POST` would mean
 * inventing a verb the API does not have.
 */
async function callWrite(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  accessToken: string,
  body: unknown,
  options: CmsPagesOptions,
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
 * A recognised refusal is forwarded with the API's own problem body, so a screen can say "this page has to be
 * written before it can be published" rather than a generic failure. Anything else becomes the generic 503, and
 * success is the expected status exactly, re-validated before a byte of it reaches a browser.
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

/** `POST /api/cms/pages` — create a draft. */
export async function handleCmsPageCreate(
  request: Request,
  options: CmsPagesOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const validated = CreateCmsPageRequestSchema.safeParse({
    slug: accepted.body['slug'],
    ...('pageKey' in accepted.body ? { pageKey: accepted.body['pageKey'] } : {}),
    ...('template' in accepted.body ? { template: accepted.body['template'] } : {}),
    ...('sortOrder' in accepted.body ? { sortOrder: accepted.body['sortOrder'] } : {}),
    ...('isIndexable' in accepted.body ? { isIndexable: accepted.body['isIndexable'] } : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite('POST', '/v1/admin/cms/pages', accepted.accessToken, validated.data, options);
  return await writeOutcome(upstream, 201, (body) => CreateCmsPageResponseSchema.safeParse(body));
}

/**
 * `PATCH /api/cms/pages` — change a page's address or presentation.
 *
 * The page is named in the body because this origin exposes one route rather than a route per page, and it is
 * turned into a path segment after being checked for shape. **A `status` field in the body is dropped**, not
 * forwarded: publishing has its own route, and a rename must not be able to publish.
 */
export async function handleCmsPageUpdate(
  request: Request,
  options: CmsPagesOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(typeof accepted.body['pageId'] === 'string' ? accepted.body['pageId'] : null);
  if (id === null) return VALIDATION_FAILED();

  const validated = UpdateCmsPageRequestSchema.safeParse({
    ...('slug' in accepted.body ? { slug: accepted.body['slug'] } : {}),
    ...('pageKey' in accepted.body ? { pageKey: accepted.body['pageKey'] } : {}),
    ...('template' in accepted.body ? { template: accepted.body['template'] } : {}),
    ...('sortOrder' in accepted.body ? { sortOrder: accepted.body['sortOrder'] } : {}),
    ...('isIndexable' in accepted.body ? { isIndexable: accepted.body['isIndexable'] } : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PATCH',
    `/v1/admin/cms/pages/${encodeURIComponent(id)}`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => CmsPageWriteResponseSchema.safeParse(body));
}

/** `PUT /api/cms/pages/status` — move a page through its lifecycle. The only route that can publish one. */
export async function handleCmsPageStatus(
  request: Request,
  options: CmsPagesOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(typeof accepted.body['pageId'] === 'string' ? accepted.body['pageId'] : null);
  if (id === null) return VALIDATION_FAILED();

  const validated = CmsPageStatusRequestSchema.safeParse({
    status: accepted.body['status'],
    ...('scheduledFor' in accepted.body ? { scheduledFor: accepted.body['scheduledFor'] } : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PUT',
    `/v1/admin/cms/pages/${encodeURIComponent(id)}/status`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => CmsPageWriteResponseSchema.safeParse(body));
}

/**
 * `PUT /api/cms/pages/cover` — attach or remove a page's cover image (0099).
 *
 * The body carries `mediaId`, and the two cases are the two operations: a uuid attaches that library entry
 * and an explicit `null` removes whatever is attached. An empty string from a form field is read as the
 * clear, because a cleared text input is how an operator says "no cover" in a console with no picker.
 *
 * Nothing about the library is reachable from here: no listing, no upload, no signed URL.
 */
export async function handleCmsPageCover(
  request: Request,
  options: CmsPagesOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(typeof accepted.body['pageId'] === 'string' ? accepted.body['pageId'] : null);
  if (id === null) return VALIDATION_FAILED();

  // The field has to be there, and it has to be a string or null. Anything else is refused rather than read
  // as a removal: a number or an object falling through to "clear" would turn a malformed request into a
  // destructive one, which is the opposite of what a caller sending nonsense meant.
  if (!('mediaId' in accepted.body)) return VALIDATION_FAILED();
  const supplied = accepted.body['mediaId'];
  if (supplied !== null && typeof supplied !== 'string') return VALIDATION_FAILED();

  const trimmed = supplied === null ? '' : supplied.trim();
  const mediaId = trimmed === '' ? null : trimmed;

  const validated = CmsPageCoverRequestSchema.safeParse({ mediaId });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PUT',
    `/v1/admin/cms/pages/${encodeURIComponent(id)}/cover`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => CmsPageWriteResponseSchema.safeParse(body));
}

/** `PUT /api/cms/pages/translations` — write one locale. */
export async function handleCmsPageTranslationSave(
  request: Request,
  options: CmsPagesOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(typeof accepted.body['pageId'] === 'string' ? accepted.body['pageId'] : null);
  const locale = typeof accepted.body['localeCode'] === 'string' ? accepted.body['localeCode'] : '';
  if (id === null || !LOCALE_PATTERN.test(locale)) return VALIDATION_FAILED();

  const validated = SaveCmsPageTranslationRequestSchema.safeParse({
    title: accepted.body['title'],
    body: accepted.body['body'],
    ...('excerpt' in accepted.body ? { excerpt: accepted.body['excerpt'] } : {}),
    ...('metaTitle' in accepted.body ? { metaTitle: accepted.body['metaTitle'] } : {}),
    ...('metaDescription' in accepted.body ? { metaDescription: accepted.body['metaDescription'] } : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PUT',
    `/v1/admin/cms/pages/${encodeURIComponent(id)}/translations/${encodeURIComponent(locale)}`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => CmsPageWriteResponseSchema.safeParse(body));
}

/**
 * `POST /api/cms/pages/translations/remove` — remove one locale.
 *
 * A `POST` carrying what to remove rather than a `DELETE` on this origin, because the same-origin check this
 * module applies reads a submitted body, and the browser form that drives it submits one. The upstream call is
 * a `DELETE`, which is the verb the API actually has.
 */
export async function handleCmsPageTranslationRemove(
  request: Request,
  options: CmsPagesOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(typeof accepted.body['pageId'] === 'string' ? accepted.body['pageId'] : null);
  const locale = typeof accepted.body['localeCode'] === 'string' ? accepted.body['localeCode'] : '';
  if (id === null || !LOCALE_PATTERN.test(locale)) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'DELETE',
    `/v1/admin/cms/pages/${encodeURIComponent(id)}/translations/${encodeURIComponent(locale)}`,
    accepted.accessToken,
    undefined,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => CmsPageWriteResponseSchema.safeParse(body));
}
