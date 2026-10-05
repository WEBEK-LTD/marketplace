import 'server-only';
import {
  PROBLEM_JSON_MEDIA_TYPE,
  SEO_SETTINGS_LOCALE_PATTERN,
  SESSION_TOKEN_HEADER,
  SaveSeoSettingsRequestSchema,
  SeoSettingsResponseSchema,
  SeoSettingsWriteResponseSchema,
  type SeoSettingsResponse,
} from '@repo/contracts';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { readAdminAccessToken } from './staff-session';

/**
 * Site-wide SEO settings, on the admin origin (0096).
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
 * **Every write is same-origin and rebuilt** from the contract's own fields, so an `updatedBy`, a `localeCode` in the
 * body or an `isAuthored` a browser invents has nowhere to go. A save is a replace, which is why the form submits
 * every field: this layer forwards what the contract declares and the API clears the rest.
 *
 * **The locale is part of the address and is checked here** against 0002's own format, so a made-up locale never
 * becomes an upstream request.
 *
 * **Nothing here resolves a media object or builds an absolute URL.** The share image's identifier and object path
 * travel as text and are displayed as text: the `cms-media` bucket is private and no signing capability exists.
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

export interface SeoSettingsOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

/**
 * What a read resolved to.
 *
 * `notFound` is the API's one neutral answer: a caller without `seo.settings.manage` at `aal2`. This surface has one
 * key, so there is no "may read but not write" state for it to describe.
 */
export type SeoSettingsResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' };

/** 0002's own locale format. A value that is not one never becomes a request. */
function localeCode(value: string | null): string | null {
  return value !== null && SEO_SETTINGS_LOCALE_PATTERN.test(value) ? value : null;
}

/* ------------------------------------------------------------------------------------------------ */
/* Reads                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

/** Every active locale, default locale first, authored or not. */
export async function readSeoSettings(
  options: SeoSettingsOptions = {},
): Promise<SeoSettingsResult<SeoSettingsResponse>> {
  const accessToken = readAdminAccessToken(options.cookieHeader ?? null);
  if (accessToken === null) return { kind: 'unauthenticated' };

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}/v1/admin/seo/settings`, {
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
    const parsed = SeoSettingsResponseSchema.safeParse(JSON.parse(await upstream.text()));
    return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* Writes                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

async function acceptWrite(
  request: Request,
  options: SeoSettingsOptions,
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
  options: SeoSettingsOptions,
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

async function writeOutcome(upstream: Response | null): Promise<Response> {
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
  const validated = SeoSettingsWriteResponseSchema.safeParse(parsed);
  if (!validated.success) return UNAVAILABLE();

  return new Response(JSON.stringify(validated.data), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * `PUT /api/seo/settings` — write one locale's site-wide defaults.
 *
 * The locale travels in the body on this origin and in the address upstream, because the browser form that drives
 * this submits one body and the API's resource is the locale.
 *
 * Every field the contract declares is forwarded and nothing else is, so an `updatedBy`, an `isAuthored` or a
 * `robotsIsServed` a browser invents is dropped before it leaves this origin. Absent stays absent, so the API's own
 * "a save is a replace" rule is the one that applies.
 */
export async function handleSeoSettingsSave(
  request: Request,
  options: SeoSettingsOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const locale = localeCode(typeof accepted.body['localeCode'] === 'string' ? accepted.body['localeCode'] : null);
  if (locale === null) return VALIDATION_FAILED();

  const validated = SaveSeoSettingsRequestSchema.safeParse({
    siteName: accepted.body['siteName'],
    ...('defaultMetaTitle' in accepted.body ? { defaultMetaTitle: accepted.body['defaultMetaTitle'] } : {}),
    ...('defaultMetaDescription' in accepted.body
      ? { defaultMetaDescription: accepted.body['defaultMetaDescription'] }
      : {}),
    ...('defaultShareMediaId' in accepted.body
      ? { defaultShareMediaId: accepted.body['defaultShareMediaId'] }
      : {}),
    ...('twitterSite' in accepted.body ? { twitterSite: accepted.body['twitterSite'] } : {}),
    ...('robotsTxtBody' in accepted.body ? { robotsTxtBody: accepted.body['robotsTxtBody'] } : {}),
    ...('organizationStructuredData' in accepted.body
      ? { organizationStructuredData: accepted.body['organizationStructuredData'] }
      : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PUT',
    `/v1/admin/seo/settings/${encodeURIComponent(locale)}`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream);
}

/**
 * `POST /api/seo/settings/remove` — remove one locale's settings.
 *
 * A `POST` on this origin and a `DELETE` upstream, for the reason the other remove routes give: the same-origin check
 * reads a submitted body, and the browser form that drives this submits one.
 */
export async function handleSeoSettingsRemove(
  request: Request,
  options: SeoSettingsOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const locale = localeCode(typeof accepted.body['localeCode'] === 'string' ? accepted.body['localeCode'] : null);
  if (locale === null) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'DELETE',
    `/v1/admin/seo/settings/${encodeURIComponent(locale)}`,
    accepted.accessToken,
    undefined,
    options,
  );
  return await writeOutcome(upstream);
}
