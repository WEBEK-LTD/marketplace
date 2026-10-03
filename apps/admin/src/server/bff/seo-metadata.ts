import 'server-only';
import {
  PROBLEM_JSON_MEDIA_TYPE,
  SEO_METADATA_ENTITY_TYPES,
  SESSION_TOKEN_HEADER,
  SaveSeoMetadataRequestSchema,
  SaveSeoMetadataResponseSchema,
  SeoMetadataDetailResponseSchema,
  SeoMetadataEntriesResponseSchema,
  SeoMetadataWriteResponseSchema,
  type SeoMetadataDetail,
  type SeoMetadataEntriesResponse,
} from '@repo/contracts';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { readAdminAccessToken } from './staff-session';

/**
 * Per-entity SEO metadata, on the admin origin.
 *
 * **The session never leaves the server.** The caller's access token lives in `__Host-mp_admin_access`, which
 * JavaScript cannot read; it is presented to the API on one internal hop in the session-token header, and the
 * browser's own `Cookie` header is never forwarded.
 *
 * **Nothing about the caller crosses in a request.** No account, no role, no permission key and no assurance level
 * appears in anything built here.
 *
 * **Responses are validated, not forwarded.** A drifted body becomes a clean failure here instead of a half-rendered
 * screen, and a field the contract does not name cannot reach a browser even if the API sent one.
 *
 * **Every write is same-origin and rebuilt** from the contract's own fields, so a `structuredData` or an `updatedBy`
 * a browser invents has nowhere to go. A save is a replace, which is why the form submits every field: the handler
 * forwards what the contract declares and the API clears the rest.
 *
 * **Refusals are forwarded with the API's own problem body**, because this surface has two an operator must read: an
 * entry that is not a legal one, and a locale or image that does not exist.
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

export interface SeoMetadataOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

/**
 * What a read resolved to.
 *
 * `notFound` is the API's one neutral answer: no such entry, or a caller without the key the operation needs.
 */
export type SeoMetadataResult<T> =
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
  readonly entityType?: string | null;
  readonly locale?: string | null;
}): string {
  const params = new URLSearchParams();
  if (typeof input.limit === 'string' && /^\d{1,3}$/.test(input.limit)) params.set('limit', input.limit);
  if (
    typeof input.entityType === 'string' &&
    (SEO_METADATA_ENTITY_TYPES as readonly string[]).includes(input.entityType)
  ) {
    params.set('entityType', input.entityType);
  }
  if (typeof input.locale === 'string' && LOCALE_PATTERN.test(input.locale)) params.set('locale', input.locale);
  if (typeof input.cursor === 'string' && CURSOR_PATTERN.test(input.cursor)) {
    // Passed along as text. This layer does not know what a cursor contains and must not learn.
    params.set('cursor', input.cursor);
  }
  return params.size === 0 ? '' : `?${params.toString()}`;
}

async function read<T>(
  path: string,
  options: SeoMetadataOptions,
  parse: (body: unknown) => { success: true; data: T } | { success: false },
): Promise<SeoMetadataResult<T>> {
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

/** One page of overrides, newest edit first. */
export async function readSeoMetadataList(
  input: {
    readonly cursor?: string | null;
    readonly limit?: string | null;
    readonly entityType?: string | null;
    readonly locale?: string | null;
  } = {},
  options: SeoMetadataOptions = {},
): Promise<SeoMetadataResult<SeoMetadataEntriesResponse>> {
  return await read(`/v1/admin/seo/metadata${query(input)}`, options, (body) =>
    SeoMetadataEntriesResponseSchema.safeParse(body),
  );
}

/**
 * One override, with what the public would actually receive.
 *
 * A malformed id is `notFound` rather than a validation failure: the value came from the address somebody typed, and
 * the honest answer to a made-up address is that there is nothing at it.
 */
export async function readSeoMetadataEntry(
  entryId: string | undefined,
  options: SeoMetadataOptions = {},
): Promise<SeoMetadataResult<SeoMetadataDetail>> {
  const id = identifier(entryId ?? null);
  if (id === null) return { kind: 'notFound' };
  const result = await read(`/v1/admin/seo/metadata/${encodeURIComponent(id)}`, options, (body) =>
    SeoMetadataDetailResponseSchema.safeParse(body),
  );
  return result.kind === 'ok' ? { kind: 'ok', data: result.data.entry } : result;
}

/* ------------------------------------------------------------------------------------------------ */
/* Writes                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

async function acceptWrite(
  request: Request,
  options: SeoMetadataOptions,
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
  method: 'PUT' | 'DELETE',
  path: string,
  accessToken: string,
  body: unknown,
  options: SeoMetadataOptions,
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
 * `PUT /api/seo/metadata` — write one surface's metadata for one locale.
 *
 * Every field the contract declares is forwarded and nothing else is, so a `structuredData`, an `updatedBy` or a
 * `twitterSite` a browser invents is dropped before it leaves this origin. Absent stays absent rather than becoming
 * null, so the API's own "a replace clears what it is not given" rule is the one that applies.
 */
export async function handleSeoMetadataSave(
  request: Request,
  options: SeoMetadataOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const validated = SaveSeoMetadataRequestSchema.safeParse({
    entityType: accepted.body['entityType'],
    ...('entityId' in accepted.body ? { entityId: accepted.body['entityId'] } : {}),
    ...('routePath' in accepted.body ? { routePath: accepted.body['routePath'] } : {}),
    localeCode: accepted.body['localeCode'],
    ...('metaTitle' in accepted.body ? { metaTitle: accepted.body['metaTitle'] } : {}),
    ...('metaDescription' in accepted.body ? { metaDescription: accepted.body['metaDescription'] } : {}),
    ...('canonicalPath' in accepted.body ? { canonicalPath: accepted.body['canonicalPath'] } : {}),
    ...('robotsDirectives' in accepted.body ? { robotsDirectives: accepted.body['robotsDirectives'] } : {}),
    ...('ogTitle' in accepted.body ? { ogTitle: accepted.body['ogTitle'] } : {}),
    ...('ogDescription' in accepted.body ? { ogDescription: accepted.body['ogDescription'] } : {}),
    ...('shareMediaId' in accepted.body ? { shareMediaId: accepted.body['shareMediaId'] } : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite('PUT', '/v1/admin/seo/metadata', accepted.accessToken, validated.data, options);
  return await writeOutcome(upstream, 200, (body) => SaveSeoMetadataResponseSchema.safeParse(body));
}

/**
 * `POST /api/seo/metadata/remove` — remove one override.
 *
 * A `POST` on this origin and a `DELETE` upstream, for the reason the other remove routes give: the same-origin check
 * reads a submitted body, and the browser form that drives this submits one.
 */
export async function handleSeoMetadataRemove(
  request: Request,
  options: SeoMetadataOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(typeof accepted.body['entryId'] === 'string' ? accepted.body['entryId'] : null);
  if (id === null) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'DELETE',
    `/v1/admin/seo/metadata/${encodeURIComponent(id)}`,
    accepted.accessToken,
    undefined,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => SeoMetadataWriteResponseSchema.safeParse(body));
}
