import 'server-only';
import {
  PROBLEM_JSON_MEDIA_TYPE,
  ServiceDetailResponseSchema,
  ServicesResponseSchema,
  isCanonicalSurface,
  publicLocaleOf,
  type CanonicalSurface,
  type ServiceDetailResponse,
  type ServicesResponse,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';

/**
 * The BFF half of the public services (Phase 4-C).
 *
 * The browser asks this origin; this module makes the one credentialled internal hop. No session is read
 * and none is set: the service list and a service page are the same for everyone.
 *
 * Responses are **validated** against the shared contract rather than forwarded. A page renders whatever
 * comes back, so an upstream body that has drifted must become a clean failure here instead of a broken
 * service page in someone's browser.
 */

const PROBLEM = {
  type: 'about:blank',
  title: 'Service Unavailable',
  status: 503,
  detail: 'The service is temporarily unavailable.',
  instance: '/services',
  code: 'SERVICE_UNAVAILABLE',
} as const;

export interface ServicesHandlerOptions {
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
 * What a detail read resolved to.
 *
 * `moved` carries the surface that owns the canonical slug as well as the slug itself, because a service
 * slug asked of the listing surface — or the reverse — is a redirect across surfaces, not within one.
 */
export type ServiceLookup =
  | { readonly kind: 'found'; readonly service: ServiceDetailResponse['service'] }
  | { readonly kind: 'moved'; readonly canonicalSlug: string; readonly canonicalType: CanonicalSurface }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unavailable' };

async function call(path: string, options: ServicesHandlerOptions): Promise<Response | null> {
  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);
  try {
    // A 301 is an answer, not something to chase: the page turns it into the browser's own redirect.
    return await fetcher(`${config.apiBaseUrl}${path}`, { method: 'GET', redirect: 'manual' });
  } catch {
    return null;
  }
}

/** One page of the service list, or null when it could not be read. */
export async function readServices(
  input: { limit?: string | null; cursor?: string | null },
  options: ServicesHandlerOptions = {},
): Promise<ServicesResponse | null> {
  const query = new URLSearchParams();
  if (input.limit !== undefined && input.limit !== null && input.limit !== '') query.set('limit', input.limit);
  if (input.cursor !== undefined && input.cursor !== null && input.cursor !== '') query.set('cursor', input.cursor);
  const suffix = query.size === 0 ? '' : `?${query.toString()}`;

  const upstream = await call(`/v1/services${suffix}`, options);
  if (upstream === null || !upstream.ok) return null;

  try {
    const result = ServicesResponseSchema.safeParse(JSON.parse(await upstream.text()));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** One service by slug, a redirect, a 404, or a failure — the four a page must render. */
export async function readService(
  slug: string,
  locale: string | undefined,
  options: ServicesHandlerOptions = {},
): Promise<ServiceLookup> {
  const path = `/v1/services/${encodeURIComponent(slug)}?locale=${encodeURIComponent(publicLocaleOf(locale))}`;
  const upstream = await call(path, options);
  if (upstream === null) return { kind: 'unavailable' };

  if (upstream.status === 301) {
    const canonical = upstream.headers.get('x-canonical-slug');
    const surface = upstream.headers.get('x-canonical-type');
    if (canonical === null || canonical === '') return { kind: 'unavailable' };
    // An unrecognised surface is not guessed at: the redirect target would be a guess too.
    return isCanonicalSurface(surface)
      ? { kind: 'moved', canonicalSlug: canonical, canonicalType: surface }
      : { kind: 'unavailable' };
  }
  if (upstream.status === 404) return { kind: 'not_found' };
  if (!upstream.ok) return { kind: 'unavailable' };

  try {
    const result = ServiceDetailResponseSchema.safeParse(JSON.parse(await upstream.text()));
    return result.success ? { kind: 'found', service: result.data.service } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/**
 * `GET /api/services`.
 *
 * A read with no side effect and no session, so there is no Origin check to make: a cross-origin reader
 * learns exactly what any visitor to the public site already sees.
 */
export async function handleServices(
  request: Request,
  options: ServicesHandlerOptions = {},
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const page = await readServices({ limit: params.get('limit'), cursor: params.get('cursor') }, options);
  if (page === null) {
    return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.');
  }
  return new Response(JSON.stringify({ items: page.items, nextCursor: page.nextCursor }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * `GET /api/services/:slug`.
 *
 * The outcomes reach the browser as the statuses the owner approved: 200 with the service, 301 to the
 * canonical URL on whichever surface owns it, 404 when nothing public answers to it.
 */
export async function handleService(
  request: Request,
  slug: string,
  options: ServicesHandlerOptions = {},
): Promise<Response> {
  const locale = new URL(request.url).searchParams.get('locale') ?? undefined;
  const found = await readService(slug, locale, options);

  if (found.kind === 'moved') {
    const base = found.canonicalType === 'service' ? '/api/services' : '/api/listings';
    return new Response(null, {
      status: 301,
      headers: {
        location: `${base}/${encodeURIComponent(found.canonicalSlug)}`,
        'cache-control': 'no-store',
      },
    });
  }
  if (found.kind === 'not_found') {
    return problemResponse(404, 'Not Found', 'NOT_FOUND', 'The requested resource was not found.');
  }
  if (found.kind === 'unavailable') {
    return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.');
  }

  return new Response(JSON.stringify({ service: found.service }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
