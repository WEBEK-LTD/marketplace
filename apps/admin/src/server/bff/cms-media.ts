import 'server-only';
import {
  CMS_MEDIA_OBJECT_PATH_PATTERN,
  CmsMediaAltTextRequestSchema,
  CmsMediaAttachRequestSchema,
  CmsMediaAttachResponseSchema,
  CmsMediaPageResponseSchema,
  CmsMediaPreviewResponseSchema,
  CmsMediaUploadRequestSchema,
  CmsMediaUploadResponseSchema,
  CmsMediaUsageResponseSchema,
  CmsMediaWriteResponseSchema,
  PROBLEM_JSON_MEDIA_TYPE,
  SESSION_TOKEN_HEADER,
  type CmsMediaPageResponse,
  type CmsMediaPreviewResponse,
  type CmsMediaUsageResponse,
} from '@repo/contracts';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { readAdminAccessToken } from './staff-session';

/**
 * The CMS media library, on the admin origin (0098).
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
 * **The upload URL and the preview URL are passed through and never stored.** Each is a short-lived bearer credential
 * for one object. They are not logged, not cached, and not written into any response this origin composes beyond the
 * one the browser asked for.
 *
 * **The browser's path is checked before it is forwarded.** A confirmation carries the path the API itself issued, so
 * anything that is not that exact shape is refused here rather than passed upstream — the API and the database check
 * it again regardless, which is what actually makes a traversal unattachable.
 *
 * **Nothing here delivers an image publicly.** There is no route on this origin that proxies an object, and the
 * preview URL points at the storage provider for a few minutes and at nothing afterwards.
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

export interface CmsMediaOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

/**
 * What a read resolved to.
 *
 * `notFound` is the API's one neutral answer: a caller without `cms.media.manage` at `aal2`, an entry that does not
 * exist, or a cursor that does not decode. This surface has one key, so there is no "may read but not write" state.
 */
export type CmsMediaResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' };

/** base64url, which is the whole of what a cursor can be. Refused here rather than forwarded. */
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function identifier(value: string | null): string | null {
  return value !== null && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

async function read<T>(
  path: string,
  options: CmsMediaOptions,
  parse: (body: unknown) => { success: true; data: T } | { success: false },
): Promise<CmsMediaResult<T>> {
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

/** One page of the library, newest first. */
export async function readCmsMediaList(
  input: { readonly cursor?: string | null; readonly limit?: string | null } = {},
  options: CmsMediaOptions = {},
): Promise<CmsMediaResult<CmsMediaPageResponse>> {
  const params = new URLSearchParams();
  if (typeof input.limit === 'string' && /^[1-9][0-9]{0,2}$/.test(input.limit)) params.set('limit', input.limit);
  if (typeof input.cursor === 'string' && CURSOR_PATTERN.test(input.cursor)) {
    // Passed along as text. This layer does not know what a cursor contains and must not learn.
    params.set('cursor', input.cursor);
  }
  const query = params.size === 0 ? '' : `?${params.toString()}`;
  return await read(`/v1/admin/cms/media${query}`, options, (body) => CmsMediaPageResponseSchema.safeParse(body));
}

/**
 * Every CMS row that points at one entry.
 *
 * A malformed id is `notFound` rather than a validation failure: the value came from the address somebody typed, and
 * the honest answer to a made-up address is that there is nothing at it.
 */
export async function readCmsMediaUsage(
  mediaId: string | undefined,
  options: CmsMediaOptions = {},
): Promise<CmsMediaResult<CmsMediaUsageResponse>> {
  const id = identifier(mediaId ?? null);
  if (id === null) return { kind: 'notFound' };
  return await read(`/v1/admin/cms/media/${encodeURIComponent(id)}/usage`, options, (body) =>
    CmsMediaUsageResponseSchema.safeParse(body),
  );
}

/** A short-lived signed URL for one stored object. Never cached, never stored. */
export async function readCmsMediaPreview(
  mediaId: string | undefined,
  options: CmsMediaOptions = {},
): Promise<CmsMediaResult<CmsMediaPreviewResponse>> {
  const id = identifier(mediaId ?? null);
  if (id === null) return { kind: 'notFound' };
  return await read(`/v1/admin/cms/media/${encodeURIComponent(id)}/preview`, options, (body) =>
    CmsMediaPreviewResponseSchema.safeParse(body),
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* The two reads a browser performs for itself                                                       */
/* ------------------------------------------------------------------------------------------------ */
/**
 * A preview and a usage list are fetched **when an operator asks**, not rendered for every row.
 *
 * Both reasons matter. A signed URL is a short-lived credential, so issuing one per row on every page view would put
 * a handful of live credentials into the initial HTML of a page nobody has looked at yet; and each one is a provider
 * call, so a page of two dozen entries would make two dozen of them. So these are `GET` route handlers a button
 * calls, and the result is held in the component's own state and never written into a link.
 *
 * No same-origin check: neither changes anything, and both are gated by the session cookie and by the key the API
 * re-tests. A `GET` that cannot be submitted cross-origin as a state change needs no CSRF defence.
 */
function resultResponse<T>(result: CmsMediaResult<T>): Response {
  if (result.kind === 'ok') {
    return new Response(JSON.stringify(result.data), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
  if (result.kind === 'unauthenticated') return SESSION_REQUIRED();
  if (result.kind === 'notFound') {
    return problemResponse(404, 'Not Found', 'NOT_FOUND', 'The requested resource was not found.');
  }
  return UNAVAILABLE();
}

/** `GET /api/cms/media/:mediaId/preview`. */
export async function handleCmsMediaPreview(
  request: Request,
  mediaId: string | undefined,
  options: CmsMediaOptions = {},
): Promise<Response> {
  const cookieHeader = options.cookieHeader ?? request.headers.get('cookie');
  return resultResponse(await readCmsMediaPreview(mediaId, { ...options, cookieHeader }));
}

/** `GET /api/cms/media/:mediaId/usage`. */
export async function handleCmsMediaUsage(
  request: Request,
  mediaId: string | undefined,
  options: CmsMediaOptions = {},
): Promise<Response> {
  const cookieHeader = options.cookieHeader ?? request.headers.get('cookie');
  return resultResponse(await readCmsMediaUsage(mediaId, { ...options, cookieHeader }));
}

/* ------------------------------------------------------------------------------------------------ */
/* Writes                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

async function acceptWrite(
  request: Request,
  options: CmsMediaOptions,
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
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  accessToken: string,
  body: unknown,
  options: CmsMediaOptions,
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
 * `POST /api/cms/media/uploads` — authorize one upload.
 *
 * Only the two fields the contract declares are forwarded, so an `objectPath` a browser invents has nowhere to go:
 * the path is the server's to compose and this route cannot be used to suggest one.
 */
export async function handleCmsMediaUploadAuthorize(
  request: Request,
  options: CmsMediaOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const validated = CmsMediaUploadRequestSchema.safeParse({
    contentType: accepted.body['contentType'],
    byteSize: accepted.body['byteSize'],
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'POST',
    '/v1/admin/cms/media/uploads',
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 201, (body) => CmsMediaUploadResponseSchema.safeParse(body));
}

/**
 * `POST /api/cms/media` — confirm an upload and record the entry.
 *
 * The path is checked against the exact shape the authorizer issues before it is forwarded. That is an early no and
 * not the real defence: the API and the database both check it again, and the database is what makes a path outside
 * the bucket unattachable.
 */
export async function handleCmsMediaConfirm(request: Request, options: CmsMediaOptions = {}): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const path = accepted.body['objectPath'];
  if (typeof path !== 'string' || !CMS_MEDIA_OBJECT_PATH_PATTERN.test(path)) return VALIDATION_FAILED();

  const validated = CmsMediaAttachRequestSchema.safeParse({
    objectPath: path,
    contentType: accepted.body['contentType'],
    byteSize: accepted.body['byteSize'],
    ...('width' in accepted.body ? { width: accepted.body['width'] } : {}),
    ...('height' in accepted.body ? { height: accepted.body['height'] } : {}),
    ...('altTextEn' in accepted.body ? { altTextEn: accepted.body['altTextEn'] } : {}),
    ...('altTextAr' in accepted.body ? { altTextAr: accepted.body['altTextAr'] } : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite('POST', '/v1/admin/cms/media', accepted.accessToken, validated.data, options);
  return await writeOutcome(upstream, 201, (body) => CmsMediaAttachResponseSchema.safeParse(body));
}

/** `PUT /api/cms/media/alt-text` — replace one entry's alt texts. */
export async function handleCmsMediaAltText(request: Request, options: CmsMediaOptions = {}): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(typeof accepted.body['mediaId'] === 'string' ? accepted.body['mediaId'] : null);
  if (id === null) return VALIDATION_FAILED();

  const validated = CmsMediaAltTextRequestSchema.safeParse({
    ...('altTextEn' in accepted.body ? { altTextEn: accepted.body['altTextEn'] } : {}),
    ...('altTextAr' in accepted.body ? { altTextAr: accepted.body['altTextAr'] } : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PUT',
    `/v1/admin/cms/media/${encodeURIComponent(id)}/alt-text`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => CmsMediaWriteResponseSchema.safeParse(body));
}

/**
 * `POST /api/cms/media/remove` — remove one entry.
 *
 * A `POST` on this origin and a `DELETE` upstream, for the reason the other remove routes give: the same-origin check
 * reads a submitted body, and the browser form that drives this submits one.
 */
export async function handleCmsMediaRemove(request: Request, options: CmsMediaOptions = {}): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(typeof accepted.body['mediaId'] === 'string' ? accepted.body['mediaId'] : null);
  if (id === null) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'DELETE',
    `/v1/admin/cms/media/${encodeURIComponent(id)}`,
    accepted.accessToken,
    undefined,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => CmsMediaWriteResponseSchema.safeParse(body));
}
