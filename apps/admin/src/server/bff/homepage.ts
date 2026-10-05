import 'server-only';
import {
  CreateHomepageSectionRequestSchema,
  CreateHomepageSectionResponseSchema,
  HomepageSectionDetailResponseSchema,
  HomepageSectionStateRequestSchema,
  HomepageSectionsResponseSchema,
  HomepageWriteResponseSchema,
  PROBLEM_JSON_MEDIA_TYPE,
  ReorderHomepageSectionsRequestSchema,
  SESSION_TOKEN_HEADER,
  UpdateHomepageSectionRequestSchema,
  type HomepageSectionDetail,
  type HomepageSectionsResponse,
} from '@repo/contracts';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { readAdminAccessToken } from './staff-session';

/**
 * The homepage, on the admin origin (0093).
 *
 * **The session never leaves the server.** The caller's access token lives in `__Host-mp_admin_access`, which
 * JavaScript cannot read; it is presented to the API on one internal hop in the session-token header, and the
 * browser's own `Cookie` header is never forwarded.
 *
 * **Responses are validated, not forwarded.** A drifted body becomes a clean failure here instead of a
 * half-rendered screen.
 *
 * **Every write is same-origin and rebuilt** from the contract's own fields. The configuration is validated
 * against its section type here as well as in the API, because a document that does not match its type is the one
 * mistake a homepage editor can make that would otherwise reach the public as a missing section.
 *
 * **Visibility has its own handler.** A section's text and configuration are changed by one request and its
 * visibility by another, so a console that meant to fix a title cannot publish a half-configured section.
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

export interface HomepageOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

/** What a read resolved to. `notFound` is the API's one neutral answer. */
export type HomepageResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function identifier(value: string | null): string | null {
  return value !== null && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

async function read<T>(
  path: string,
  options: HomepageOptions,
  parse: (body: unknown) => { success: true; data: T } | { success: false },
): Promise<HomepageResult<T>> {
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

/** Every section in the homepage's own order, with whether this caller may change any of it. */
export async function readHomepageSections(
  options: HomepageOptions = {},
): Promise<HomepageResult<HomepageSectionsResponse>> {
  return await read('/v1/admin/homepage/sections', options, (body) =>
    HomepageSectionsResponseSchema.safeParse(body),
  );
}

/**
 * One section, with how much of its content is still renderable.
 *
 * A malformed id is `notFound` rather than a validation failure: the value came from the address somebody typed.
 */
export async function readHomepageSection(
  sectionId: string | undefined,
  options: HomepageOptions = {},
): Promise<HomepageResult<HomepageSectionDetail>> {
  const id = identifier(sectionId ?? null);
  if (id === null) return { kind: 'notFound' };
  const result = await read(`/v1/admin/homepage/sections/${encodeURIComponent(id)}`, options, (body) =>
    HomepageSectionDetailResponseSchema.safeParse(body),
  );
  return result.kind === 'ok' ? { kind: 'ok', data: result.data.section } : result;
}

/* ------------------------------------------------------------------------------------------------ */
/* Writes                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

async function acceptWrite(
  request: Request,
  options: HomepageOptions,
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
  options: HomepageOptions,
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

/**
 * `POST /api/homepage/sections` — create a hidden section.
 *
 * The configuration is validated against the section type before it leaves this origin, so an operator gets a form
 * error rather than a conflict, and a document that does not match its type never reaches the database.
 */
export async function handleHomepageSectionCreate(
  request: Request,
  options: HomepageOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const validated = CreateHomepageSectionRequestSchema.safeParse({
    sectionKey: accepted.body['sectionKey'],
    sectionType: accepted.body['sectionType'],
    ...('titleEn' in accepted.body ? { titleEn: accepted.body['titleEn'] } : {}),
    ...('titleAr' in accepted.body ? { titleAr: accepted.body['titleAr'] } : {}),
    ...('subtitleEn' in accepted.body ? { subtitleEn: accepted.body['subtitleEn'] } : {}),
    ...('subtitleAr' in accepted.body ? { subtitleAr: accepted.body['subtitleAr'] } : {}),
    config: accepted.body['config'],
    ...('sortOrder' in accepted.body ? { sortOrder: accepted.body['sortOrder'] } : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'POST',
    '/v1/admin/homepage/sections',
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 201, (body) => CreateHomepageSectionResponseSchema.safeParse(body));
}

/**
 * `PATCH /api/homepage/sections` — change a section's key, type, text, configuration or position.
 *
 * **Absence is preserved exactly**: a key the browser did not send is not rebuilt, because for a title absent
 * means "leave it" and null means "clear it". `isActive` is not among the fields forwarded, so editing a section
 * can never show it however the body is shaped.
 */
export async function handleHomepageSectionUpdate(
  request: Request,
  options: HomepageOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const sectionId = identifier(
    typeof accepted.body['sectionId'] === 'string' ? accepted.body['sectionId'] : null,
  );
  if (sectionId === null) return VALIDATION_FAILED();

  const validated = UpdateHomepageSectionRequestSchema.safeParse({
    ...('sectionKey' in accepted.body ? { sectionKey: accepted.body['sectionKey'] } : {}),
    ...('sectionType' in accepted.body ? { sectionType: accepted.body['sectionType'] } : {}),
    ...('titleEn' in accepted.body ? { titleEn: accepted.body['titleEn'] } : {}),
    ...('titleAr' in accepted.body ? { titleAr: accepted.body['titleAr'] } : {}),
    ...('subtitleEn' in accepted.body ? { subtitleEn: accepted.body['subtitleEn'] } : {}),
    ...('subtitleAr' in accepted.body ? { subtitleAr: accepted.body['subtitleAr'] } : {}),
    ...('config' in accepted.body ? { config: accepted.body['config'] } : {}),
    ...('sortOrder' in accepted.body ? { sortOrder: accepted.body['sortOrder'] } : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PATCH',
    `/v1/admin/homepage/sections/${encodeURIComponent(sectionId)}`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => HomepageWriteResponseSchema.safeParse(body));
}

/** `POST /api/homepage/sections/state` — show or hide one section. The only route that can. */
export async function handleHomepageSectionState(
  request: Request,
  options: HomepageOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const sectionId = identifier(
    typeof accepted.body['sectionId'] === 'string' ? accepted.body['sectionId'] : null,
  );
  if (sectionId === null) return VALIDATION_FAILED();

  const validated = HomepageSectionStateRequestSchema.safeParse({ isActive: accepted.body['isActive'] });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PUT',
    `/v1/admin/homepage/sections/${encodeURIComponent(sectionId)}/state`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => HomepageWriteResponseSchema.safeParse(body));
}

/** `POST /api/homepage/sections/reorder` — set the order of the homepage, whole. */
export async function handleHomepageSectionsReorder(
  request: Request,
  options: HomepageOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const validated = ReorderHomepageSectionsRequestSchema.safeParse({
    sectionIds: accepted.body['sectionIds'],
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PUT',
    '/v1/admin/homepage/sections/reorder',
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => HomepageWriteResponseSchema.safeParse(body));
}

/**
 * `POST /api/homepage/sections/remove` — remove one section.
 *
 * A `POST` on this origin and a `DELETE` upstream, for the reason the other remove routes give: the same-origin
 * check reads a submitted body and a browser form submits one.
 */
export async function handleHomepageSectionRemove(
  request: Request,
  options: HomepageOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const sectionId = identifier(
    typeof accepted.body['sectionId'] === 'string' ? accepted.body['sectionId'] : null,
  );
  if (sectionId === null) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'DELETE',
    `/v1/admin/homepage/sections/${encodeURIComponent(sectionId)}`,
    accepted.accessToken,
    undefined,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => HomepageWriteResponseSchema.safeParse(body));
}
