import { Body, Controller, Delete, Get, Param, Put, Query, Req } from '@nestjs/common';
import {
  SEO_METADATA_DEFAULT_LIMIT,
  SEO_METADATA_MAX_LIMIT,
  SESSION_TOKEN_HEADER,
  SaveSeoMetadataRequestSchema,
  type SaveSeoMetadataRequest,
  type SaveSeoMetadataResponse,
  type SeoMetadataDetailResponse,
  type SeoMetadataEntriesResponse,
  type SeoMetadataWriteResponse,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { SeoMetadataAdminService } from '../admin/seo-metadata.service.js';
import { RequestValidationException } from '../common/request-validation.exception.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface SeoMetadataRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(request: SeoMetadataRequestContext, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Maintaining the per-entity SEO metadata overrides.
 *
 * **Two keys, and the split between them is the shape of this controller.** Every `@Get` needs
 * `seo.metadata.read`; every write needs `seo.metadata.manage`. Both are seeded by 0033 and held by Admin and Super
 * Admin only, and both roles require MFA, so a staff session at `aal1` reaches nothing here. The caller's account
 * and assurance level come from their own session. No route takes an actor, a role, a permission key or an assurance
 * level.
 *
 * **Writing is a `PUT` on the collection, and that is deliberate.** One surface and one locale have one row, and the
 * request *is* that row: creating and replacing are the same operation, so a console never has to find out which it
 * needs before it can save. The corollary is stated in the contract and worth repeating — **an absent field clears
 * the stored value**, because a replace is a replace.
 *
 * **There is a real `DELETE`**, as there is for a redirect and unlike an authored page: an override is an
 * instruction about a surface rather than content with an address, and removing it returns the surface to the
 * metadata it derives from its own content.
 *
 * **The controller decides nothing.** The entity kinds, both path shapes, every length bound, the directive
 * vocabulary and the rule that a set may not contradict itself are all decided in the database; the two owner
 * decisions about what the public reads are applied in the reader. The shapes checked here — a uuid, a limit —
 * exist so that something which cannot be an identifier never reaches a parameter binding.
 */
@Controller('v1/admin/seo/metadata')
export class SeoMetadataAdminController {
  constructor(private readonly metadata: SeoMetadataAdminService) {}

  /** One page of overrides, newest edit first. */
  @Get()
  async list(
    @Req() request: SeoMetadataRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('entityType') entityType?: string,
    @Query('locale') locale?: string,
  ): Promise<SeoMetadataEntriesResponse> {
    const page = await this.metadata.list({
      accessToken: this.token(request),
      limit: this.limit(limit),
      // Passed through as text. The database compares them as parameters, so an unknown value matches nothing
      // rather than being refused, and a stale filter in a bookmark shows an empty page instead of an error.
      entityType: this.optional(entityType),
      locale: this.optional(locale),
      cursor: this.optional(cursor),
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  /** One override, with what the public would actually receive. */
  @Get(':entryId')
  async detail(
    @Req() request: SeoMetadataRequestContext,
    @Param('entryId') entryId: string,
  ): Promise<SeoMetadataDetailResponse> {
    const entry = await this.metadata.detail({
      accessToken: this.token(request),
      entryId: this.identifier(entryId),
    });
    return { entry };
  }

  /** Writes one surface's metadata for one locale. Creating and replacing are the same request. */
  @Put()
  async save(
    @Req() request: SeoMetadataRequestContext,
    @Body(new ZodValidationPipe(SaveSeoMetadataRequestSchema)) body: SaveSeoMetadataRequest,
  ): Promise<SaveSeoMetadataResponse> {
    const id = await this.metadata.save({
      accessToken: this.token(request),
      entityType: body.entityType,
      entityId: body.entityId ?? null,
      routePath: body.routePath ?? null,
      localeCode: body.localeCode,
      // Absent and null are the same thing on this request, because it is a replace: either way the stored value
      // goes. Collapsing them here is honest rather than lossy.
      metaTitle: body.metaTitle ?? null,
      metaDescription: body.metaDescription ?? null,
      canonicalPath: body.canonicalPath ?? null,
      // Absent means 0030's own column default, which the writer applies. Null is not sent, because the column is
      // not nullable.
      robotsDirectives: body.robotsDirectives === undefined ? null : [...body.robotsDirectives],
      ogTitle: body.ogTitle ?? null,
      ogDescription: body.ogDescription ?? null,
      shareMediaId: body.shareMediaId ?? null,
    });
    return { id };
  }

  /** Removes one override. */
  @Delete(':entryId')
  async remove(
    @Req() request: SeoMetadataRequestContext,
    @Param('entryId') entryId: string,
  ): Promise<SeoMetadataWriteResponse> {
    await this.metadata.remove({
      accessToken: this.token(request),
      entryId: this.identifier(entryId),
    });
    return { ok: true };
  }

  /* ---------------------------------------------------------------------------------------------- */

  /** The caller's own session token. A request without one never reaches a reader. */
  private token(request: SeoMetadataRequestContext): string {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    return accessToken;
  }

  private identifier(value: string): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new RequestValidationException([{ path: 'entryId', message: 'The identifier is invalid.' }]);
    }
    return value.toLowerCase();
  }

  private limit(raw: string | undefined): number {
    if (raw === undefined || raw === '') return SEO_METADATA_DEFAULT_LIMIT;
    if (!/^\d{1,4}$/.test(raw)) {
      throw new RequestValidationException([{ path: 'limit', message: 'The limit is invalid.' }]);
    }
    const value = Number(raw);
    if (value < 1) {
      throw new RequestValidationException([{ path: 'limit', message: 'The limit is invalid.' }]);
    }
    return Math.min(value, SEO_METADATA_MAX_LIMIT);
  }

  private optional(value: string | undefined): string | null {
    return value === undefined || value === '' ? null : value;
  }
}
