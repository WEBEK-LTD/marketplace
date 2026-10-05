import 'server-only';
import {
  PROBLEM_JSON_MEDIA_TYPE,
  PublicBlogIndexResponseSchema,
  PublicBlogPostLookupResponseSchema,
  PublicBlogTaxonomyResponseSchema,
  publicLocaleOf,
  type PublicBlogIndexResponse,
  type PublicBlogPost,
  type PublicBlogTaxonomyResponse,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';

/**
 * The BFF half of the public blog (0092).
 *
 * The browser never reaches the API and never reaches Supabase; it asks this origin, and this module makes the one
 * internal hop with the BFF credential attached. It carries no session, because a post is the same for everyone.
 *
 * The answer is **validated** rather than forwarded. A page renders whatever comes back, so a malformed upstream body
 * must become a clean failure here instead of a broken page in somebody's browser; and validating with the shared
 * contract means the page and the API cannot drift apart silently.
 *
 * **The redirect arrives as data, not as a status line.** `fetch` follows a 301 transparently, so an API that
 * answered one would hand this module the renamed post with a 200 and no way to know the browser should be sent
 * elsewhere. The API therefore reports the outcome in the body, and this module turns it into a `moved` result that
 * the proxy converts into a locale-aware redirect of its own.
 *
 * **A post's `<head>` comes back with the post.** `metaTitle` and `metaDescription` are its translation's own
 * columns; there is no override to fetch and no precedence to apply, which is 0092's second owner decision.
 */

const UNAVAILABLE_PROBLEM = {
  type: 'about:blank',
  title: 'Service Unavailable',
  status: 503,
  detail: 'The service is temporarily unavailable.',
  instance: '/blog',
  code: 'SERVICE_UNAVAILABLE',
} as const;

export interface BlogHandlerOptions {
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
 * What a post read resolved to.
 *
 * Four outcomes, where a category has three: a post keeps its slug history, so `moved` is real here and a post that
 * was renamed has to redirect rather than 404.
 */
export type BlogPostLookup =
  | { readonly kind: 'found'; readonly post: PublicBlogPost }
  | { readonly kind: 'moved'; readonly movedTo: string }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unavailable' };

/** The slug shape the database enforces, narrowed so a value that names no post never reaches the API. */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/;

async function callApi(
  path: string,
  options: BlogHandlerOptions,
): Promise<{ ok: true; body: unknown } | { ok: false; status: number }> {
  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}${path}`, { method: 'GET' });
  } catch {
    return { ok: false, status: 503 };
  }

  if (!upstream.ok) {
    await upstream.text().catch(() => '');
    return { ok: false, status: upstream.status };
  }

  try {
    return { ok: true, body: JSON.parse(await upstream.text()) };
  } catch {
    return { ok: false, status: 503 };
  }
}

/** One post by slug, a redirect, a 404, or a failure — the four the proxy and the page must handle. */
export async function readBlogPost(
  slug: string,
  locale: string,
  options: BlogHandlerOptions = {},
): Promise<BlogPostLookup> {
  // A string that cannot be a slug names no post, so it is an absence rather than an upstream round trip.
  if (!SLUG_PATTERN.test(slug)) return { kind: 'not_found' };

  const query = new URLSearchParams({ locale: publicLocaleOf(locale) });
  const result = await callApi(`/v1/blog/${encodeURIComponent(slug)}?${query.toString()}`, options);
  if (!result.ok) return result.status === 404 ? { kind: 'not_found' } : { kind: 'unavailable' };

  const parsed = PublicBlogPostLookupResponseSchema.safeParse(result.body);
  if (!parsed.success) return { kind: 'unavailable' };
  return parsed.data.outcome === 'moved'
    ? { kind: 'moved', movedTo: parsed.data.movedTo }
    : { kind: 'found', post: parsed.data.post };
}

/** One page of the index, or null when it could not be read. */
export async function readBlogIndex(
  input: {
    readonly locale: string;
    readonly category?: string | null;
    readonly tag?: string | null;
    readonly cursor?: string | null;
  },
  options: BlogHandlerOptions = {},
): Promise<PublicBlogIndexResponse | null> {
  const query = new URLSearchParams({ locale: publicLocaleOf(input.locale) });
  // Each filter is forwarded only when it could name something. A malformed one is dropped rather than refused,
  // because the honest answer to a mangled link is the unfiltered index, not an error page.
  if (typeof input.category === 'string' && SLUG_PATTERN.test(input.category)) {
    query.set('category', input.category);
  }
  if (typeof input.tag === 'string' && SLUG_PATTERN.test(input.tag)) query.set('tag', input.tag);
  if (typeof input.cursor === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(input.cursor)) {
    query.set('cursor', input.cursor);
  }

  const result = await callApi(`/v1/blog?${query.toString()}`, options);
  if (!result.ok) return null;
  const parsed = PublicBlogIndexResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

/** The filters the index offers, or null when they could not be read. The index renders without them. */
export async function readBlogTaxonomy(
  locale: string,
  options: BlogHandlerOptions = {},
): Promise<PublicBlogTaxonomyResponse | null> {
  const query = new URLSearchParams({ locale: publicLocaleOf(locale) });
  const result = await callApi(`/v1/blog/taxonomy?${query.toString()}`, options);
  if (!result.ok) return null;
  const parsed = PublicBlogTaxonomyResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

/**
 * `GET /api/blog` — the index, for a browser that wants another page of it.
 *
 * Present for the same reason the catalogue's own handlers are: paging is a client concern and the browser must be
 * able to ask without the API's address or credential.
 */
export async function handleBlogIndex(
  request: Request,
  options: BlogHandlerOptions = {},
): Promise<Response> {
  const url = new URL(request.url);
  const page = await readBlogIndex(
    {
      locale: url.searchParams.get('locale') ?? 'en',
      category: url.searchParams.get('category'),
      tag: url.searchParams.get('tag'),
      cursor: url.searchParams.get('cursor'),
    },
    options,
  );
  if (page === null) return problemResponse(503);
  return new Response(JSON.stringify(page), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
