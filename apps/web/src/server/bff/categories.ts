import 'server-only';
import {
  CategoriesResponseSchema,
  CategoryDetailResponseSchema,
  CategoryFeedResponseSchema,
  PROBLEM_JSON_MEDIA_TYPE,
  catalogFiltersToParams,
  publicLocaleOf,
  type CatalogFilters,
  type CategoriesResponse,
  type CategoryDetail,
  type CategoryFeedResponse,
  type CategorySeo,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';

/**
 * The BFF half of the public category tree (Phase 4-A).
 *
 * The browser never reaches the API and never reaches Supabase; it asks this origin, and this module
 * makes the one internal hop with the BFF credential attached. That is the same path every other BFF
 * module takes — the difference is that this one carries no session, because the tree is the same for
 * everyone.
 *
 * The answer is **validated** rather than forwarded. A category page renders whatever comes back, so a
 * malformed upstream body must become a clean failure here instead of a broken tree in someone's
 * browser; and validating with the shared contract means the page and the API cannot drift apart
 * silently.
 */

const UNAVAILABLE_PROBLEM = {
  type: 'about:blank',
  title: 'Service Unavailable',
  status: 503,
  detail: 'The service is temporarily unavailable.',
  instance: '/categories',
  code: 'SERVICE_UNAVAILABLE',
} as const;

export interface CategoriesHandlerOptions {
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
 * Fetches and validates the tree, or returns null when it could not be read.
 *
 * Exported separately from the route handler so a server component can render the page without a second
 * HTTP hop to its own origin.
 */
export async function readCategories(
  locale: string | undefined,
  options: CategoriesHandlerOptions = {},
): Promise<CategoriesResponse | null> {
  const config = readBffConfig(options.env);
  const call = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);
  const query = `?locale=${encodeURIComponent(publicLocaleOf(locale))}`;

  let upstream: Response;
  try {
    upstream = await call(`${config.apiBaseUrl}/v1/categories${query}`, { method: 'GET' });
  } catch {
    return null;
  }
  if (!upstream.ok) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await upstream.text());
  } catch {
    return null;
  }
  const result = CategoriesResponseSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * `GET /api/categories`.
 *
 * A read with no side effect and no session, so there is no Origin check to make and nothing to set: a
 * cross-origin reader of this route learns exactly what any visitor to the public site already sees.
 * The response is rebuilt from the validated value rather than forwarded, so an upstream body can never
 * grow a field that reaches the browser by accident.
 */
export async function handleCategories(
  request: Request,
  options: CategoriesHandlerOptions = {},
): Promise<Response> {
  const locale = new URL(request.url).searchParams.get('locale') ?? undefined;
  const categories = await readCategories(locale, options);
  if (categories === null) return problemResponse(503);

  return new Response(JSON.stringify({ categories: categories.categories }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * What a category read resolved to.
 *
 * Three outcomes, not four: categories keep no slug history, so there is no `moved`. `seo` rides along
 * with a found category because the page needs it for the document head — it is server-side only and is
 * never put into the response the browser receives.
 */
export type CategoryLookup =
  | { readonly kind: 'found'; readonly category: CategoryDetail; readonly seo: CategorySeo }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unavailable' };

/** One category by slug, a 404, or a failure — the three a page must render. */
export async function readCategory(
  slug: string,
  locale: string | undefined,
  options: CategoriesHandlerOptions = {},
): Promise<CategoryLookup> {
  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);
  const path = `/v1/categories/${encodeURIComponent(slug)}?locale=${encodeURIComponent(publicLocaleOf(locale))}`;

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}${path}`, { method: 'GET' });
  } catch {
    return { kind: 'unavailable' };
  }

  if (upstream.status === 404) return { kind: 'not_found' };
  if (!upstream.ok) return { kind: 'unavailable' };

  try {
    const result = CategoryDetailResponseSchema.safeParse(JSON.parse(await upstream.text()));
    return result.success
      ? { kind: 'found', category: result.data.category, seo: result.data.seo }
      : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/**
 * What a category's feed resolved to (Phase 8-D).
 *
 * `not_found` is the API's one neutral answer for a category that does not exist, is switched off, or sits
 * under something switched off — the page does not try to tell them apart, because the API deliberately does
 * not. `unavailable` is kept separate from an empty page for the usual reason: a page that said "nothing in
 * this category" when a request timed out would be telling a visitor the shelf was bare.
 */
export type CategoryFeedLookup =
  | {
      readonly kind: 'found';
      readonly items: CategoryFeedResponse['items'];
      readonly nextCursor: string | null;
      readonly facets: CategoryFeedResponse['facets'];
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' };

/**
 * One page of a category's listings, with the filter panel that produced it.
 *
 * The filters are forwarded as the query string they arrived in, rebuilt from the **validated** document
 * rather than passed through: a parameter this contract does not define cannot reach the API even if a
 * visitor appends one, and a malformed one is `invalid` here rather than somebody else's problem.
 */
export async function readCategoryFeed(
  slug: string,
  input: {
    readonly locale: string | undefined;
    readonly filters: CatalogFilters;
    readonly cursor?: string | null;
    readonly limit?: number;
  },
  options: CategoriesHandlerOptions = {},
): Promise<CategoryFeedLookup> {
  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  const query = new URLSearchParams();
  query.set('locale', publicLocaleOf(input.locale));
  if (input.limit !== undefined) query.set('limit', String(input.limit));
  if (input.cursor !== undefined && input.cursor !== null && input.cursor !== '') {
    query.set('cursor', input.cursor);
  }
  for (const [name, value] of catalogFiltersToParams(input.filters)) query.append(name, value);

  const path = `/v1/categories/${encodeURIComponent(slug)}/listings?${query.toString()}`;

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}${path}`, { method: 'GET' });
  } catch {
    return { kind: 'unavailable' };
  }

  if (upstream.status === 404) return { kind: 'not_found' };
  if (upstream.status === 400) return { kind: 'invalid' };
  if (!upstream.ok) return { kind: 'unavailable' };

  try {
    const result = CategoryFeedResponseSchema.safeParse(JSON.parse(await upstream.text()));
    // Rebuilt from the validated fields: a field the contract does not name has nowhere to go.
    return result.success
      ? {
          kind: 'found',
          items: result.data.items,
          nextCursor: result.data.nextCursor,
          facets: result.data.facets,
        }
      : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/**
 * `GET /api/categories/:slug`.
 *
 * A read with no side effect and no session. The response carries the category and **not** the SEO
 * fields: those exist to build a document head on the server, and a browser has no use for them.
 */
export async function handleCategory(
  request: Request,
  slug: string,
  options: CategoriesHandlerOptions = {},
): Promise<Response> {
  const locale = new URL(request.url).searchParams.get('locale') ?? undefined;
  const found = await readCategory(slug, locale, options);

  if (found.kind === 'not_found') {
    return new Response(
      JSON.stringify({
        ...UNAVAILABLE_PROBLEM,
        status: 404,
        title: 'Not Found',
        code: 'NOT_FOUND',
        detail: 'The requested resource was not found.',
      }),
      { status: 404, headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' } },
    );
  }
  if (found.kind === 'unavailable') return problemResponse(503);

  return new Response(JSON.stringify({ category: found.category }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
