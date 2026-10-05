import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import {
  SELLER_LISTINGS_DEFAULT_LIMIT,
  SESSION_TOKEN_HEADER,
  SellerListingCreateRequestSchema,
  SellerListingUpdateRequestSchema,
  type SellerListingCreateRequest,
  type SellerListingMutationResponse,
  type SellerListingUpdateRequest,
  type SellerListingsResponse,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { SellerListingService } from '../sellers/seller-listing.service.js';
import { CurrentUserService } from '../users/current-user.service.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface SellerListingRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(context: SellerListingRequestContext, name: string): string | null {
  const value = context.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

/**
 * The seller's own listings (Phase 6-F).
 *
 * Five routes, all under `/v1/sellers/me/listings` — the namespace the caller already uses for their own
 * storefront, which is why not one of them takes a seller, an owner or an account. The caller is resolved
 * from their own access token before any body, query string or path segment is used for anything.
 *
 * **Why its own controller.** `SellerIdentityController` owns the profile's read, creation and edit, and
 * `SellerMediaController` owns media; listings are a third resource with their own store and their own limits,
 * and keeping them apart is what leaves the frozen 6-A, 6-C, 6-D and 6-E routes untouched by this increment.
 * Nest mounts all three on `v1/sellers` without any shadowing another: `me/listings` and its children are
 * static prefixes that cannot collide with `me`, with `me/media`, or with the parametric `:slug`.
 *
 * **The methods carry meaning.** 201 for a creation, because a draft that did not exist now does. 200 for the
 * edit, the submission and the archive, because each changes a listing that already existed. Submission and
 * archival are POSTs to their own sub-resources rather than a status field on the PATCH: a status a caller
 * could send would be a status a caller could choose, and neither takes a body at all.
 *
 * There is no DELETE here, and there is none anywhere in this API. A seller archives; nobody deletes.
 */
@Controller('v1/sellers')
export class SellerListingsController {
  constructor(
    private readonly users: CurrentUserService,
    private readonly listings: SellerListingService,
  ) {}

  /** `GET /v1/sellers/me/listings` — one page of the caller's own listings. */
  @Get('me/listings')
  async index(
    @Req() request: SellerListingRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<SellerListingsResponse> {
    const userId = await this.caller(request);
    const size = Number.parseInt(limit ?? '', 10);
    const page = await this.listings.listForUser(
      userId,
      Number.isFinite(size) ? size : SELLER_LISTINGS_DEFAULT_LIMIT,
      cursor === undefined || cursor === '' ? null : cursor,
    );
    return { listings: [...page.listings], nextCursor: page.nextCursor };
  }

  /** `POST /v1/sellers/me/listings` — create one draft. */
  @Post('me/listings')
  @HttpCode(201)
  async create(
    @Req() request: SellerListingRequestContext,
    @Body(new ZodValidationPipe(SellerListingCreateRequestSchema)) body: SellerListingCreateRequest,
  ): Promise<SellerListingMutationResponse> {
    const userId = await this.caller(request);
    return { listing: await this.listings.createDraft(userId, body) };
  }

  /** `PATCH /v1/sellers/me/listings/:slug` — edit one draft. */
  @Patch('me/listings/:slug')
  @HttpCode(200)
  async update(
    @Req() request: SellerListingRequestContext,
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(SellerListingUpdateRequestSchema)) body: SellerListingUpdateRequest,
  ): Promise<SellerListingMutationResponse> {
    const userId = await this.caller(request);
    return { listing: await this.listings.updateDraft(userId, slug, body) };
  }

  /**
   * `POST /v1/sellers/me/listings/:slug/submission` — submit one draft for review.
   *
   * No body, by design. Everything this operation needs is the caller's own identity and the address of one
   * of their own drafts; there is nothing left for a request to say.
   */
  @Post('me/listings/:slug/submission')
  @HttpCode(200)
  async submit(
    @Req() request: SellerListingRequestContext,
    @Param('slug') slug: string,
  ): Promise<SellerListingMutationResponse> {
    const userId = await this.caller(request);
    return { listing: await this.listings.submit(userId, slug) };
  }

  /** `POST /v1/sellers/me/listings/:slug/archive` — withdraw one live listing from sale. No body either. */
  @Post('me/listings/:slug/archive')
  @HttpCode(200)
  async archive(
    @Req() request: SellerListingRequestContext,
    @Param('slug') slug: string,
  ): Promise<SellerListingMutationResponse> {
    const userId = await this.caller(request);
    return { listing: await this.listings.archive(userId, slug) };
  }

  /** The caller, from their own token. No route here accepts an identifier from anywhere else. */
  private async caller(request: SellerListingRequestContext): Promise<string> {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    const user = await this.users.forToken(accessToken);
    return user.id;
  }
}
