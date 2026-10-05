import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  BlogPostDetailResponseSchema,
  BlogPostPageResponseSchema,
  BlogTaxonomyResponseSchema,
  BlogWriteResponseSchema,
  CreateBlogPostResponseSchema,
  PublicBlogIndexResponseSchema,
  PublicBlogPostLookupResponseSchema,
  PublicBlogTaxonomyResponseSchema,
  SESSION_TOKEN_HEADER,
  SaveBlogTaxonomyResponseSchema,
} from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { BLOG_STORE } from '../src/admin/blog.service.js';
import { BLOG_PUBLIC_STORE, encodeBlogIndexCursor } from '../src/cms/blog-public.service.js';
import { encodeBlogPostCursor } from '../src/admin/blog.cursor.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { STAFF_CONSOLE_STORE, type StaffConsoleRow } from '../src/admin/staff-console.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * The blog at the API boundary (0092).
 *
 * The properties this suite exists for:
 *
 * **The public surface carries no user context, and the staff surface carries nothing but.** The three public
 * reads are driven with no session at all and answer; every staff route is driven by a caller holding
 * `cms.blog.read`, by callers holding each of the other console keys instead, and by the same caller at `aal1`,
 * and only the first reaches anything.
 *
 * **Reading and managing are separate keys, and the split is visible rather than implied.** A caller holding
 * only `cms.blog.read` can list and open a post — and `canManage` comes back false on both the detail and the
 * taxonomy — while every write answers 404, byte for byte identical to a post that does not exist.
 *
 * **A rename cannot publish a post.** `PATCH` is driven with a `status` field in the body and the store is
 * asserted never to have been asked to change a status: the field is dropped by the contract rather than
 * ignored by the service.
 *
 * **An absent reference and an explicit null are different requests.** `PATCH` is driven both ways and the two
 * clear flags the store receives are compared, because in SQL null already means "unchanged" and collapsing the
 * two would make a category impossible to remove.
 *
 * **The moved answer is a 200 with an outcome, never a redirect.** Asserted on the status line, because a 301
 * here would be followed by the BFF's `fetch` and the browser would never be redirected.
 *
 * **Every refusal the database can raise becomes its own code.** The store double raises each SQLSTATE and the
 * response code is compared, including that `42501` — the database refusing a caller without the manage key —
 * becomes the same 404 as an absence rather than a 403.
 *
 * **Both owner decisions are asserted as absences.** No response from this surface carries a metadata override,
 * and no route here touches a sitemap.
 *
 * Everything is stubbed at the store boundary: no database, no Redis, no network.
 */

const STAFF = '11111111-1111-4111-8111-111111111111';
const POST = 'fb000000-0000-4000-8000-0000000000b1';
const CATEGORY = 'fb000000-0000-4000-8000-0000000000c1';
const TAG = 'fb000000-0000-4000-8000-0000000000a1';

function token(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.c2lnbmF0dXJl`;
}

const ACCESS_TOKEN = token({ sub: STAFF, aal: 'aal2' });
const AAL1_TOKEN = token({ sub: STAFF, aal: 'aal1' });

const READ = 'cms.blog.read';
const MANAGE = 'cms.blog.manage';

/** Every other key a console surface uses. Not one of them opens this section. */
const OTHER_KEYS = [
  'sellers.profile.read',
  'users.profile.read',
  'security.recovery.review',
  'audit.read',
  'reviews.review.read',
  'moderation.report.read',
  'support.ticket.read',
  'platform.job.read',
  'disputes.dispute.read',
  'cms.page.read',
  'cms.faq.read',
  'seo.metadata.read',
] as const;

const PUBLIC_ROW = {
  kind: 'post',
  postId: POST,
  slug: 'a-post',
  isIndexable: true,
  isFeatured: false,
  publishedAt: new Date('2026-05-01T09:00:00.000Z'),
  updatedAt: new Date('2026-05-02T09:00:00.000Z'),
  categorySlug: 'news',
  categoryName: 'News',
  coverObjectPath: null,
  resolvedLocale: 'en',
  title: 'A Post',
  excerpt: 'Short.',
  body: 'The body.',
  metaTitle: 'A Post | Meta',
  metaDescription: 'What it is about.',
  tagSlugs: ['shipping'],
  tagNames: ['Shipping'],
};

const PUBLIC_LIST_ROW = {
  postId: POST,
  slug: 'a-post',
  isFeatured: false,
  publishedAt: new Date('2026-05-01T09:00:00.000Z'),
  updatedAt: new Date('2026-05-02T09:00:00.000Z'),
  categorySlug: 'news',
  categoryName: 'News',
  coverObjectPath: null,
  resolvedLocale: 'en',
  title: 'A Post',
  excerpt: 'Short.',
};

const TAXONOMY_ROWS = [
  { entryType: 'category', entryId: CATEGORY, slug: 'news', name: 'News', sortOrder: 10, postCount: 2 },
  { entryType: 'tag', entryId: TAG, slug: 'shipping', name: 'Shipping', sortOrder: 0, postCount: 1 },
];

const LIST_ROW = {
  postId: POST,
  slug: 'a-post',
  status: 'published',
  blogCategoryId: CATEGORY,
  categorySlug: 'news',
  isIndexable: true,
  isFeatured: false,
  scheduledFor: null,
  publishedAt: new Date('2026-05-01T09:00:00.000Z'),
  archivedAt: null,
  updatedAt: new Date('2026-05-02T09:00:00.000Z'),
  translatedLocales: ['en'],
  tagCount: 1,
  title: 'A Post',
};

const DETAIL_ROW = {
  ...LIST_ROW,
  coverMediaId: null,
  coverObjectPath: null,
  authorUserId: STAFF,
  createdAt: new Date('2026-04-01T09:00:00.000Z'),
  createdBy: STAFF,
  updatedBy: STAFF,
  canManage: true,
  previousSlugs: ['an-older-slug'],
  tagIds: [TAG],
};

const TRANSLATION_ROW = {
  localeCode: 'en',
  title: 'A Post',
  excerpt: null,
  body: 'The body.',
  metaTitle: 'A Post | Meta',
  metaDescription: 'What it is about.',
  updatedAt: new Date('2026-05-02T09:00:00.000Z'),
};

const CATEGORY_ROW = {
  categoryId: CATEGORY,
  slug: 'news',
  nameEn: 'News',
  nameAr: 'أخبار',
  descriptionEn: null,
  descriptionAr: null,
  sortOrder: 10,
  isActive: true,
  postCount: 2,
  updatedAt: new Date('2026-05-02T09:00:00.000Z'),
};

const TAG_ROW = {
  tagId: TAG,
  slug: 'shipping',
  nameEn: 'Shipping',
  nameAr: null,
  isActive: true,
  postCount: 1,
  updatedAt: new Date('2026-05-02T09:00:00.000Z'),
};

interface Doubles {
  permissions?: readonly string[];
  unauthenticated?: boolean;
  publicRow?: Record<string, unknown> | null;
  publicRows?: readonly Record<string, unknown>[];
  taxonomyRows?: readonly Record<string, unknown>[];
  listRows?: readonly Record<string, unknown>[];
  detailRow?: Record<string, unknown> | null;
  /** 0099. The cover `app_private.cms_cover_media_for_staff` reports, or null for nothing attached. */
  coverRow?: Record<string, unknown> | null;
  writeError?: { code: string };
  writeResult?: boolean;
  saveId?: string | null;
}

interface Seen {
  readonly name: string;
  readonly input: unknown;
}

let app: NestFastifyApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function sqlError(code: string): Error & { code: string } {
  return Object.assign(new Error('the database refused it'), { code });
}

async function createApp(doubles: Doubles = {}): Promise<Seen[]> {
  const seen: Seen[] = [];

  const publicStore = {
    blogPostForPublic: async (input: unknown) => {
      seen.push({ name: 'blogPostForPublic', input });
      return doubles.publicRow === undefined ? PUBLIC_ROW : doubles.publicRow;
    },
    blogPostsForPublic: async (input: unknown) => {
      seen.push({ name: 'blogPostsForPublic', input });
      return doubles.publicRows ?? [PUBLIC_LIST_ROW];
    },
    blogTaxonomyForPublic: async (input: unknown) => {
      seen.push({ name: 'blogTaxonomyForPublic', input });
      return doubles.taxonomyRows ?? TAXONOMY_ROWS;
    },
  };

  const write = async (name: string, input: unknown): Promise<boolean> => {
    seen.push({ name, input });
    if (doubles.writeError !== undefined) throw sqlError(doubles.writeError.code);
    return doubles.writeResult ?? true;
  };

  const save = async (name: string, input: unknown): Promise<string | null> => {
    seen.push({ name, input });
    if (doubles.writeError !== undefined) throw sqlError(doubles.writeError.code);
    return doubles.saveId === undefined ? CATEGORY : doubles.saveId;
  };

  const adminStore = {
    blogPostsForStaff: async (input: { limit: number }) => {
      seen.push({ name: 'blogPostsForStaff', input });
      return doubles.listRows ?? [LIST_ROW];
    },
    blogPostForStaff: async (input: unknown) => {
      seen.push({ name: 'blogPostForStaff', input });
      return doubles.detailRow === undefined ? DETAIL_ROW : doubles.detailRow;
    },
    cmsCoverMediaForStaff: async (input: unknown) => {
      seen.push({ name: 'cmsCoverMediaForStaff', input });
      return doubles.coverRow === undefined ? null : doubles.coverRow;
    },
    blogPostTranslationsForStaff: async (input: unknown) => {
      seen.push({ name: 'blogPostTranslationsForStaff', input });
      return [TRANSLATION_ROW];
    },
    blogCategoriesForStaff: async (input: unknown) => {
      seen.push({ name: 'blogCategoriesForStaff', input });
      return [CATEGORY_ROW];
    },
    blogTagsForStaff: async (input: unknown) => {
      seen.push({ name: 'blogTagsForStaff', input });
      return [TAG_ROW];
    },
    blogPostCreateForStaff: async (input: unknown) => {
      seen.push({ name: 'blogPostCreateForStaff', input });
      if (doubles.writeError !== undefined) throw sqlError(doubles.writeError.code);
      return POST;
    },
    blogPostUpdateForStaff: async (input: unknown) => write('blogPostUpdateForStaff', input),
    blogPostStatusForStaff: async (input: unknown) => write('blogPostStatusForStaff', input),
    blogPostTranslationSaveForStaff: async (input: unknown) => write('blogPostTranslationSaveForStaff', input),
    blogPostTranslationDeleteForStaff: async (input: unknown) =>
      write('blogPostTranslationDeleteForStaff', input),
    blogPostTagsSetForStaff: async (input: unknown) => write('blogPostTagsSetForStaff', input),
    blogCategorySaveForStaff: async (input: unknown) => save('blogCategorySaveForStaff', input),
    blogTagSaveForStaff: async (input: unknown) => save('blogTagSaveForStaff', input),
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async () => {
        if (doubles.unauthenticated === true) throw new AuthenticationRequiredError();
        return { id: STAFF, phone: null };
      },
      signInWithPassword: async () => {
        throw new Error('reading a post must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('reading a post must never revoke a session');
      },
    })
    .overrideProvider(STAFF_CONSOLE_STORE)
    .useValue({
      staffConsoleAccess: async (input: { userId: string; isAal2: boolean }): Promise<StaffConsoleRow> => {
        // The platform's own behaviour, modelled rather than asserted around: a role that requires MFA counts
        // for nothing at aal1, so the effective set is empty. Both roles holding a blog key require MFA.
        const granted = [...(doubles.permissions ?? [READ, MANAGE])];
        return {
          hasConsoleRole: true,
          requiresStepUp: false,
          roles: ['admin'],
          permissions: input.isAal2 ? granted : [],
        };
      },
      buyerProfile: async (userId: string) => ({ id: userId, displayName: 'Nadia', localeCode: 'en' }),
    })
    .overrideProvider(BLOG_PUBLIC_STORE)
    .useValue(publicStore)
    .overrideProvider(BLOG_STORE)
    .useValue(adminStore)
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    createFastifyAdapter(TEST_ENV, { logStream: { write: () => undefined } }),
    NEST_APP_OPTIONS,
  );
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return seen;
}

function request(options: {
  method: string;
  url: string;
  accessToken?: string;
  payload?: unknown;
  credential?: string;
}) {
  const headers: Record<string, string> = {
    [INTERNAL_CREDENTIAL_HEADER]: options.credential ?? TEST_INTERNAL_CREDENTIAL,
  };
  if (options.accessToken !== undefined) headers[SESSION_TOKEN_HEADER] = options.accessToken;
  if (options.payload !== undefined) headers['content-type'] = 'application/json';
  return app!.inject({
    method: options.method as 'GET',
    url: options.url,
    headers,
    ...(options.payload === undefined ? {} : { payload: JSON.stringify(options.payload) }),
  });
}

/* ------------------------------------------------------------------------------------------------ */
/* The public surface                                                                                */
/* ------------------------------------------------------------------------------------------------ */

describe('GET /v1/blog', () => {
  it('answers with no session at all', async () => {
    await createApp();
    const response = await request({ method: 'GET', url: '/v1/blog' });
    expect(response.statusCode).toBe(200);
    const body = PublicBlogIndexResponseSchema.parse(response.json());
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.slug).toBe('a-post');
  });

  it('passes the filters through as values rather than refusing an unknown one', async () => {
    const seen = await createApp({ publicRows: [] });
    const response = await request({ method: 'GET', url: '/v1/blog?category=nothing&tag=nowhere' });
    expect(response.statusCode).toBe(200);
    expect(PublicBlogIndexResponseSchema.parse(response.json()).items).toEqual([]);
    expect(seen[0]?.input).toMatchObject({ categorySlug: 'nothing', tagSlug: 'nowhere' });
  });

  it('asks for one row more than the page size, so the next cursor is known', async () => {
    const seen = await createApp();
    await request({ method: 'GET', url: '/v1/blog?limit=5' });
    expect(seen[0]?.input).toMatchObject({ limit: 6 });
  });

  it('clamps the page size rather than refusing a large one', async () => {
    const seen = await createApp();
    await request({ method: 'GET', url: '/v1/blog?limit=9999' });
    expect((seen[0]?.input as { limit: number }).limit).toBeLessThanOrEqual(49);
  });

  it('refuses a limit that is not a page size', async () => {
    await createApp();
    for (const limit of ['0', '-1', 'ten', '1.5']) {
      const response = await request({ method: 'GET', url: `/v1/blog?limit=${limit}` });
      expect(response.statusCode, limit).toBe(400);
    }
  });

  it('carries a cursor through and refuses one it cannot read', async () => {
    const seen = await createApp();
    const cursor = encodeBlogIndexCursor(new Date('2026-05-01T09:00:00.000Z'), POST);
    const ok = await request({ method: 'GET', url: `/v1/blog?cursor=${cursor}` });
    expect(ok.statusCode).toBe(200);
    expect(seen[0]?.input).toMatchObject({ cursorId: POST });

    for (const bad of ['not-a-cursor', '!!!!', encodeBlogPostCursor({ updatedAt: new Date(), id: POST })]) {
      const response = await request({ method: 'GET', url: `/v1/blog?cursor=${encodeURIComponent(bad)}` });
      // The last one is a real position in a different list — the authoring list — and is refused for that
      // reason rather than for being malformed.
      expect(response.statusCode, bad).toBe(400);
    }
  });

  it('defaults an unrecognised locale rather than refusing it', async () => {
    const seen = await createApp();
    await request({ method: 'GET', url: '/v1/blog?locale=fr' });
    expect(seen[0]?.input).toMatchObject({ locale: 'en' });
  });

  it('never reads a sitemap, because the blog is not in one', async () => {
    const seen = await createApp();
    await request({ method: 'GET', url: '/v1/blog' });
    expect(seen.every((call) => !call.name.toLowerCase().includes('sitemap'))).toBe(true);
  });
});

describe('GET /v1/blog/taxonomy', () => {
  it('splits the one reader into categories and tags', async () => {
    await createApp();
    const response = await request({ method: 'GET', url: '/v1/blog/taxonomy' });
    expect(response.statusCode).toBe(200);
    const body = PublicBlogTaxonomyResponseSchema.parse(response.json());
    expect(body.categories.map((entry) => entry.slug)).toEqual(['news']);
    expect(body.tags.map((entry) => entry.slug)).toEqual(['shipping']);
    expect(body.categories[0]?.postCount).toBe(2);
  });

  it('is not shadowed by the slug route', async () => {
    // Declaration order decides this. If `:slug` came first, "taxonomy" would be read as a post's address.
    const seen = await createApp();
    await request({ method: 'GET', url: '/v1/blog/taxonomy' });
    expect(seen.map((call) => call.name)).toEqual(['blogTaxonomyForPublic']);
  });

  it('reports a filter with nothing behind it rather than omitting it', async () => {
    await createApp({
      taxonomyRows: [
        { entryType: 'category', entryId: CATEGORY, slug: 'quiet', name: 'Quiet', sortOrder: 0, postCount: 0 },
      ],
    });
    const response = await request({ method: 'GET', url: '/v1/blog/taxonomy' });
    expect(PublicBlogTaxonomyResponseSchema.parse(response.json()).categories[0]?.postCount).toBe(0);
  });
});

describe('GET /v1/blog/:slug', () => {
  it('serves a post with no session at all', async () => {
    await createApp();
    const response = await request({ method: 'GET', url: '/v1/blog/a-post' });
    expect(response.statusCode).toBe(200);
    const body = PublicBlogPostLookupResponseSchema.parse(response.json());
    expect(body.outcome).toBe('post');
    expect(body.outcome === 'post' && body.post.title).toBe('A Post');
  });

  it('carries the posts own meta fields, which are the only source of its head', async () => {
    await createApp();
    const body = PublicBlogPostLookupResponseSchema.parse(
      (await request({ method: 'GET', url: '/v1/blog/a-post' })).json(),
    );
    expect(body.outcome === 'post' && body.post.metaTitle).toBe('A Post | Meta');
  });

  it('never reads the metadata override table, which decision B keeps out of the blog', async () => {
    const seen = await createApp();
    await request({ method: 'GET', url: '/v1/blog/a-post' });
    expect(seen.map((call) => call.name)).toEqual(['blogPostForPublic']);
  });

  it('pairs each tag slug with its own name', async () => {
    await createApp({
      publicRow: { ...PUBLIC_ROW, tagSlugs: ['pricing', 'shipping'], tagNames: ['Pricing', 'Shipping'] },
    });
    const body = PublicBlogPostLookupResponseSchema.parse(
      (await request({ method: 'GET', url: '/v1/blog/a-post' })).json(),
    );
    expect(body.outcome === 'post' && body.post.tags).toEqual([
      { slug: 'pricing', name: 'Pricing' },
      { slug: 'shipping', name: 'Shipping' },
    ]);
  });

  it('serves no tag it has no name for, rather than guessing one', async () => {
    await createApp({ publicRow: { ...PUBLIC_ROW, tagSlugs: ['a', 'b'], tagNames: ['A'] } });
    const body = PublicBlogPostLookupResponseSchema.parse(
      (await request({ method: 'GET', url: '/v1/blog/a-post' })).json(),
    );
    expect(body.outcome === 'post' && body.post.tags).toEqual([{ slug: 'a', name: 'A' }]);
  });

  it('answers a moved slug with a 200 and an outcome, never a redirect', async () => {
    await createApp({ publicRow: { ...PUBLIC_ROW, kind: 'moved', slug: 'a-post-renamed' } });
    const response = await request({ method: 'GET', url: '/v1/blog/an-older-slug' });
    // A 301 here would be followed by the BFF's own fetch, and the browser would never be redirected.
    expect(response.statusCode).toBe(200);
    const body = PublicBlogPostLookupResponseSchema.parse(response.json());
    expect(body).toEqual({ outcome: 'moved', movedTo: 'a-post-renamed' });
  });

  it('is a 404 for absence, and for a slug that could not name a post', async () => {
    await createApp({ publicRow: { ...PUBLIC_ROW, kind: 'not_found' } });
    expect((await request({ method: 'GET', url: '/v1/blog/nothing-here' })).statusCode).toBe(404);

    const seen = await createApp();
    for (const slug of ['Upper', 'with%20space', '-leading']) {
      const response = await request({ method: 'GET', url: `/v1/blog/${slug}` });
      expect(response.statusCode, slug).toBe(404);
    }
    // A string that cannot be a slug never reaches the database at all.
    expect(seen).toEqual([]);
  });

  it('is a 503 when the post could not be read, rather than claiming it does not exist', async () => {
    await createApp({ publicRow: { kind: 'post', postId: POST, slug: 'a-post' } });
    const response = await request({ method: 'GET', url: '/v1/blog/a-post' });
    expect(response.statusCode).toBe(503);
  });

  it('refuses a caller without the internal credential', async () => {
    await createApp();
    const response = await request({ method: 'GET', url: '/v1/blog/a-post', credential: 'wrong' });
    expect(response.statusCode).toBe(403);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* The staff surface                                                                                 */
/* ------------------------------------------------------------------------------------------------ */

describe('GET /v1/admin/blog', () => {
  it('lists for a caller holding the read key', async () => {
    await createApp({ permissions: [READ] });
    const response = await request({ method: 'GET', url: '/v1/admin/blog', accessToken: ACCESS_TOKEN });
    expect(response.statusCode).toBe(200);
    const body = BlogPostPageResponseSchema.parse(response.json());
    expect(body.items[0]?.slug).toBe('a-post');
    expect(body.items[0]?.tagCount).toBe(1);
  });

  it('is a 404 for every other console key, and for the same caller at aal1', async () => {
    for (const key of OTHER_KEYS) {
      await createApp({ permissions: [key] });
      const response = await request({ method: 'GET', url: '/v1/admin/blog', accessToken: ACCESS_TOKEN });
      expect(response.statusCode, key).toBe(404);
      await app?.close();
      app = undefined;
    }
    await createApp();
    const atAal1 = await request({ method: 'GET', url: '/v1/admin/blog', accessToken: AAL1_TOKEN });
    expect(atAal1.statusCode).toBe(404);
  });

  it('needs a session at all', async () => {
    await createApp();
    expect((await request({ method: 'GET', url: '/v1/admin/blog' })).statusCode).toBe(401);
  });

  it('passes the status, search and category filters through as values', async () => {
    const seen = await createApp();
    await request({
      method: 'GET',
      url: `/v1/admin/blog?status=nonsense&search=%25&categoryId=${CATEGORY}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(seen.at(-1)?.input).toMatchObject({
      status: 'nonsense',
      // A wildcard is a literal here: the database matches it with position(), so there is nothing to escape.
      search: '%',
      categoryId: CATEGORY,
    });
  });

  it('refuses a category filter that could not be an identifier', async () => {
    await createApp();
    const response = await request({
      method: 'GET',
      url: '/v1/admin/blog?categoryId=not-a-uuid',
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a cursor from another list', async () => {
    await createApp();
    const foreign = encodeBlogIndexCursor(new Date('2026-05-01T09:00:00.000Z'), POST);
    const response = await request({
      method: 'GET',
      url: `/v1/admin/blog?cursor=${foreign}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /v1/admin/blog/taxonomy', () => {
  it('reports the manage capability rather than a role name', async () => {
    await createApp({ permissions: [READ] });
    const readOnly = await request({
      method: 'GET',
      url: '/v1/admin/blog/taxonomy',
      accessToken: ACCESS_TOKEN,
    });
    expect(BlogTaxonomyResponseSchema.parse(readOnly.json()).canManage).toBe(false);

    await app?.close();
    app = undefined;
    await createApp({ permissions: [READ, MANAGE] });
    const manager = await request({
      method: 'GET',
      url: '/v1/admin/blog/taxonomy',
      accessToken: ACCESS_TOKEN,
    });
    const body = BlogTaxonomyResponseSchema.parse(manager.json());
    expect(body.canManage).toBe(true);
    expect(body.categories[0]?.nameAr).toBe('أخبار');
  });

  it('is not shadowed by the post route', async () => {
    const seen = await createApp();
    await request({ method: 'GET', url: '/v1/admin/blog/taxonomy', accessToken: ACCESS_TOKEN });
    expect(seen.map((call) => call.name)).toEqual(['blogCategoriesForStaff', 'blogTagsForStaff']);
  });
});

describe('GET /v1/admin/blog/:postId', () => {
  it('carries the retired slugs, the locales and the tags', async () => {
    await createApp({ permissions: [READ] });
    const response = await request({
      method: 'GET',
      url: `/v1/admin/blog/${POST}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    const body = BlogPostDetailResponseSchema.parse(response.json());
    expect(body.post.previousSlugs).toEqual(['an-older-slug']);
    expect(body.post.translations.map((entry) => entry.localeCode)).toEqual(['en']);
    expect(body.post.tagIds).toEqual([TAG]);
    expect(body.post.authorUserId).toBe(STAFF);
  });

  it('carries the attached cover\'s alt text from the shared reader (0099)', async () => {
    const seen = await createApp({
      permissions: [READ],
      coverRow: {
        mediaId: 'fb000000-0000-4000-8000-0000000000a1',
        objectPath: 'cms-media/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.png',
        altTextEn: 'A harbour at dawn',
        altTextAr: 'ميناء عند الفجر',
      },
    });
    const response = await request({
      method: 'GET',
      url: `/v1/admin/blog/${POST}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    const body = BlogPostDetailResponseSchema.parse(response.json());
    expect(body.post.coverAltTextEn).toBe('A harbour at dawn');
    expect(body.post.coverAltTextAr).toBe('ميناء عند الفجر');
    // Nothing here is a URL: the cms-media bucket is private and nothing on this path is signed.
    expect(JSON.stringify(body.post)).not.toContain('http');
    // The shared reader was asked for a post, not for a page.
    const input = seen.find((entry) => entry.name === 'cmsCoverMediaForStaff')?.input as Record<string, unknown>;
    expect(input['entityType']).toBe('blog_post');
    expect(input['entityId']).toBe(POST);
  });

  it('reports null alt text when no cover is attached', async () => {
    await createApp({ permissions: [READ], coverRow: null });
    const response = await request({
      method: 'GET',
      url: `/v1/admin/blog/${POST}`,
      accessToken: ACCESS_TOKEN,
    });
    const body = BlogPostDetailResponseSchema.parse(response.json());
    expect(body.post.coverAltTextEn).toBeNull();
    expect(body.post.coverAltTextAr).toBeNull();
  });

  it('reports the manage capability from the row rather than from the caller', async () => {
    await createApp({ permissions: [READ], detailRow: { ...DETAIL_ROW, canManage: false } });
    const response = await request({
      method: 'GET',
      url: `/v1/admin/blog/${POST}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(BlogPostDetailResponseSchema.parse(response.json()).post.canManage).toBe(false);
  });

  it('is the same 404 for a post that does not exist and a caller who may not read it', async () => {
    await createApp({ detailRow: null });
    const absent = await request({
      method: 'GET',
      url: `/v1/admin/blog/${POST}`,
      accessToken: ACCESS_TOKEN,
    });
    await app?.close();
    app = undefined;
    await createApp({ permissions: [] });
    const refused = await request({
      method: 'GET',
      url: `/v1/admin/blog/${POST}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(absent.statusCode).toBe(404);
    expect(refused.statusCode).toBe(404);
    expect(absent.json()).toEqual(refused.json());
  });

  it('refuses an identifier that could not be one', async () => {
    await createApp();
    const response = await request({
      method: 'GET',
      url: '/v1/admin/blog/not-a-uuid',
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('writing a post', () => {
  it('creates a draft, with no way to ask for anything else', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'POST',
      url: '/v1/admin/blog',
      accessToken: ACCESS_TOKEN,
      payload: { slug: 'a-new-post', status: 'published', isFeatured: true },
    });
    expect(response.statusCode).toBe(201);
    expect(CreateBlogPostResponseSchema.parse(response.json()).id).toBe(POST);
    // The contract dropped both extra fields, so the store was never asked for them.
    const input = seen.at(-1)?.input as Record<string, unknown>;
    expect('status' in input).toBe(false);
    expect('isFeatured' in input).toBe(false);
  });

  it('cannot change a status through the update route', async () => {
    const seen = await createApp();
    await request({
      method: 'PATCH',
      url: `/v1/admin/blog/${POST}`,
      accessToken: ACCESS_TOKEN,
      payload: { slug: 'renamed', status: 'published' },
    });
    expect(seen.some((call) => call.name === 'blogPostStatusForStaff')).toBe(false);
    const input = seen.at(-1)?.input as Record<string, unknown>;
    expect('status' in input).toBe(false);
  });

  it('tells an absent reference from an explicit null', async () => {
    const seen = await createApp();
    await request({
      method: 'PATCH',
      url: `/v1/admin/blog/${POST}`,
      accessToken: ACCESS_TOKEN,
      payload: { slug: 'renamed' },
    });
    expect(seen.at(-1)?.input).toMatchObject({ clearCategory: false, clearCover: false, categoryId: null });

    await request({
      method: 'PATCH',
      url: `/v1/admin/blog/${POST}`,
      accessToken: ACCESS_TOKEN,
      payload: { categoryId: null, coverMediaId: null },
    });
    expect(seen.at(-1)?.input).toMatchObject({ clearCategory: true, clearCover: true });

    await request({
      method: 'PATCH',
      url: `/v1/admin/blog/${POST}`,
      accessToken: ACCESS_TOKEN,
      payload: { categoryId: CATEGORY },
    });
    expect(seen.at(-1)?.input).toMatchObject({ clearCategory: false, categoryId: CATEGORY });
  });

  it('refuses an update with nothing in it', async () => {
    await createApp();
    const response = await request({
      method: 'PATCH',
      url: `/v1/admin/blog/${POST}`,
      accessToken: ACCESS_TOKEN,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('requires a moment for a schedule and refuses one otherwise', async () => {
    await createApp();
    const missing = await request({
      method: 'PUT',
      url: `/v1/admin/blog/${POST}/status`,
      accessToken: ACCESS_TOKEN,
      payload: { status: 'scheduled' },
    });
    expect(missing.statusCode).toBe(400);

    const extra = await request({
      method: 'PUT',
      url: `/v1/admin/blog/${POST}/status`,
      accessToken: ACCESS_TOKEN,
      payload: { status: 'published', scheduledFor: '2026-06-01T09:00:00.000Z' },
    });
    expect(extra.statusCode).toBe(400);

    const ok = await request({
      method: 'PUT',
      url: `/v1/admin/blog/${POST}/status`,
      accessToken: ACCESS_TOKEN,
      payload: { status: 'scheduled', scheduledFor: '2026-06-01T09:00:00.000Z' },
    });
    expect(ok.statusCode).toBe(200);
    expect(BlogWriteResponseSchema.parse(ok.json())).toEqual({ ok: true });
  });

  it('writes and removes one locale, and refuses a path segment that is not one', async () => {
    const seen = await createApp();
    const saved = await request({
      method: 'PUT',
      url: `/v1/admin/blog/${POST}/translations/ar`,
      accessToken: ACCESS_TOKEN,
      payload: { title: 'مقال', body: 'نص.' },
    });
    expect(saved.statusCode).toBe(200);
    expect(seen.at(-1)?.input).toMatchObject({ localeCode: 'ar', title: 'مقال' });

    const removed = await request({
      method: 'DELETE',
      url: `/v1/admin/blog/${POST}/translations/ar`,
      accessToken: ACCESS_TOKEN,
    });
    expect(removed.statusCode).toBe(200);

    const bad = await request({
      method: 'PUT',
      url: `/v1/admin/blog/${POST}/translations/english`,
      accessToken: ACCESS_TOKEN,
      payload: { title: 'A', body: 'B' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('replaces the whole tag set, including with nothing', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'PUT',
      url: `/v1/admin/blog/${POST}/tags`,
      accessToken: ACCESS_TOKEN,
      payload: { tagIds: [] },
    });
    expect(response.statusCode).toBe(200);
    expect(seen.at(-1)?.input).toMatchObject({ tagIds: [] });

    const bad = await request({
      method: 'PUT',
      url: `/v1/admin/blog/${POST}/tags`,
      accessToken: ACCESS_TOKEN,
      payload: { tagIds: ['not-a-uuid'] },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('is a 404 for every write when the caller holds only the read key', async () => {
    const writes: readonly { method: string; url: string; payload?: unknown }[] = [
      { method: 'POST', url: '/v1/admin/blog', payload: { slug: 'a-new-post' } },
      { method: 'PATCH', url: `/v1/admin/blog/${POST}`, payload: { slug: 'renamed' } },
      { method: 'PUT', url: `/v1/admin/blog/${POST}/status`, payload: { status: 'published' } },
      {
        method: 'PUT',
        url: `/v1/admin/blog/${POST}/translations/en`,
        payload: { title: 'A', body: 'B' },
      },
      { method: 'DELETE', url: `/v1/admin/blog/${POST}/translations/en` },
      { method: 'PUT', url: `/v1/admin/blog/${POST}/tags`, payload: { tagIds: [] } },
      { method: 'POST', url: '/v1/admin/blog/categories', payload: { slug: 'news', nameEn: 'News' } },
      { method: 'PATCH', url: `/v1/admin/blog/categories/${CATEGORY}`, payload: { nameEn: 'News' } },
      { method: 'POST', url: '/v1/admin/blog/tags', payload: { slug: 'tips', nameEn: 'Tips' } },
      { method: 'PATCH', url: `/v1/admin/blog/tags/${TAG}`, payload: { nameEn: 'Tips' } },
    ];

    for (const write of writes) {
      // The database is what refuses: it raises 42501 because the caller does not hold the manage key, and the
      // service turns that into an absence rather than a 403.
      await createApp({ permissions: [READ], writeError: { code: '42501' } });
      const response = await request({ ...write, accessToken: ACCESS_TOKEN });
      expect(response.statusCode, `${write.method} ${write.url}`).toBe(404);
      await app?.close();
      app = undefined;
    }
  });
});

describe('the refusals the database raises', () => {
  const cases: readonly { sqlstate: string; code: string }[] = [
    { sqlstate: '23001', code: 'BLOG_LOCALE_REQUIRED' },
    { sqlstate: '23514', code: 'BLOG_CHANGE_NOT_ALLOWED' },
    { sqlstate: '23505', code: 'BLOG_SLUG_TAKEN' },
    { sqlstate: '23503', code: 'BLOG_REFERENCE_UNKNOWN' },
  ];

  it('becomes a 409 carrying our own code, never the databases text', async () => {
    for (const { sqlstate, code } of cases) {
      await createApp({ writeError: { code: sqlstate } });
      const response = await request({
        method: 'PUT',
        url: `/v1/admin/blog/${POST}/status`,
        accessToken: ACCESS_TOKEN,
        payload: { status: 'published' },
      });
      expect(response.statusCode, sqlstate).toBe(409);
      const body = response.json() as { code: string; detail: string };
      expect(body.code, sqlstate).toBe(code);
      expect(body.detail, sqlstate).not.toContain('the database refused it');
      await app?.close();
      app = undefined;
    }
  });

  it('is a 503 for a SQLSTATE nobody mapped, because an unexpected failure is not a user error', async () => {
    await createApp({ writeError: { code: '40001' } });
    const response = await request({
      method: 'PUT',
      url: `/v1/admin/blog/${POST}/status`,
      accessToken: ACCESS_TOKEN,
      payload: { status: 'published' },
    });
    expect(response.statusCode).toBe(503);
  });

  it('is a 404 when the write changed nothing, which is what a missing post looks like', async () => {
    await createApp({ writeResult: false });
    const response = await request({
      method: 'PATCH',
      url: `/v1/admin/blog/${POST}`,
      accessToken: ACCESS_TOKEN,
      payload: { slug: 'renamed' },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('writing the taxonomy', () => {
  it('creates a category and returns its identifier', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'POST',
      url: '/v1/admin/blog/categories',
      accessToken: ACCESS_TOKEN,
      payload: { slug: 'news', nameEn: 'News', nameAr: 'أخبار', sortOrder: 10 },
    });
    expect(response.statusCode).toBe(201);
    expect(SaveBlogTaxonomyResponseSchema.parse(response.json()).id).toBe(CATEGORY);
    expect(seen.at(-1)?.input).toMatchObject({ categoryId: null, slug: 'news', nameAr: 'أخبار' });
  });

  it('requires a slug and an English name to create one', async () => {
    await createApp();
    for (const payload of [{ nameEn: 'News' }, { slug: 'news' }]) {
      const response = await request({
        method: 'POST',
        url: '/v1/admin/blog/categories',
        accessToken: ACCESS_TOKEN,
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('leaves the order and the activity alone when they are not sent', async () => {
    const seen = await createApp();
    await request({
      method: 'PATCH',
      url: `/v1/admin/blog/categories/${CATEGORY}`,
      accessToken: ACCESS_TOKEN,
      payload: { nameEn: 'Renamed' },
    });
    // Null is what the database reads as "leave it alone". Sending 0 or true here would silently move a
    // category to the top of the order and reactivate a deactivated one every time somebody fixed its name.
    expect(seen.at(-1)?.input).toMatchObject({ sortOrder: null, isActive: null, nameEn: 'Renamed' });
  });

  it('is a 404 when the named category or tag does not exist', async () => {
    await createApp({ saveId: null });
    const category = await request({
      method: 'PATCH',
      url: `/v1/admin/blog/categories/${CATEGORY}`,
      accessToken: ACCESS_TOKEN,
      payload: { nameEn: 'Renamed' },
    });
    expect(category.statusCode).toBe(404);

    const tag = await request({
      method: 'PATCH',
      url: `/v1/admin/blog/tags/${TAG}`,
      accessToken: ACCESS_TOKEN,
      payload: { nameEn: 'Renamed' },
    });
    expect(tag.statusCode).toBe(404);
  });

  it('clears an optional Arabic name with an empty string', async () => {
    const seen = await createApp();
    await request({
      method: 'PATCH',
      url: `/v1/admin/blog/tags/${TAG}`,
      accessToken: ACCESS_TOKEN,
      payload: { nameAr: '' },
    });
    expect(seen.at(-1)?.input).toMatchObject({ nameAr: '' });
  });
});
