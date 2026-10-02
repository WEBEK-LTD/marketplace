import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import {
  SELLER_SERVICES_DEFAULT_LIMIT,
  SESSION_TOKEN_HEADER,
  SellerServiceCreateRequestSchema,
  SellerServiceUpdateRequestSchema,
  type SellerListingMutationResponse,
  type SellerServiceCreateRequest,
  type SellerServiceUpdateRequest,
  type SellerServicesResponse,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { SellerServiceService } from '../sellers/seller-service.service.js';
import { CurrentUserService } from '../users/current-user.service.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface SellerServiceRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(context: SellerServiceRequestContext, name: string): string | null {
  const value = context.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

/**
 * The seller's own services (Phase 6-G).
 *
 * Three routes under `/v1/sellers/me/services` — the namespace the caller already uses for their own
 * storefront, which is why none of them takes a seller, an owner or an account. The caller is resolved from
 * their own access token before any body, query string or path segment is used for anything.
 *
 * **Three, not five.** There is no submission route and no archive route here, because a service is a
 * listing: `POST /v1/sellers/me/listings/{slug}/submission` and `.../archive` already move it, and the
 * submitter is already service-aware — 0048's exemption for a service priced per engagement is checked
 * inside it. A second pair of routes would be a second copy of the state machine, and the seller services
 * surface calls 6-F's instead.
 *
 * **Why its own controller.** `SellerIdentityController` owns the profile, `SellerMediaController` the media
 * and `SellerListingsController` the listings; services are a fourth resource with their own store, and
 * keeping them apart is what leaves the frozen 6-A, 6-C, 6-D, 6-E and 6-F routes untouched by this
 * increment. Nest mounts all four on `v1/sellers` without any shadowing another: `me/services` is a static
 * prefix that cannot collide with `me`, `me/media`, `me/listings`, or the parametric `:slug`.
 *
 * 201 for the creation, because a draft that did not exist now does. 200 for the edit. There is no DELETE
 * here and none anywhere in this API: a seller archives, and nobody deletes.
 */
@Controller('v1/sellers')
export class SellerServicesController {
  constructor(
    private readonly users: CurrentUserService,
    private readonly services: SellerServiceService,
  ) {}

  /** `GET /v1/sellers/me/services` — one page of the caller's own services. */
  @Get('me/services')
  async index(
    @Req() request: SellerServiceRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<SellerServicesResponse> {
    const userId = await this.caller(request);
    const size = Number.parseInt(limit ?? '', 10);
    const page = await this.services.listForUser(
      userId,
      Number.isFinite(size) ? size : SELLER_SERVICES_DEFAULT_LIMIT,
      cursor === undefined || cursor === '' ? null : cursor,
    );
    return { services: [...page.services], nextCursor: page.nextCursor };
  }

  /** `POST /v1/sellers/me/services` — create one service draft. */
  @Post('me/services')
  @HttpCode(201)
  async create(
    @Req() request: SellerServiceRequestContext,
    @Body(new ZodValidationPipe(SellerServiceCreateRequestSchema)) body: SellerServiceCreateRequest,
  ): Promise<SellerListingMutationResponse> {
    const userId = await this.caller(request);
    return { listing: await this.services.createDraft(userId, body) };
  }

  /** `PATCH /v1/sellers/me/services/:slug` — edit one service draft. */
  @Patch('me/services/:slug')
  @HttpCode(200)
  async update(
    @Req() request: SellerServiceRequestContext,
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(SellerServiceUpdateRequestSchema)) body: SellerServiceUpdateRequest,
  ): Promise<SellerListingMutationResponse> {
    const userId = await this.caller(request);
    return { listing: await this.services.updateDraft(userId, slug, body) };
  }

  /** The caller, from their own token. No route here accepts an identifier from anywhere else. */
  private async caller(request: SellerServiceRequestContext): Promise<string> {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    const user = await this.users.forToken(accessToken);
    return user.id;
  }
}
