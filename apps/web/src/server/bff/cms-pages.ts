import 'server-only';
import {
  PROBLEM_JSON_MEDIA_TYPE,
  PublicCmsPageLookupResponseSchema,
  PublicCmsPagesResponseSchema,
  publicLocaleOf,
  type PublicCmsPage,
  type PublicCmsPageLink,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';

/**
 * The BFF half of the public CMS pages.
 *
 * The browser never reaches the API and never reaches Supabase; it asks this origin, and this module makes the
 * one internal hop with the BFF credential attached. This one carries no session, because a page is the same
 * for everyone.
 *
 * The answer is **validated** rather than forwarded. A page renders whatever comes back, so a malformed
 * upstream body must become a clean failure here instead of a broken page in somebody's browser; and validating
 * with the shared contract means the page and the API cannot drift apart silently.
 *
 * **The redirect arrives as data, not as a status line.** `fetch` follows a 301 transparently, so an API that
 * answered one would hand this module the renamed page with a 200 and no way to know the browser should be sent
 * elsewhere. The API therefore reports the outcome in the body, and this module turns it into a `moved`
 * result that the page converts into a locale-aware redirect of its own.
 *
 * **The published index (`readCmsPages`, `GET /api/cms/pages`) has no page rendering it, and that is on
 * purpose.** The specification fixes the footer as a placeholder — "footer with year and name" — and names no
 * page-index or navigation surface, so building one here would be inventing a requirement rather than
 * implementing one. The read exists because the addresses are fixed while the *published* set is not, which is
 * what a locale-aware sitemap (D6) and any future navigation will both need to ask.
 */

const UNAVAILABLE_PROBLEM = {
  type: 'about:blank',
  title: 'Service Unavailable',
  status: 503,
  detail: 'The service is temporarily unavailable.',
  instance: '/cms/pages',
  code: 'SERVICE_UNAVAILABLE',
} as const;

export interface CmsPagesHandlerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}

function problemResponse(status: number): Response {
  return new Response(JSON.stringify({ ...UNAVAILABLE_PROBLEM, status }), {
    status,
    headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
  });
}

/**
 * What a page read resolved to.
 *
 * Four outcomes, where a category has three: a page keeps its slug history, so `moved` is real here and a page
 * that was renamed has to redirect rather than 404.
 */
export type CmsPageLookup =
  | { readonly kind: 'found'; readonly page: PublicCmsPage }
  | { readonly kind: 'moved'; readonly movedTo: string }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unavailable' };

/** One page by slug, a redirect, a 404, or a failure — the four a page must render. */
export async function readCmsPage(
  slug: string,
  locale: string | undefined,
  options: CmsPagesHandlerOptions = {},
): Promise<CmsPageLookup> {
  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);
  const path = `/v1/cms/pages/${encodeURIComponent(slug)}?locale=${encodeURIComponent(publicLocaleOf(locale))}`;

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}${path}`, { method: 'GET' });
  } catch {
    return { kind: 'unavailable' };
  }

  if (upstream.status === 404) return { kind: 'not_found' };
  if (!upstream.ok) return { kind: 'unavailable' };

  try {
    const result = PublicCmsPageLookupResponseSchema.safeParse(JSON.parse(await upstream.text()));
    if (!result.success) return { kind: 'unavailable' };
    return result.data.outcome === 'moved'
      ? { kind: 'moved', movedTo: result.data.movedTo }
      : { kind: 'found', page: result.data.page };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** Every page the public may see, or null when the index could not be read. */
export async function readCmsPages(
  locale: string | undefined,
  options: CmsPagesHandlerOptions = {},
): Promise<readonly PublicCmsPageLink[] | null> {
  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);
  const query = `?locale=${encodeURIComponent(publicLocaleOf(locale))}`;

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}/v1/cms/pages${query}`, { method: 'GET' });
  } catch {
    return null;
  }
  if (!upstream.ok) return null;

  try {
    const result = PublicCmsPagesResponseSchema.safeParse(JSON.parse(await upstream.text()));
    return result.success ? result.data.pages : null;
  } catch {
    return null;
  }
}

/**
 * `GET /api/cms/pages`.
 *
 * A read with no side effect and no session, so there is no Origin check to make and nothing to set: a
 * cross-origin reader of this route learns exactly what any visitor to the public site already sees. The
 * response is rebuilt from the validated value rather than forwarded, so an upstream body can never grow a
 * field that reaches the browser by accident.
 */
export async function handleCmsPages(
  request: Request,
  options: CmsPagesHandlerOptions = {},
): Promise<Response> {
  const locale = new URL(request.url).searchParams.get('locale') ?? undefined;
  const pages = await readCmsPages(locale, options);
  if (pages === null) return problemResponse(503);

  return new Response(JSON.stringify({ pages }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * `GET /api/cms/pages/:slug`.
 *
 * A read with no side effect and no session. A moved slug is reported as data here too rather than as a 301:
 * this route exists for a client that wants the page, and a client following a redirect it did not expect is
 * the same hazard one layer further out.
 */
export async function handleCmsPage(
  request: Request,
  slug: string,
  options: CmsPagesHandlerOptions = {},
): Promise<Response> {
  const locale = new URL(request.url).searchParams.get('locale') ?? undefined;
  const found = await readCmsPage(slug, locale, options);

  if (found.kind === 'not_found') {
    return new Response(
      JSON.stringify({
        ...UNAVAILABLE_PROBLEM,
        status: 404,
        title: 'Not Found',
        code: 'NOT_FOUND',
        detail: 'The requested resource was not found.',
        instance: `/cms/pages/${slug}`,
      }),
      { status: 404, headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' } },
    );
  }
  if (found.kind === 'unavailable') return problemResponse(503);
  if (found.kind === 'moved') {
    return new Response(JSON.stringify({ outcome: 'moved', movedTo: found.movedTo }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  return new Response(JSON.stringify({ outcome: 'page', page: found.page }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
