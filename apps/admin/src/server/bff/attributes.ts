import 'server-only';
import {
  AdminAttributeDefinitionsResponseSchema,
  AdminAttributeDetailResponseSchema,
  AdminCategoryAttributesResponseSchema,
  AdminTagsResponseSchema,
  AttachCategoryAttributeRequestSchema,
  CreateAttributeDefinitionRequestSchema,
  CreateAttributeDefinitionResponseSchema,
  CreateAttributeOptionRequestSchema,
  CreateAttributeOptionResponseSchema,
  CreateTagRequestSchema,
  CreateTagResponseSchema,
  PROBLEM_JSON_MEDIA_TYPE,
  SESSION_TOKEN_HEADER,
  UpdateAttributeDefinitionRequestSchema,
  UpdateAttributeOptionRequestSchema,
  UpdateTagRequestSchema,
  VocabularyStateRequestSchema,
  VocabularyWriteResponseSchema,
  type AdminAttributeDefinitionsResponse,
  type AdminAttributeDetailResponse,
  type AdminCategoryAttributesResponse,
  type AdminTagsResponse,
} from '@repo/contracts';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { readAdminAccessToken } from './staff-session';

/**
 * The attribute and tag vocabulary, on the admin origin.
 *
 * **The session never leaves the server.** The caller's access token lives in `__Host-mp_admin_access`, which
 * JavaScript cannot read; it is presented to the API on one internal hop in the session-token header, and the
 * browser's own `Cookie` header is never forwarded.
 *
 * **Nothing about the caller crosses in a request.** No account, no role, no permission key and no assurance level
 * appears in anything built here. The API resolves all of it from the session, and the database re-applies the
 * test with `catalog.attribute.manage`, `catalog.tag.manage` or `catalog.category.manage` as a literal.
 *
 * **Responses are validated, not forwarded**, so a drifted body becomes a clean failure rather than a half-rendered
 * screen, and a field the contract does not name cannot reach a browser even if the API sent one.
 *
 * **Every write is same-origin and rebuilt** from the shared contract, which is also what makes renaming a key, an
 * option value or a tag slug unexpressible from a browser: the update schemas are strict and carry none of them, so
 * a submitted one is a validation failure here, upstream, and in the database's own signature.
 *
 * **Refusals are forwarded with the API's own problem body**, because this surface has three a person must be able
 * to read apart: the name is taken, the change would leave sellers unable to answer, and a value is not allowed.
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

export interface AttributesOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

/**
 * What a read resolved to.
 *
 * `notFound` is the API's one neutral answer: no such attribute, option or tag, or a caller without the key the
 * operation needs. The console does not try to tell those apart, because the API deliberately does not.
 */
export type AttributesResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' };

function identifier(value: string | null | undefined): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

async function read<T>(
  path: string,
  options: AttributesOptions,
  parse: (body: unknown) => { success: true; data: T } | { success: false },
): Promise<AttributesResult<T>> {
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

/** The whole attribute vocabulary, including the hidden. */
export async function readAttributeVocabulary(
  options: AttributesOptions = {},
): Promise<AttributesResult<AdminAttributeDefinitionsResponse>> {
  return await read('/v1/admin/attributes', options, (body) =>
    AdminAttributeDefinitionsResponseSchema.safeParse(body),
  );
}

/**
 * One attribute and its options.
 *
 * A malformed id is `notFound` rather than a validation failure: the value came from the address somebody typed,
 * and the honest answer to a made-up address is that there is nothing at it.
 */
export async function readAttributeDetail(
  definitionId: string | undefined,
  options: AttributesOptions = {},
): Promise<AttributesResult<AdminAttributeDetailResponse>> {
  const id = identifier(definitionId);
  if (id === null) return { kind: 'notFound' };
  return await read(`/v1/admin/attributes/${encodeURIComponent(id)}`, options, (body) =>
    AdminAttributeDetailResponseSchema.safeParse(body),
  );
}

/** Every tag, including the hidden. */
export async function readTags(options: AttributesOptions = {}): Promise<AttributesResult<AdminTagsResponse>> {
  return await read('/v1/admin/tags', options, (body) => AdminTagsResponseSchema.safeParse(body));
}

/** Which attributes one category asks its sellers about. */
export async function readCategoryAttributes(
  categoryId: string | undefined,
  options: AttributesOptions = {},
): Promise<AttributesResult<AdminCategoryAttributesResponse>> {
  const id = identifier(categoryId);
  if (id === null) return { kind: 'notFound' };
  return await read(`/v1/admin/categories/${encodeURIComponent(id)}/attributes`, options, (body) =>
    AdminCategoryAttributesResponseSchema.safeParse(body),
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Writes                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

async function acceptWrite(
  request: Request,
  options: AttributesOptions,
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
  options: AttributesOptions,
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

/** Pulls one identifier out of a submitted body and hands back the rest for the contract to judge. */
function withoutId(
  body: Record<string, unknown>,
  field: string,
): { readonly id: string | null; readonly rest: Record<string, unknown> } {
  const raw = typeof body[field] === 'string' ? (body[field] as string) : null;
  const { [field]: _removed, ...rest } = body;
  return { id: identifier(raw), rest };
}

/** `POST /api/attributes` — define one attribute, always hidden. */
export async function handleAttributeCreate(
  request: Request,
  options: AttributesOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const parsed = CreateAttributeDefinitionRequestSchema.safeParse(accepted.body);
  if (!parsed.success) return VALIDATION_FAILED();

  const upstream = await callWrite('POST', '/v1/admin/attributes', accepted.accessToken, parsed.data, options);
  return await writeOutcome(upstream, 201, (body) => CreateAttributeDefinitionResponseSchema.safeParse(body));
}

/** `PATCH /api/attributes` — labels, unit, filterability, order. Never the key, the type or the state. */
export async function handleAttributeUpdate(
  request: Request,
  options: AttributesOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const { id, rest } = withoutId(accepted.body, 'definitionId');
  if (id === null) return VALIDATION_FAILED();

  const parsed = UpdateAttributeDefinitionRequestSchema.safeParse(rest);
  if (!parsed.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PATCH',
    `/v1/admin/attributes/${encodeURIComponent(id)}`,
    accepted.accessToken,
    parsed.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => VocabularyWriteResponseSchema.safeParse(body));
}

/** `PUT /api/attributes/state` — show or hide one attribute. */
export async function handleAttributeState(
  request: Request,
  options: AttributesOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const { id } = withoutId(accepted.body, 'definitionId');
  if (id === null) return VALIDATION_FAILED();

  const parsed = VocabularyStateRequestSchema.safeParse({ isActive: accepted.body.isActive });
  if (!parsed.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PUT',
    `/v1/admin/attributes/${encodeURIComponent(id)}/state`,
    accepted.accessToken,
    parsed.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => VocabularyWriteResponseSchema.safeParse(body));
}

/** `POST /api/attributes/options` — add one option to a select attribute. */
export async function handleAttributeOptionCreate(
  request: Request,
  options: AttributesOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const { id, rest } = withoutId(accepted.body, 'definitionId');
  if (id === null) return VALIDATION_FAILED();

  const parsed = CreateAttributeOptionRequestSchema.safeParse(rest);
  if (!parsed.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'POST',
    `/v1/admin/attributes/${encodeURIComponent(id)}/options`,
    accepted.accessToken,
    parsed.data,
    options,
  );
  return await writeOutcome(upstream, 201, (body) => CreateAttributeOptionResponseSchema.safeParse(body));
}

/** `PATCH /api/attributes/options` — one option's labels and order. Never its value. */
export async function handleAttributeOptionUpdate(
  request: Request,
  options: AttributesOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const { id, rest } = withoutId(accepted.body, 'definitionId');
  const option = withoutId(rest, 'optionId');
  if (id === null || option.id === null) return VALIDATION_FAILED();

  const parsed = UpdateAttributeOptionRequestSchema.safeParse(option.rest);
  if (!parsed.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PATCH',
    `/v1/admin/attributes/${encodeURIComponent(id)}/options/${encodeURIComponent(option.id)}`,
    accepted.accessToken,
    parsed.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => VocabularyWriteResponseSchema.safeParse(body));
}

/** `PUT /api/attributes/options/state` — show or hide one option. */
export async function handleAttributeOptionState(
  request: Request,
  options: AttributesOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const { id, rest } = withoutId(accepted.body, 'definitionId');
  const option = withoutId(rest, 'optionId');
  if (id === null || option.id === null) return VALIDATION_FAILED();

  const parsed = VocabularyStateRequestSchema.safeParse({ isActive: accepted.body.isActive });
  if (!parsed.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PUT',
    `/v1/admin/attributes/${encodeURIComponent(id)}/options/${encodeURIComponent(option.id)}/state`,
    accepted.accessToken,
    parsed.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => VocabularyWriteResponseSchema.safeParse(body));
}

/** `POST /api/tags` — create one tag, active. */
export async function handleTagCreate(request: Request, options: AttributesOptions = {}): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const parsed = CreateTagRequestSchema.safeParse(accepted.body);
  if (!parsed.success) return VALIDATION_FAILED();

  const upstream = await callWrite('POST', '/v1/admin/tags', accepted.accessToken, parsed.data, options);
  return await writeOutcome(upstream, 201, (body) => CreateTagResponseSchema.safeParse(body));
}

/** `PATCH /api/tags` — rename one tag. Never its slug. */
export async function handleTagUpdate(request: Request, options: AttributesOptions = {}): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const { id, rest } = withoutId(accepted.body, 'tagId');
  if (id === null) return VALIDATION_FAILED();

  const parsed = UpdateTagRequestSchema.safeParse(rest);
  if (!parsed.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PATCH',
    `/v1/admin/tags/${encodeURIComponent(id)}`,
    accepted.accessToken,
    parsed.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => VocabularyWriteResponseSchema.safeParse(body));
}

/** `PUT /api/tags/state` — show or hide one tag. */
export async function handleTagState(request: Request, options: AttributesOptions = {}): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const { id } = withoutId(accepted.body, 'tagId');
  if (id === null) return VALIDATION_FAILED();

  const parsed = VocabularyStateRequestSchema.safeParse({ isActive: accepted.body.isActive });
  if (!parsed.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PUT',
    `/v1/admin/tags/${encodeURIComponent(id)}/state`,
    accepted.accessToken,
    parsed.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => VocabularyWriteResponseSchema.safeParse(body));
}

/** `PUT /api/categories/attributes` — ask a category for one attribute, or change how it asks. */
export async function handleCategoryAttributeAttach(
  request: Request,
  options: AttributesOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const { id, rest } = withoutId(accepted.body, 'categoryId');
  if (id === null) return VALIDATION_FAILED();

  const parsed = AttachCategoryAttributeRequestSchema.safeParse(rest);
  if (!parsed.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PUT',
    `/v1/admin/categories/${encodeURIComponent(id)}/attributes`,
    accepted.accessToken,
    parsed.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => VocabularyWriteResponseSchema.safeParse(body));
}

/**
 * `POST /api/categories/attributes/remove` — stop a category asking for one attribute.
 *
 * A browser form cannot send a `DELETE`, so the removal is a `POST` on its own path here and a `DELETE` upstream.
 * The verb the API offers is the one that is used; this is a form submitting to it. No answer is deleted: the
 * attribute stops being asked, and re-attaching it brings every answer back.
 */
export async function handleCategoryAttributeDetach(
  request: Request,
  options: AttributesOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const { id, rest } = withoutId(accepted.body, 'categoryId');
  const definition = withoutId(rest, 'definitionId');
  if (id === null || definition.id === null) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'DELETE',
    `/v1/admin/categories/${encodeURIComponent(id)}/attributes/${encodeURIComponent(definition.id)}`,
    accepted.accessToken,
    undefined,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => VocabularyWriteResponseSchema.safeParse(body));
}
