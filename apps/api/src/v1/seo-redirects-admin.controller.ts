import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import {
  CreateSeoRedirectRequestSchema,
  SEO_REDIRECTS_DEFAULT_LIMIT,
  SEO_REDIRECTS_MAX_LIMIT,
  SESSION_TOKEN_HEADER,
  SeoRedirectStateRequestSchema,
  UpdateSeoRedirectRequestSchema,
  type CreateSeoRedirectRequest,
  type CreateSeoRedirectResponse,
  type SeoRedirectDetailResponse,
  type SeoRedirectStateRequest,
  type SeoRedirectWriteResponse,
  type SeoRedirectsResponse,
  type UpdateSeoRedirectRequest,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { SeoRedirectsAdminService } from '../admin/seo-redirects.service.js';
import { RequestValidationException } from '../common/request-validation.exception.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface SeoRedirectRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(request: SeoRedirectRequestContext, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Maintaining the SEO redirect map.
 *
 * **Two keys, and the split between them is the shape of this controller.** Every `@Get` needs
 * `seo.redirect.read`; every write needs `seo.redirect.manage`. Both are seeded by 0033 and held by Admin and
 * Super Admin only, and both roles require MFA, so a staff session at `aal1` reaches nothing here. The caller's
 * account and assurance level come from their own session, resolved inside the service through
 * `StaffConsoleService.forToken` and then `isAal2` on that same now-validated token, in that order. No route takes
 * an actor, a role, a permission key or an assurance level.
 *
 * **Switching an entry on or off has its own route, and that is deliberate.** `PATCH /:redirectId` changes an
 * entry's addresses, status code and note and *cannot* change whether it is active; `PUT /:redirectId/state` is
 * the only way to do that. A single endpoint accepting both would mean an operator fixing a typo in a destination
 * could switch a redirect on by sending one extra field — and a redirect switching itself on is exactly the kind
 * of surprise this map must not produce.
 *
 * **There is a real `DELETE` here**, which is unusual on this console and is the right verb for this row. An
 * authored page is archived rather than deleted because a published address with a history must keep answering; a
 * map entry is an *instruction about* an address, and an instruction nobody wants any more has no archived form.
 * The audit trail records the removed row, and switching the entry off is the reversible alternative the console
 * offers first.
 *
 * **The controller decides nothing.** Both path shapes, the prohibition on leaving the site, the four status
 * codes, the refusal of an entry that points at itself and the uniqueness of an address are all decided in the
 * database. The shapes checked here — a uuid, a limit, a boolean — exist so that something which cannot be an
 * identifier never reaches a parameter binding, never to re-decide a rule.
 */
@Controller('v1/admin/seo/redirects')
export class SeoRedirectsAdminController {
  constructor(private readonly redirects: SeoRedirectsAdminService) {}

  /** One page of the map, newest edit first. */
  @Get()
  async list(
    @Req() request: SeoRedirectRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('search') search?: string,
    @Query('active') active?: string,
  ): Promise<SeoRedirectsResponse> {
    const page = await this.redirects.list({
      accessToken: this.token(request),
      limit: this.limit(limit),
      // Passed through as text. The database matches it as a literal substring, so there is nothing to escape
      // and no pattern syntax to strip.
      search: this.optional(search),
      isActive: this.tristate(active),
      cursor: this.optional(cursor),
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  /** One entry, with the manage capability and where its chain ends. */
  @Get(':redirectId')
  async detail(
    @Req() request: SeoRedirectRequestContext,
    @Param('redirectId') redirectId: string,
  ): Promise<SeoRedirectDetailResponse> {
    const redirect = await this.redirects.detail({
      accessToken: this.token(request),
      redirectId: this.identifier(redirectId),
    });
    return { redirect };
  }

  /** Adds an entry. */
  @Post()
  @HttpCode(201)
  async create(
    @Req() request: SeoRedirectRequestContext,
    @Body(new ZodValidationPipe(CreateSeoRedirectRequestSchema)) body: CreateSeoRedirectRequest,
  ): Promise<CreateSeoRedirectResponse> {
    const id = await this.redirects.create({
      accessToken: this.token(request),
      fromPath: body.fromPath,
      toPath: body.toPath,
      // The defaults are the column defaults, restated so the request stays small rather than so this controller
      // decides them.
      statusCode: body.statusCode ?? 301,
      note: body.note ?? null,
      isActive: body.isActive ?? true,
    });
    return { id };
  }

  /**
   * Changes an entry's addresses, status code or note.
   *
   * An absent field changes nothing, which is why every argument below distinguishes "absent" from null: for
   * `note`, absent means leave it and an empty string means clear it, and collapsing the two would make a note
   * impossible to remove.
   */
  @Patch(':redirectId')
  async update(
    @Req() request: SeoRedirectRequestContext,
    @Param('redirectId') redirectId: string,
    @Body(new ZodValidationPipe(UpdateSeoRedirectRequestSchema)) body: UpdateSeoRedirectRequest,
  ): Promise<SeoRedirectWriteResponse> {
    await this.redirects.update({
      accessToken: this.token(request),
      redirectId: this.identifier(redirectId),
      fromPath: body.fromPath ?? null,
      toPath: body.toPath ?? null,
      statusCode: body.statusCode ?? null,
      note: body.note === undefined ? null : body.note,
    });
    return { ok: true };
  }

  /** Switches an entry on or off. The only route that can. */
  @Put(':redirectId/state')
  async setState(
    @Req() request: SeoRedirectRequestContext,
    @Param('redirectId') redirectId: string,
    @Body(new ZodValidationPipe(SeoRedirectStateRequestSchema)) body: SeoRedirectStateRequest,
  ): Promise<SeoRedirectWriteResponse> {
    await this.redirects.setState({
      accessToken: this.token(request),
      redirectId: this.identifier(redirectId),
      isActive: body.isActive,
    });
    return { ok: true };
  }

  /** Removes an entry. */
  @Delete(':redirectId')
  async remove(
    @Req() request: SeoRedirectRequestContext,
    @Param('redirectId') redirectId: string,
  ): Promise<SeoRedirectWriteResponse> {
    await this.redirects.remove({
      accessToken: this.token(request),
      redirectId: this.identifier(redirectId),
    });
    return { ok: true };
  }

  /* ---------------------------------------------------------------------------------------------- */

  /** The caller's own session token. A request without one never reaches a reader. */
  private token(request: SeoRedirectRequestContext): string {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    return accessToken;
  }

  private identifier(value: string): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new RequestValidationException([{ path: 'redirectId', message: 'The identifier is invalid.' }]);
    }
    return value.toLowerCase();
  }

  private limit(raw: string | undefined): number {
    if (raw === undefined || raw === '') return SEO_REDIRECTS_DEFAULT_LIMIT;
    if (!/^\d{1,4}$/.test(raw)) {
      throw new RequestValidationException([{ path: 'limit', message: 'The limit is invalid.' }]);
    }
    const value = Number(raw);
    if (value < 1) {
      throw new RequestValidationException([{ path: 'limit', message: 'The limit is invalid.' }]);
    }
    return Math.min(value, SEO_REDIRECTS_MAX_LIMIT);
  }

  /**
   * The state filter: on, off, or both.
   *
   * Absent is "both", which is what an unfiltered list means. Anything that is not one of the two words is
   * refused rather than quietly read as false — `active=0` meaning "only the inactive ones" would be a guess, and
   * the honest answer to a filter nobody defined is that the request is malformed.
   */
  private tristate(raw: string | undefined): boolean | null {
    if (raw === undefined || raw === '') return null;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new RequestValidationException([{ path: 'active', message: 'The filter is invalid.' }]);
  }

  private optional(value: string | undefined): string | null {
    return value === undefined || value === '' ? null : value;
  }
}
