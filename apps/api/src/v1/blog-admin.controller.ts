import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import {
  BLOG_POSTS_DEFAULT_LIMIT,
  BLOG_POSTS_MAX_LIMIT,
  BLOG_SEARCH_MAX,
  BlogPostStatusRequestSchema,
  CreateBlogPostRequestSchema,
  SESSION_TOKEN_HEADER,
  SaveBlogCategoryRequestSchema,
  SaveBlogPostTagsRequestSchema,
  SaveBlogPostTranslationRequestSchema,
  SaveBlogTagRequestSchema,
  UpdateBlogPostRequestSchema,
  type BlogPostDetailResponse,
  type BlogPostPageResponse,
  type BlogPostStatusRequest,
  type BlogTaxonomyResponse,
  type BlogWriteResponse,
  type CreateBlogPostRequest,
  type CreateBlogPostResponse,
  type SaveBlogCategoryRequest,
  type SaveBlogPostTagsRequest,
  type SaveBlogPostTranslationRequest,
  type SaveBlogTagRequest,
  type SaveBlogTaxonomyResponse,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { BlogAdminService } from '../admin/blog.service.js';
import { RequestValidationException } from '../common/request-validation.exception.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface BlogRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(request: BlogRequestContext, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The locale codes the platform seeds. A code outside this set names no locale and cannot be written. */
const LOCALE_PATTERN = /^[a-z]{2}$/;

/**
 * Authoring the blog (0092).
 *
 * **Two keys, and the split between them is the shape of this controller.** Every `@Get` needs `cms.blog.read`;
 * every write needs `cms.blog.manage`. Both are seeded by 0033 and held by Admin and Super Admin only, and both
 * roles require MFA, so a staff session at `aal1` reaches nothing here. The caller's account and assurance level
 * come from their own session, resolved inside the service through `StaffConsoleService.forToken` and then
 * `isAal2` on that same now-validated token, in that order. No route takes an actor, a role, a permission key or
 * an assurance level.
 *
 * **The lifecycle has its own route, and that is deliberate.** `PATCH /:postId` changes a post's address,
 * category, cover, indexability and featured flag and *cannot* change its status; `PUT /:postId/status` is the
 * only way to publish, schedule, archive or unpublish. A single endpoint accepting both would mean a console that
 * meant to fix a typo in a slug could publish a half-written post by sending one extra field.
 *
 * **An explicit null and an absent field mean different things on the update route.** Absent leaves a reference
 * alone; null clears it. The two are carried to the database as a value and a clear flag, because in SQL null
 * already means "unchanged" and one value cannot say both.
 *
 * **`taxonomy` is declared before `:postId`** for the same reason the public controller declares its own first:
 * Nest matches in declaration order, so the parameter route would otherwise shadow it.
 *
 * **The controller decides nothing.** The slug formats, the four states, which transitions exist, that a retired
 * slug is permanent, that only a published post may be featured, that a post cannot be published before it is
 * written and that a live post cannot lose its last locale are all decided in the database. The shapes checked
 * here — a uuid, a two-letter locale, a limit, a search length — exist so that something which cannot be an
 * identifier never reaches a parameter binding, never to re-decide a rule.
 */
@Controller('v1/admin/blog')
export class BlogAdminController {
  constructor(private readonly blog: BlogAdminService) {}

  /** One page of authored posts, newest edit first. */
  @Get()
  async list(
    @Req() request: BlogRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('categoryId') categoryId?: string,
  ): Promise<BlogPostPageResponse> {
    const page = await this.blog.list({
      accessToken: this.token(request),
      limit: this.limit(limit),
      // Passed through as text. The database compares it as a parameter, so an unknown value matches nothing
      // rather than being refused, and a stale filter in a bookmark shows an empty page instead of an error.
      status: this.optional(status),
      search: this.search(search),
      categoryId: categoryId === undefined || categoryId === '' ? null : this.identifier(categoryId, 'categoryId'),
      cursor: this.optional(cursor),
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  /** The categories and tags, active or not, with whether this caller may change them. */
  @Get('taxonomy')
  async taxonomy(@Req() request: BlogRequestContext): Promise<BlogTaxonomyResponse> {
    return await this.blog.taxonomy({ accessToken: this.token(request) });
  }

  /** One post, with its previous slugs, its tags and every locale it has. */
  @Get(':postId')
  async detail(
    @Req() request: BlogRequestContext,
    @Param('postId') postId: string,
  ): Promise<BlogPostDetailResponse> {
    const post = await this.blog.detail({
      accessToken: this.token(request),
      postId: this.identifier(postId, 'postId'),
    });
    return { post };
  }

  /** Creates a draft. */
  @Post()
  @HttpCode(201)
  async create(
    @Req() request: BlogRequestContext,
    @Body(new ZodValidationPipe(CreateBlogPostRequestSchema)) body: CreateBlogPostRequest,
  ): Promise<CreateBlogPostResponse> {
    const id = await this.blog.create({
      accessToken: this.token(request),
      slug: body.slug,
      categoryId: body.categoryId ?? null,
      // The default is the column default, restated so the request stays small rather than so this controller
      // decides it.
      isIndexable: body.isIndexable ?? true,
    });
    return { id };
  }

  /**
   * Changes a post's address or presentation.
   *
   * An absent field changes nothing and an explicit null clears a reference, which is why each one becomes a
   * value *and* a flag below: collapsing the two would make a category impossible to remove.
   */
  @Patch(':postId')
  async update(
    @Req() request: BlogRequestContext,
    @Param('postId') postId: string,
    @Body(new ZodValidationPipe(UpdateBlogPostRequestSchema)) body: Record<string, unknown>,
  ): Promise<BlogWriteResponse> {
    // `in` rather than a truthiness test: the whole point is to tell an absent key from a present null one.
    const categoryGiven = 'categoryId' in body;
    const coverGiven = 'coverMediaId' in body;
    const categoryId = body['categoryId'] as string | null | undefined;
    const coverMediaId = body['coverMediaId'] as string | null | undefined;

    await this.blog.update({
      accessToken: this.token(request),
      postId: this.identifier(postId, 'postId'),
      slug: (body['slug'] as string | undefined) ?? null,
      categoryId: typeof categoryId === 'string' ? categoryId : null,
      clearCategory: categoryGiven && categoryId === null,
      coverMediaId: typeof coverMediaId === 'string' ? coverMediaId : null,
      clearCover: coverGiven && coverMediaId === null,
      isIndexable: (body['isIndexable'] as boolean | undefined) ?? null,
      isFeatured: (body['isFeatured'] as boolean | undefined) ?? null,
    });
    return { ok: true };
  }

  /** Moves a post through the lifecycle. The only route that can publish one. */
  @Put(':postId/status')
  async setStatus(
    @Req() request: BlogRequestContext,
    @Param('postId') postId: string,
    @Body(new ZodValidationPipe(BlogPostStatusRequestSchema)) body: BlogPostStatusRequest,
  ): Promise<BlogWriteResponse> {
    await this.blog.setStatus({
      accessToken: this.token(request),
      postId: this.identifier(postId, 'postId'),
      status: body.status,
      scheduledFor: body.scheduledFor ?? null,
    });
    return { ok: true };
  }

  /** Writes one locale. Creating and replacing are the same request. */
  @Put(':postId/translations/:localeCode')
  async saveTranslation(
    @Req() request: BlogRequestContext,
    @Param('postId') postId: string,
    @Param('localeCode') localeCode: string,
    @Body(new ZodValidationPipe(SaveBlogPostTranslationRequestSchema)) body: SaveBlogPostTranslationRequest,
  ): Promise<BlogWriteResponse> {
    await this.blog.saveTranslation({
      accessToken: this.token(request),
      postId: this.identifier(postId, 'postId'),
      localeCode: this.locale(localeCode),
      title: body.title,
      body: body.body,
      excerpt: body.excerpt ?? null,
      metaTitle: body.metaTitle ?? null,
      metaDescription: body.metaDescription ?? null,
    });
    return { ok: true };
  }

  /** Removes one locale. */
  @Delete(':postId/translations/:localeCode')
  async deleteTranslation(
    @Req() request: BlogRequestContext,
    @Param('postId') postId: string,
    @Param('localeCode') localeCode: string,
  ): Promise<BlogWriteResponse> {
    await this.blog.deleteTranslation({
      accessToken: this.token(request),
      postId: this.identifier(postId, 'postId'),
      localeCode: this.locale(localeCode),
    });
    return { ok: true };
  }

  /** Replaces a post's whole tag set. */
  @Put(':postId/tags')
  async setTags(
    @Req() request: BlogRequestContext,
    @Param('postId') postId: string,
    @Body(new ZodValidationPipe(SaveBlogPostTagsRequestSchema)) body: SaveBlogPostTagsRequest,
  ): Promise<BlogWriteResponse> {
    await this.blog.setTags({
      accessToken: this.token(request),
      postId: this.identifier(postId, 'postId'),
      tagIds: body.tagIds.map((id) => this.identifier(id, 'tagIds')),
    });
    return { ok: true };
  }

  /** Creates one category. */
  @Post('categories')
  @HttpCode(201)
  async createCategory(
    @Req() request: BlogRequestContext,
    @Body(new ZodValidationPipe(SaveBlogCategoryRequestSchema)) body: SaveBlogCategoryRequest,
  ): Promise<SaveBlogTaxonomyResponse> {
    // Creating needs both of these; the database's own not-null constraints would refuse otherwise, and saying
    // so here means the console gets a field-level message instead of a conflict.
    if (body.slug === undefined || body.nameEn === undefined) {
      throw new RequestValidationException([
        { path: body.slug === undefined ? 'slug' : 'nameEn', message: 'The field is required.' },
      ]);
    }
    const id = await this.blog.saveCategory({
      accessToken: this.token(request),
      categoryId: null,
      slug: body.slug,
      nameEn: body.nameEn,
      nameAr: body.nameAr ?? null,
      descriptionEn: body.descriptionEn ?? null,
      descriptionAr: body.descriptionAr ?? null,
      sortOrder: body.sortOrder ?? null,
      isActive: body.isActive ?? null,
    });
    return { id };
  }

  /** Replaces one category. An absent field leaves that part of it alone. */
  @Patch('categories/:categoryId')
  async updateCategory(
    @Req() request: BlogRequestContext,
    @Param('categoryId') categoryId: string,
    @Body(new ZodValidationPipe(SaveBlogCategoryRequestSchema)) body: SaveBlogCategoryRequest,
  ): Promise<SaveBlogTaxonomyResponse> {
    const id = await this.blog.saveCategory({
      accessToken: this.token(request),
      categoryId: this.identifier(categoryId, 'categoryId'),
      slug: body.slug ?? null,
      nameEn: body.nameEn ?? null,
      nameAr: body.nameAr ?? null,
      descriptionEn: body.descriptionEn ?? null,
      descriptionAr: body.descriptionAr ?? null,
      sortOrder: body.sortOrder ?? null,
      isActive: body.isActive ?? null,
    });
    return { id };
  }

  /** Creates one tag. */
  @Post('tags')
  @HttpCode(201)
  async createTag(
    @Req() request: BlogRequestContext,
    @Body(new ZodValidationPipe(SaveBlogTagRequestSchema)) body: SaveBlogTagRequest,
  ): Promise<SaveBlogTaxonomyResponse> {
    if (body.slug === undefined || body.nameEn === undefined) {
      throw new RequestValidationException([
        { path: body.slug === undefined ? 'slug' : 'nameEn', message: 'The field is required.' },
      ]);
    }
    const id = await this.blog.saveTag({
      accessToken: this.token(request),
      tagId: null,
      slug: body.slug,
      nameEn: body.nameEn,
      nameAr: body.nameAr ?? null,
      isActive: body.isActive ?? null,
    });
    return { id };
  }

  /** Replaces one tag. */
  @Patch('tags/:tagId')
  async updateTag(
    @Req() request: BlogRequestContext,
    @Param('tagId') tagId: string,
    @Body(new ZodValidationPipe(SaveBlogTagRequestSchema)) body: SaveBlogTagRequest,
  ): Promise<SaveBlogTaxonomyResponse> {
    const id = await this.blog.saveTag({
      accessToken: this.token(request),
      tagId: this.identifier(tagId, 'tagId'),
      slug: body.slug ?? null,
      nameEn: body.nameEn ?? null,
      nameAr: body.nameAr ?? null,
      isActive: body.isActive ?? null,
    });
    return { id };
  }

  /* ---------------------------------------------------------------------------------------------- */

  /** The caller's own session token. A request without one never reaches a reader. */
  private token(request: BlogRequestContext): string {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    return accessToken;
  }

  private identifier(value: string, path: string): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new RequestValidationException([{ path, message: 'The identifier is invalid.' }]);
    }
    return value.toLowerCase();
  }

  /**
   * A locale code, as a shape.
   *
   * Which codes exist is the `locales` table's business — the translation row carries a foreign key to it, so an
   * unseeded code is refused in the database. This only keeps a path segment that cannot be a locale from
   * reaching a parameter binding.
   */
  private locale(value: string): string {
    if (typeof value !== 'string' || !LOCALE_PATTERN.test(value)) {
      throw new RequestValidationException([{ path: 'localeCode', message: 'The locale is invalid.' }]);
    }
    return value.toLowerCase();
  }

  private limit(raw: string | undefined): number {
    if (raw === undefined || raw === '') return BLOG_POSTS_DEFAULT_LIMIT;
    if (!/^\d{1,4}$/.test(raw)) {
      throw new RequestValidationException([{ path: 'limit', message: 'The limit is invalid.' }]);
    }
    const value = Number(raw);
    if (value < 1) {
      throw new RequestValidationException([{ path: 'limit', message: 'The limit is invalid.' }]);
    }
    return Math.min(value, BLOG_POSTS_MAX_LIMIT);
  }

  /**
   * The search term, bounded.
   *
   * The bound is the only thing checked: the database matches it as a literal substring with `position()`, so
   * there is no pattern syntax to escape and nothing a term can be read as.
   */
  private search(raw: string | undefined): string | null {
    if (raw === undefined || raw.trim() === '') return null;
    if (raw.length > BLOG_SEARCH_MAX) {
      throw new RequestValidationException([{ path: 'search', message: 'The search term is too long.' }]);
    }
    return raw.trim();
  }

  private optional(value: string | undefined): string | null {
    return value === undefined || value === '' ? null : value;
  }
}
