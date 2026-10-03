import 'server-only';
import {
  BLOG_POST_STATUSES,
  BlogPostDetailResponseSchema,
  BlogPostPageResponseSchema,
  BlogPostStatusRequestSchema,
  BlogTaxonomyResponseSchema,
  BlogWriteResponseSchema,
  CreateBlogPostRequestSchema,
  CreateBlogPostResponseSchema,
  PROBLEM_JSON_MEDIA_TYPE,
  SESSION_TOKEN_HEADER,
  SaveBlogCategoryRequestSchema,
  SaveBlogPostTagsRequestSchema,
  SaveBlogPostTranslationRequestSchema,
  SaveBlogTagRequestSchema,
  SaveBlogTaxonomyResponseSchema,
  UpdateBlogPostRequestSchema,
  type BlogPostDetail,
  type BlogPostPageResponse,
  type BlogTaxonomyResponse,
} from '@repo/contracts';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { readAdminAccessToken } from './staff-session';

/**
 * The blog, on the admin origin (0092).
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
 * **Every write is same-origin and rebuilt** from the contract's own fields, so a `status` on a rename or an
 * `authorUserId` a browser invents has nowhere to go. The one place where absence is preserved exactly is the post
 * update: an absent reference and an explicit null mean different things there, and flattening them would make a
 * category impossible to remove.
 *
 * **Refusals are forwarded with the API's own problem body**, because this surface has several an operator must
 * read: an address already in use, a post that cannot be published before it is written, a featured flag on a draft,
 * and a category or tag that does not exist.
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

export interface BlogOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

/**
 * What a read resolved to.
 *
 * `notFound` is the API's one neutral answer: no such post, or a caller without the key the operation needs.
 */
export type BlogResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' };

/** base64url, which is the whole of what a cursor can be. Refused here rather than forwarded. */
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCALE_PATTERN = /^[a-z]{2}$/;
const SEARCH_MAX = 200;

function identifier(value: string | null): string | null {
  return value !== null && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function query(input: {
  readonly cursor?: string | null;
  readonly limit?: string | null;
  readonly status?: string | null;
  readonly search?: string | null;
  readonly categoryId?: string | null;
}): string {
  const params = new URLSearchParams();
  if (typeof input.limit === 'string' && /^\d{1,3}$/.test(input.limit)) params.set('limit', input.limit);
  if (typeof input.status === 'string' && (BLOG_POST_STATUSES as readonly string[]).includes(input.status)) {
    params.set('status', input.status);
  }
  // Forwarded as text, bounded only by length: the database matches it as a literal substring, so there is no
  // pattern syntax to strip and stripping characters would silently change what somebody searched for.
  if (typeof input.search === 'string' && input.search.trim() !== '' && input.search.length <= SEARCH_MAX) {
    params.set('search', input.search.trim());
  }
  const category = identifier(input.categoryId ?? null);
  if (category !== null) params.set('categoryId', category);
  if (typeof input.cursor === 'string' && CURSOR_PATTERN.test(input.cursor)) {
    // Passed along as text. This layer does not know what a cursor contains and must not learn.
    params.set('cursor', input.cursor);
  }
  return params.size === 0 ? '' : `?${params.toString()}`;
}

async function read<T>(
  path: string,
  options: BlogOptions,
  parse: (body: unknown) => { success: true; data: T } | { success: false },
): Promise<BlogResult<T>> {
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

/** One page of authored posts, newest edit first. */
export async function readBlogPosts(
  input: {
    readonly cursor?: string | null;
    readonly limit?: string | null;
    readonly status?: string | null;
    readonly search?: string | null;
    readonly categoryId?: string | null;
  } = {},
  options: BlogOptions = {},
): Promise<BlogResult<BlogPostPageResponse>> {
  return await read(`/v1/admin/blog${query(input)}`, options, (body) =>
    BlogPostPageResponseSchema.safeParse(body),
  );
}

/**
 * One post, with its locales, its tags and its retired slugs.
 *
 * A malformed id is `notFound` rather than a validation failure: the value came from the address somebody typed, and
 * the honest answer to a made-up address is that there is nothing at it.
 */
export async function readBlogPost(
  postId: string | undefined,
  options: BlogOptions = {},
): Promise<BlogResult<BlogPostDetail>> {
  const id = identifier(postId ?? null);
  if (id === null) return { kind: 'notFound' };
  const result = await read(`/v1/admin/blog/${encodeURIComponent(id)}`, options, (body) =>
    BlogPostDetailResponseSchema.safeParse(body),
  );
  return result.kind === 'ok' ? { kind: 'ok', data: result.data.post } : result;
}

/** The categories and tags, active or not, with whether this caller may change them. */
export async function readBlogTaxonomy(
  options: BlogOptions = {},
): Promise<BlogResult<BlogTaxonomyResponse>> {
  return await read('/v1/admin/blog/taxonomy', options, (body) =>
    BlogTaxonomyResponseSchema.safeParse(body),
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Writes                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

async function acceptWrite(
  request: Request,
  options: BlogOptions,
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
  options: BlogOptions,
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

/** `POST /api/blog` — create a draft. */
export async function handleBlogPostCreate(request: Request, options: BlogOptions = {}): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const validated = CreateBlogPostRequestSchema.safeParse({
    slug: accepted.body['slug'],
    ...('categoryId' in accepted.body ? { categoryId: accepted.body['categoryId'] } : {}),
    ...('isIndexable' in accepted.body ? { isIndexable: accepted.body['isIndexable'] } : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite('POST', '/v1/admin/blog', accepted.accessToken, validated.data, options);
  return await writeOutcome(upstream, 201, (body) => CreateBlogPostResponseSchema.safeParse(body));
}

/**
 * `PATCH /api/blog` — change a post's address or presentation.
 *
 * **Absence is preserved exactly**, which is the one thing this handler must get right: a key the browser did not
 * send is not rebuilt as null, because null here means "clear this reference" and absent means "leave it alone".
 * `status` is not among the fields forwarded, so a rename can never publish a post however the body is shaped.
 */
export async function handleBlogPostUpdate(request: Request, options: BlogOptions = {}): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const postId = identifier(typeof accepted.body['postId'] === 'string' ? accepted.body['postId'] : null);
  if (postId === null) return VALIDATION_FAILED();

  const validated = UpdateBlogPostRequestSchema.safeParse({
    ...('slug' in accepted.body ? { slug: accepted.body['slug'] } : {}),
    ...('categoryId' in accepted.body ? { categoryId: accepted.body['categoryId'] } : {}),
    ...('coverMediaId' in accepted.body ? { coverMediaId: accepted.body['coverMediaId'] } : {}),
    ...('isIndexable' in accepted.body ? { isIndexable: accepted.body['isIndexable'] } : {}),
    ...('isFeatured' in accepted.body ? { isFeatured: accepted.body['isFeatured'] } : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PATCH',
    `/v1/admin/blog/${encodeURIComponent(postId)}`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => BlogWriteResponseSchema.safeParse(body));
}

/** `POST /api/blog/status` — move a post through its lifecycle. The only route here that can publish one. */
export async function handleBlogPostStatus(request: Request, options: BlogOptions = {}): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const postId = identifier(typeof accepted.body['postId'] === 'string' ? accepted.body['postId'] : null);
  if (postId === null) return VALIDATION_FAILED();

  const validated = BlogPostStatusRequestSchema.safeParse({
    status: accepted.body['status'],
    ...('scheduledFor' in accepted.body ? { scheduledFor: accepted.body['scheduledFor'] } : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PUT',
    `/v1/admin/blog/${encodeURIComponent(postId)}/status`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => BlogWriteResponseSchema.safeParse(body));
}

/** `PUT /api/blog/translations` — write one locale of a post. */
export async function handleBlogTranslationSave(
  request: Request,
  options: BlogOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const postId = identifier(typeof accepted.body['postId'] === 'string' ? accepted.body['postId'] : null);
  const locale = typeof accepted.body['localeCode'] === 'string' ? accepted.body['localeCode'] : '';
  if (postId === null || !LOCALE_PATTERN.test(locale)) return VALIDATION_FAILED();

  const validated = SaveBlogPostTranslationRequestSchema.safeParse({
    title: accepted.body['title'],
    body: accepted.body['body'],
    ...('excerpt' in accepted.body ? { excerpt: accepted.body['excerpt'] } : {}),
    ...('metaTitle' in accepted.body ? { metaTitle: accepted.body['metaTitle'] } : {}),
    ...('metaDescription' in accepted.body ? { metaDescription: accepted.body['metaDescription'] } : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PUT',
    `/v1/admin/blog/${encodeURIComponent(postId)}/translations/${encodeURIComponent(locale)}`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => BlogWriteResponseSchema.safeParse(body));
}

/**
 * `POST /api/blog/translations/remove` — remove one locale.
 *
 * A `POST` on this origin and a `DELETE` upstream, for the reason the other remove routes give: the same-origin
 * check reads a submitted body, and the browser form that drives this submits one.
 */
export async function handleBlogTranslationRemove(
  request: Request,
  options: BlogOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const postId = identifier(typeof accepted.body['postId'] === 'string' ? accepted.body['postId'] : null);
  const locale = typeof accepted.body['localeCode'] === 'string' ? accepted.body['localeCode'] : '';
  if (postId === null || !LOCALE_PATTERN.test(locale)) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'DELETE',
    `/v1/admin/blog/${encodeURIComponent(postId)}/translations/${encodeURIComponent(locale)}`,
    accepted.accessToken,
    undefined,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => BlogWriteResponseSchema.safeParse(body));
}

/** `PUT /api/blog/tags` — replace a post's whole tag set. */
export async function handleBlogPostTags(request: Request, options: BlogOptions = {}): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const postId = identifier(typeof accepted.body['postId'] === 'string' ? accepted.body['postId'] : null);
  if (postId === null) return VALIDATION_FAILED();

  const validated = SaveBlogPostTagsRequestSchema.safeParse({ tagIds: accepted.body['tagIds'] });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PUT',
    `/v1/admin/blog/${encodeURIComponent(postId)}/tags`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => BlogWriteResponseSchema.safeParse(body));
}

/**
 * `POST /api/blog/taxonomy` — create or replace one category or tag.
 *
 * One route for four upstream operations, chosen by which kind the body names and whether it carries an id. The
 * alternative — four browser routes — would mean four same-origin checks and four copies of this validation.
 */
export async function handleBlogTaxonomySave(
  request: Request,
  options: BlogOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const kind = accepted.body['kind'];
  if (kind !== 'category' && kind !== 'tag') return VALIDATION_FAILED();
  const entryId = typeof accepted.body['entryId'] === 'string' ? identifier(accepted.body['entryId']) : null;
  // An id that was sent but is not one is a refusal rather than a create: the alternative would silently make a
  // new category when somebody meant to edit an existing one.
  if (typeof accepted.body['entryId'] === 'string' && entryId === null) return VALIDATION_FAILED();

  const shared = {
    ...('slug' in accepted.body ? { slug: accepted.body['slug'] } : {}),
    ...('nameEn' in accepted.body ? { nameEn: accepted.body['nameEn'] } : {}),
    ...('nameAr' in accepted.body ? { nameAr: accepted.body['nameAr'] } : {}),
    ...('isActive' in accepted.body ? { isActive: accepted.body['isActive'] } : {}),
  };

  const validated =
    kind === 'category'
      ? SaveBlogCategoryRequestSchema.safeParse({
          ...shared,
          ...('descriptionEn' in accepted.body ? { descriptionEn: accepted.body['descriptionEn'] } : {}),
          ...('descriptionAr' in accepted.body ? { descriptionAr: accepted.body['descriptionAr'] } : {}),
          ...('sortOrder' in accepted.body ? { sortOrder: accepted.body['sortOrder'] } : {}),
        })
      : SaveBlogTagRequestSchema.safeParse(shared);
  if (!validated.success) return VALIDATION_FAILED();

  const collection = kind === 'category' ? 'categories' : 'tags';
  const upstream =
    entryId === null
      ? await callWrite(
          'POST',
          `/v1/admin/blog/${collection}`,
          accepted.accessToken,
          validated.data,
          options,
        )
      : await callWrite(
          'PATCH',
          `/v1/admin/blog/${collection}/${encodeURIComponent(entryId)}`,
          accepted.accessToken,
          validated.data,
          options,
        );
  return await writeOutcome(upstream, entryId === null ? 201 : 200, (body) =>
    SaveBlogTaxonomyResponseSchema.safeParse(body),
  );
}
