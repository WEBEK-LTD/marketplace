import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import {
  CMS_MEDIA_MAX_LIMIT,
  CmsMediaAltTextRequestSchema,
  CmsMediaAttachRequestSchema,
  CmsMediaUploadRequestSchema,
  SESSION_TOKEN_HEADER,
  type CmsMediaAltTextRequest,
  type CmsMediaAttachRequest,
  type CmsMediaAttachResponse,
  type CmsMediaPageResponse,
  type CmsMediaPreviewResponse,
  type CmsMediaUploadRequest,
  type CmsMediaUploadResponse,
  type CmsMediaUsageResponse,
  type CmsMediaWriteResponse,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { CmsMediaAdminService } from '../admin/cms-media.service.js';
import { RequestValidationException } from '../common/request-validation.exception.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface CmsMediaRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(request: CmsMediaRequestContext, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The CMS media library (0098).
 *
 * **One key gates every route here**, read and write alike: `cms.media.manage`, seeded by 0033 and held by Admin and
 * Super Admin only, both of which require MFA, so a staff session at `aal1` reaches nothing. 0033 seeds no
 * `cms.media.read` and none is invented, which is why there is no read-only shape of this surface.
 *
 * **An upload is two requests, because that is what a signed upload is.** `POST /uploads` authorizes one and returns
 * the URL and the path it was issued for; the browser puts the bytes there; `POST /` confirms and the entry exists.
 * 201 for the authorization, because it creates something — a signed, time-limited permission that did not exist
 * before — and 201 for the confirmation, because it creates the library entry.
 *
 * **A client never names a path.** The upload request carries a content type and a size, and the strict contract
 * refuses a path outright; the confirmation sends back the path the database composed, and the database re-checks its
 * whole shape before anything is recorded.
 *
 * **`uploads` and `:mediaId` cannot collide**, because `uploads` is a static segment and is declared first; Nest
 * matches in declaration order and the parametric route would otherwise shadow it.
 *
 * **The controller decides nothing.** Which types and sizes are allowed is the bucket's, the path shape is the
 * database's, and where an entry is used is the database's. The one thing this file owns is refusing an identifier
 * that is not an identifier, before any read.
 *
 * **No public route.** Nothing here serves an image to anybody but a signed-in operator holding the key, and the
 * preview is a short-lived credential issued per request (owner decision 4).
 */
@Controller('v1/admin/cms/media')
export class CmsMediaAdminController {
  constructor(private readonly media: CmsMediaAdminService) {}

  /** One page of the library, newest first. */
  @Get()
  async list(
    @Req() request: CmsMediaRequestContext,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<CmsMediaPageResponse> {
    return await this.media.list({
      accessToken: this.token(request),
      cursor: typeof cursor === 'string' && cursor !== '' ? cursor : null,
      limit: this.limit(limit),
    });
  }

  /** Authorizes one upload. Creates a signed permission and nothing else. */
  @Post('uploads')
  @HttpCode(201)
  async authorize(
    @Req() request: CmsMediaRequestContext,
    @Body(new ZodValidationPipe(CmsMediaUploadRequestSchema)) body: CmsMediaUploadRequest,
  ): Promise<CmsMediaUploadResponse> {
    const upload = await this.media.authorizeUpload({ accessToken: this.token(request), request: body });
    return { upload };
  }

  /** Confirms an upload that happened, and records the entry. */
  @Post()
  @HttpCode(201)
  async confirm(
    @Req() request: CmsMediaRequestContext,
    @Body(new ZodValidationPipe(CmsMediaAttachRequestSchema)) body: CmsMediaAttachRequest,
  ): Promise<CmsMediaAttachResponse> {
    const id = await this.media.confirmUpload({ accessToken: this.token(request), request: body });
    return { id };
  }

  /** Every CMS row that points at one entry. A console reads this before offering a delete. */
  @Get(':mediaId/usage')
  async usage(
    @Req() request: CmsMediaRequestContext,
    @Param('mediaId') mediaId: string,
  ): Promise<CmsMediaUsageResponse> {
    return await this.media.usage({
      accessToken: this.token(request),
      mediaId: this.identifier(mediaId),
    });
  }

  /** A short-lived signed URL for exactly the object one entry stores. */
  @Get(':mediaId/preview')
  async preview(
    @Req() request: CmsMediaRequestContext,
    @Param('mediaId') mediaId: string,
  ): Promise<CmsMediaPreviewResponse> {
    return await this.media.preview({
      accessToken: this.token(request),
      mediaId: this.identifier(mediaId),
    });
  }

  /** Replaces one entry's alt texts. The only editable thing about a stored object. */
  @Put(':mediaId/alt-text')
  async saveAltText(
    @Req() request: CmsMediaRequestContext,
    @Param('mediaId') mediaId: string,
    @Body(new ZodValidationPipe(CmsMediaAltTextRequestSchema)) body: CmsMediaAltTextRequest,
  ): Promise<CmsMediaWriteResponse> {
    await this.media.saveAltText({
      accessToken: this.token(request),
      mediaId: this.identifier(mediaId),
      altTextEn: body.altTextEn ?? null,
      altTextAr: body.altTextAr ?? null,
    });
    return { ok: true };
  }

  /** Removes one entry. Every reference to it becomes null through 0030's own foreign keys. */
  @Delete(':mediaId')
  async remove(
    @Req() request: CmsMediaRequestContext,
    @Param('mediaId') mediaId: string,
  ): Promise<CmsMediaWriteResponse> {
    await this.media.remove({
      accessToken: this.token(request),
      mediaId: this.identifier(mediaId),
    });
    return { ok: true };
  }

  /* ---------------------------------------------------------------------------------------------- */

  /** The caller's own session token. A request without one never reaches a reader. */
  private token(request: CmsMediaRequestContext): string {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    return accessToken;
  }

  private identifier(value: string): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new RequestValidationException([{ path: 'mediaId', message: 'The identifier is invalid.' }]);
    }
    return value.toLowerCase();
  }

  /** A page size, or nothing. Checked rather than coerced, so `''` and `'3x'` name no size. */
  private limit(value: string | undefined): number | null {
    if (value === undefined || value === '') return null;
    if (!/^[1-9][0-9]{0,2}$/.test(value)) {
      throw new RequestValidationException([{ path: 'limit', message: 'The limit is invalid.' }]);
    }
    return Math.min(Number(value), CMS_MEDIA_MAX_LIMIT);
  }
}
