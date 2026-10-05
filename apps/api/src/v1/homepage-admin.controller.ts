import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Req } from '@nestjs/common';
import {
  CreateHomepageSectionRequestSchema,
  HomepageSectionStateRequestSchema,
  ReorderHomepageSectionsRequestSchema,
  SESSION_TOKEN_HEADER,
  UpdateHomepageSectionRequestSchema,
  type CreateHomepageSectionRequest,
  type CreateHomepageSectionResponse,
  type HomepageSectionDetailResponse,
  type HomepageSectionStateRequest,
  type HomepageSectionsResponse,
  type HomepageWriteResponse,
  type ReorderHomepageSectionsRequest,
  type UpdateHomepageSectionRequest,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { HomepageAdminService } from '../admin/homepage.service.js';
import { RequestValidationException } from '../common/request-validation.exception.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface HomepageRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(request: HomepageRequestContext, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Composing the homepage (0093).
 *
 * **Two keys, and the split between them is the shape of this controller.** Every `@Get` needs
 * `cms.homepage.read`; every write needs `cms.homepage.manage`. Both are seeded by 0033 and held by Admin and
 * Super Admin only, and both roles require MFA, so a staff session at `aal1` reaches nothing here.
 *
 * **Showing a section has its own route, and that is deliberate.** `PATCH /:sectionId` changes a section's key,
 * type, text, configuration and position and *cannot* change its visibility; `PUT /:sectionId/state` is the only
 * way to put one in front of the public. A single endpoint accepting both would mean a console that meant to fix
 * a typo could publish a half-configured section by sending one extra field.
 *
 * **`reorder` is declared before `:sectionId`** because Nest matches in declaration order and the parameter route
 * would otherwise shadow it.
 *
 * **The controller decides nothing.** The key format, the legal types, that `config` is an object and the title
 * lengths are the database's; whether a configuration matches its type is the contract's, checked by the pipe
 * before this code runs.
 */
@Controller('v1/admin/homepage/sections')
export class HomepageAdminController {
  constructor(private readonly homepage: HomepageAdminService) {}

  /** Every section in the homepage's own order. */
  @Get()
  async list(@Req() request: HomepageRequestContext): Promise<HomepageSectionsResponse> {
    return await this.homepage.list({ accessToken: this.token(request) });
  }

  /** Sets the order of the sections named, in one request. */
  @Put('reorder')
  async reorder(
    @Req() request: HomepageRequestContext,
    @Body(new ZodValidationPipe(ReorderHomepageSectionsRequestSchema)) body: ReorderHomepageSectionsRequest,
  ): Promise<HomepageWriteResponse> {
    await this.homepage.reorder({
      accessToken: this.token(request),
      sectionIds: body.sectionIds.map((id) => this.identifier(id, 'sectionIds')),
    });
    return { ok: true };
  }

  /** One section, with how much of its content is still renderable. */
  @Get(':sectionId')
  async detail(
    @Req() request: HomepageRequestContext,
    @Param('sectionId') sectionId: string,
  ): Promise<HomepageSectionDetailResponse> {
    const section = await this.homepage.detail({
      accessToken: this.token(request),
      sectionId: this.identifier(sectionId, 'sectionId'),
    });
    return { section };
  }

  /** Creates a hidden section. */
  @Post()
  @HttpCode(201)
  async create(
    @Req() request: HomepageRequestContext,
    @Body(new ZodValidationPipe(CreateHomepageSectionRequestSchema)) body: CreateHomepageSectionRequest,
  ): Promise<CreateHomepageSectionResponse> {
    const id = await this.homepage.create({
      accessToken: this.token(request),
      sectionKey: body.sectionKey,
      sectionType: body.sectionType,
      titleEn: body.titleEn ?? null,
      titleAr: body.titleAr ?? null,
      subtitleEn: body.subtitleEn ?? null,
      subtitleAr: body.subtitleAr ?? null,
      config: body.config,
      sortOrder: body.sortOrder ?? null,
    });
    return { id };
  }

  /**
   * Changes a section.
   *
   * An absent field changes nothing, which is why every argument below distinguishes "absent" from null: for a
   * title, absent means leave it and null means clear it, and collapsing the two would make a title impossible to
   * remove.
   */
  @Patch(':sectionId')
  async update(
    @Req() request: HomepageRequestContext,
    @Param('sectionId') sectionId: string,
    @Body(new ZodValidationPipe(UpdateHomepageSectionRequestSchema)) body: UpdateHomepageSectionRequest,
  ): Promise<HomepageWriteResponse> {
    await this.homepage.update({
      accessToken: this.token(request),
      sectionId: this.identifier(sectionId, 'sectionId'),
      sectionKey: body.sectionKey ?? null,
      sectionType: body.sectionType ?? null,
      // A title sent as null clears it; the database reads an empty string as a clear and null as "unchanged",
      // so the two are translated here rather than two layers down.
      titleEn: 'titleEn' in body ? (body.titleEn ?? '') : null,
      titleAr: 'titleAr' in body ? (body.titleAr ?? '') : null,
      subtitleEn: 'subtitleEn' in body ? (body.subtitleEn ?? '') : null,
      subtitleAr: 'subtitleAr' in body ? (body.subtitleAr ?? '') : null,
      config: 'config' in body ? body.config : null,
      sortOrder: body.sortOrder ?? null,
    });
    return { ok: true };
  }

  /** Shows or hides one section. The only route that can put one in front of the public. */
  @Put(':sectionId/state')
  async setState(
    @Req() request: HomepageRequestContext,
    @Param('sectionId') sectionId: string,
    @Body(new ZodValidationPipe(HomepageSectionStateRequestSchema)) body: HomepageSectionStateRequest,
  ): Promise<HomepageWriteResponse> {
    await this.homepage.setState({
      accessToken: this.token(request),
      sectionId: this.identifier(sectionId, 'sectionId'),
      isActive: body.isActive,
    });
    return { ok: true };
  }

  /** Removes one section. */
  @Delete(':sectionId')
  async remove(
    @Req() request: HomepageRequestContext,
    @Param('sectionId') sectionId: string,
  ): Promise<HomepageWriteResponse> {
    await this.homepage.remove({
      accessToken: this.token(request),
      sectionId: this.identifier(sectionId, 'sectionId'),
    });
    return { ok: true };
  }

  /* ---------------------------------------------------------------------------------------------- */

  /** The caller's own session token. A request without one never reaches a reader. */
  private token(request: HomepageRequestContext): string {
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
}
