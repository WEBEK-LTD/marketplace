import 'server-only';
import {
  PROBLEM_JSON_MEDIA_TYPE,
  SESSION_TOKEN_HEADER,
  SITE_SETTINGS_CATEGORY_PATTERN,
  SITE_SETTINGS_KEY_PATTERN,
  SiteSettingsResponseSchema,
  SiteSettingsWriteResponseSchema,
  type SiteSettingsResponse,
} from '@repo/contracts';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { readAdminAccessToken } from './staff-session';

/**
 * Site settings, on the admin origin (0113).
 *
 * **The session never leaves the server.** The caller's access token lives in `__Host-mp_admin_access`, which
 * JavaScript cannot read; it is presented to the API on one internal hop in the session-token header, and the
 * browser's own `Cookie` header is never forwarded. The same shape 0096 established for the SEO settings, for
 * the same reasons.
 *
 * **Responses are validated, not forwarded**, so a drifted body becomes a clean failure here rather than a
 * half-rendered screen, and a field the contract does not name cannot reach a browser.
 *
 * **The category and the key are part of the address and are checked here** against 0008's own formats, so a
 * made-up key never becomes an upstream request.
 *
 * **The value crosses as a typed JSON value and is not reinterpreted on the way.** A setting's type is the
 * database's business; this layer carries whatever the form produced for the declared type and lets the writer
 * and 0008's constraint agree or refuse. The one thing it will not do is coerce — a `"true"` typed into a
 * boolean field is a refusal the operator should see, not a true this layer invented for them.
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

export interface SiteSettingsOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

/**
 * What a read resolved to.
 *
 * `notFound` is the API's one neutral answer: a caller without `settings.site.manage` at `aal2`. This surface
 * has one key, so there is no "may read but not write" state for it to describe.
 */
export type SiteSettingsResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' };

function categoryOf(value: string | null): string | null {
  return value !== null && SITE_SETTINGS_CATEGORY_PATTERN.test(value) ? value : null;
}

function keyOf(value: string | null): string | null {
  return value !== null && SITE_SETTINGS_KEY_PATTERN.test(value) ? value : null;
}

/* ------------------------------------------------------------------------------------------------ */
/* Reads                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

/** One category's settings, in key order. */
export async function readSiteSettings(
  category: string,
  options: SiteSettingsOptions = {},
): Promise<SiteSettingsResult<SiteSettingsResponse>> {
  const safe = categoryOf(category);
  if (safe === null) return { kind: 'notFound' };

  const accessToken = readAdminAccessToken(options.cookieHeader ?? null);
  if (accessToken === null) return { kind: 'unauthenticated' };

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}/v1/admin/settings/${encodeURIComponent(safe)}`, {
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
    const parsed = SiteSettingsResponseSchema.safeParse(JSON.parse(await upstream.text()));
    return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* Writes                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

/**
 * `POST /api/settings/save` — write one setting's value.
 *
 * A `POST` on this origin and a `PUT` upstream, for the reason every other write route here gives: the
 * same-origin check reads a submitted body, and the browser form that drives this submits one.
 */
export async function handleSiteSettingSave(
  request: Request,
  options: SiteSettingsOptions = {},
): Promise<Response> {
  const origin = checkSameOrigin({
    method: request.method,
    url: addressedOrigin(request),
    headers: request.headers,
  });
  if (!origin.ok) {
    return problemResponse(403, 'Forbidden', 'BAD_REQUEST', 'The request could not be processed.');
  }

  const accessToken = readAdminAccessToken(options.cookieHeader ?? request.headers.get('cookie'));
  if (accessToken === null) return SESSION_REQUIRED();

  let body: unknown;
  try {
    const raw = await request.text();
    body = raw === '' ? {} : JSON.parse(raw);
  } catch {
    return VALIDATION_FAILED();
  }
  if (typeof body !== 'object' || body === null) return VALIDATION_FAILED();
  const fields = body as Record<string, unknown>;

  const category = categoryOf(typeof fields['category'] === 'string' ? fields['category'] : null);
  const key = keyOf(typeof fields['key'] === 'string' ? fields['key'] : null);
  if (category === null || key === null) return VALIDATION_FAILED();
  // The value may legitimately be `null`, `false`, `0` or `""`, so its presence is tested rather than its truth.
  if (!('value' in fields)) return VALIDATION_FAILED();

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response | null;
  try {
    upstream = await fetcher(
      `${config.apiBaseUrl}/v1/admin/settings/${encodeURIComponent(category)}/${encodeURIComponent(key)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', [SESSION_TOKEN_HEADER]: accessToken },
        // Rebuilt from the one field the contract declares, so nothing a browser added travels with it.
        body: JSON.stringify({ value: fields['value'] }),
      },
    );
  } catch {
    upstream = null;
  }

  if (upstream === null) return UNAVAILABLE();

  const text = await upstream.text();
  if (upstream.status !== 200) {
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
  const validated = SiteSettingsWriteResponseSchema.safeParse(parsed);
  if (!validated.success) return UNAVAILABLE();

  return new Response(JSON.stringify(validated.data), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
