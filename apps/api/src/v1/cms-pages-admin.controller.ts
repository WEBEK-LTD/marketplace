import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import {
  CMS_PAGES_DEFAULT_LIMIT,
  CMS_PAGES_MAX_LIMIT,
  CmsPageStatusRequestSchema,
  CreateCmsPageRequestSchema,
  SESSION_TOKEN_HEADER,
  SaveCmsPageTranslationRequestSchema,
  UpdateCmsPageRequestSchema,
  type CmsPageDetailResponse,
  type CmsPagePageResponse,
  type CmsPageStatusRequest,
  type CmsPageWriteResponse,
  type CreateCmsPageRequest,
  type CreateCmsPageResponse,
  type SaveCmsPageTranslationRequest,
  type UpdateCmsPageRequest,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { CmsPagesAdminService } from '../admin/cms-pages.service.js';
import { RequestValidationException } from '../common/request-validation.exception.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface CmsRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(request: CmsRequestContext, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The locale codes the platform seeds. A code outside this set names no locale and cannot be written. */
const LOCALE_PATTERN = /^[a-z]{2}$/;

/**
 * Authoring CMS static pages.
 *
 * **Two keys, and the split between them is the shape of this controller.** Every `@Get` needs `cms.page.read`;
 * every write needs `cms.page.manage`. Both are seeded by 0033 and held by Admin and Super Admin only, and both
 * roles require MFA, so a staff session at `aal1` reaches nothing here. The caller's account and assurance
 * level come from their own session, resolved inside the service through `StaffConsoleService.forToken` and
 * then `isAal2` on that same now-validated token, in that order. No route takes an actor, a role, a permission
 * key or an assurance level.
 *
 * **The lifecycle has its own route, and that is deliberate.** `PATCH /:pageId` changes a page's address,
 * template, order and indexability and *cannot* change its status; `PUT /:pageId/status` is the only way to
 * publish, schedule, archive or unpublish. A single endpoint accepting both would mean a console that meant to
 * fix a typo in a slug could publish a half-written page by sending one extra field.
 *
 * **The controller decides nothing.** The slug and page-key formats, the template set, the four states, which
 * transitions exist, that a previous slug is permanent, that a page cannot be published before it is written and
 * that a live page cannot lose its last locale are all decided in the database. The shapes checked here — a
 * uuid, a two-letter locale, a limit — exist so that something which cannot be an identifier never reaches a
 * parameter binding, never to re-decide a rule.
 */
@Controller('v1/admin/cms/pages')
export class CmsPagesAdminController {
  constructor(private readonly pages: CmsPagesAdminService) {}

  /** One page of authored pages, newest edit first. */
  @Get()
  async list(
    @Req() request: CmsRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('status') status?: string,
  ): Promise<CmsPagePageResponse> {
    const page = await this.pages.list({
      accessToken: this.token(request),
      limit: this.limit(limit),
      // Passed through as text. The database compares it as a parameter, so an unknown value matches nothing
      // rather than being refused, and a stale filter in a bookmark shows an empty page instead of an error.
      status: this.optional(status),
      cursor: this.optional(cursor),
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  /** One page, with its previous slugs and every locale it has. */
  @Get(':pageId')
  async detail(
    @Req() request: CmsRequestContext,
    @Param('pageId') pageId: string,
  ): Promise<CmsPageDetailResponse> {
    const page = await this.pages.detail({
      accessToken: this.token(request),
      pageId: this.identifier(pageId, 'pageId'),
    });
    return { page };
  }

  /** Creates a draft. */
  @Post()
  @HttpCode(201)
  async create(
    @Req() request: CmsRequestContext,
    @Body(new ZodValidationPipe(CreateCmsPageRequestSchema)) body: CreateCmsPageRequest,
  ): Promise<CreateCmsPageResponse> {
    const id = await this.pages.create({
      accessToken: this.token(request),
      slug: body.slug,
      pageKey: body.pageKey ?? null,
      // The defaults are the column defaults, restated so the request stays small rather than so this
      // controller decides them.
      template: body.template ?? 'standard',
      sortOrder: body.sortOrder ?? 0,
      isIndexable: body.isIndexable ?? true,
    });
    return { id };
  }

  /**
   * Changes a page's address or presentation.
   *
   * An absent field changes nothing, which is why every argument below distinguishes "absent" from null: for
   * `pageKey`, absent means leave it and an empty string means clear it, and collapsing the two would make a
   * key impossible to remove.
   */
  @Patch(':pageId')
  async update(
    @Req() request: CmsRequestContext,
    @Param('pageId') pageId: string,
    @Body(new ZodValidationPipe(UpdateCmsPageRequestSchema)) body: UpdateCmsPageRequest,
  ): Promise<CmsPageWriteResponse> {
    await this.pages.update({
      accessToken: this.token(request),
      pageId: this.identifier(pageId, 'pageId'),
      slug: body.slug ?? null,
      pageKey: body.pageKey === undefined ? null : (body.pageKey ?? ''),
      template: body.template ?? null,
      sortOrder: body.sortOrder ?? null,
      isIndexable: body.isIndexable ?? null,
    });
    return { ok: true };
  }

  /** Moves a page through the lifecycle. The only route that can publish one. */
  @Put(':pageId/status')
  async setStatus(
    @Req() request: CmsRequestContext,
    @Param('pageId') pageId: string,
    @Body(new ZodValidationPipe(CmsPageStatusRequestSchema)) body: CmsPageStatusRequest,
  ): Promise<CmsPageWriteResponse> {
    await this.pages.setStatus({
      accessToken: this.token(request),
      pageId: this.identifier(pageId, 'pageId'),
      status: body.status,
      scheduledFor: body.scheduledFor ?? null,
    });
    return { ok: true };
  }

  /** Writes one locale. Creating and replacing are the same request. */
  @Put(':pageId/translations/:localeCode')
  async saveTranslation(
    @Req() request: CmsRequestContext,
    @Param('pageId') pageId: string,
    @Param('localeCode') localeCode: string,
    @Body(new ZodValidationPipe(SaveCmsPageTranslationRequestSchema)) body: SaveCmsPageTranslationRequest,
  ): Promise<CmsPageWriteResponse> {
    await this.pages.saveTranslation({
      accessToken: this.token(request),
      pageId: this.identifier(pageId, 'pageId'),
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
  @Delete(':pageId/translations/:localeCode')
  async deleteTranslation(
    @Req() request: CmsRequestContext,
    @Param('pageId') pageId: string,
    @Param('localeCode') localeCode: string,
  ): Promise<CmsPageWriteResponse> {
    await this.pages.deleteTranslation({
      accessToken: this.token(request),
      pageId: this.identifier(pageId, 'pageId'),
      localeCode: this.locale(localeCode),
    });
    return { ok: true };
  }

  /* ---------------------------------------------------------------------------------------------- */

  /** The caller's own session token. A request without one never reaches a reader. */
  private token(request: CmsRequestContext): string {
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
   * Which codes exist is the `locales` table's business — the translation row carries a foreign key to it, so
   * an unseeded code is refused in the database. This only keeps a path segment that cannot be a locale from
   * reaching a parameter binding.
   */
  private locale(value: string): string {
    if (typeof value !== 'string' || !LOCALE_PATTERN.test(value)) {
      throw new RequestValidationException([{ path: 'localeCode', message: 'The locale is invalid.' }]);
    }
    return value.toLowerCase();
  }

  private limit(raw: string | undefined): number {
    if (raw === undefined || raw === '') return CMS_PAGES_DEFAULT_LIMIT;
    if (!/^\d{1,4}$/.test(raw)) {
      throw new RequestValidationException([{ path: 'limit', message: 'The limit is invalid.' }]);
    }
    const value = Number(raw);
    if (value < 1) {
      throw new RequestValidationException([{ path: 'limit', message: 'The limit is invalid.' }]);
    }
    return Math.min(value, CMS_PAGES_MAX_LIMIT);
  }

  private optional(value: string | undefined): string | null {
    return value === undefined || value === '' ? null : value;
  }
}
