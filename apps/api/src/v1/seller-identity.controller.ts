import { Body, Controller, Get, HttpCode, Patch, Post, Req } from '@nestjs/common';
import {
  SESSION_TOKEN_HEADER,
  SellerOnboardingRequestSchema,
  SellerProfileUpdateRequestSchema,
  type SellerIdentityResponse,
  type SellerOnboardingRequest,
  type SellerOnboardingResponse,
  type SellerProfileUpdateRequest,
  type SellerProfileUpdateResponse,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { SellerIdentityService } from '../sellers/seller-identity.service.js';
import { SellerOnboardingService } from '../sellers/seller-onboarding.service.js';
import { SellerProfileUpdateService } from '../sellers/seller-profile-update.service.js';
import { CurrentUserService } from '../users/current-user.service.js';

/** Fastify's request, reduced to the one thing this route reads. */
interface SellerIdentityRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(context: SellerIdentityRequestContext, name: string): string | null {
  const value = context.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

/**
 * `GET /v1/sellers/me` (Phase 6-A).
 *
 * "What is the state of my own storefront?" It takes no parameter, no query and no body: the account comes
 * from the caller's own access token, resolved the same way `/v1/users/me` resolves it — the provider says
 * whose token it is, then the database says what that account's seller identity is. No seller is ever
 * resolved from a slug here, and there is no field anywhere in this route through which a caller could name
 * a different one.
 *
 * **Why this is its own controller.** `/v1/sellers/{slug}` is frozen, and a static `me` sitting beside a
 * parametric `:slug` is the kind of adjacency that gets reordered by a later edit. Keeping them in separate
 * files means the public route's file is untouched by 6-A, and Fastify's router prefers the static segment
 * regardless of registration order — which a test asserts rather than assumes.
 *
 * An account that is not a seller is a 404, identical to any other not-found. Every seller *status* is
 * reported plainly, though: `pending`, `suspended` and `closed` are the caller's own account state, and a
 * surface that could not see them could not explain itself.
 */
@Controller('v1/sellers')
export class SellerIdentityController {
  constructor(
    private readonly users: CurrentUserService,
    private readonly sellers: SellerIdentityService,
    private readonly onboarding: SellerOnboardingService,
    private readonly updates: SellerProfileUpdateService,
  ) {}

  @Get('me')
  async me(@Req() request: SellerIdentityRequestContext): Promise<SellerIdentityResponse> {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();

    // The caller first, then their storefront. The order is the security property: nothing is read until
    // the provider has said whose session this is.
    const user = await this.users.forToken(accessToken);
    return { seller: await this.sellers.forUser(user.id) };
  }

  /**
   * `POST /v1/sellers/me` — create the caller's own storefront (Phase 6-C).
   *
   * 201, because this is a creation and it happens once: a repeat is a 409 rather than a second row, so
   * there is no idempotent-repeat case that would make 200 the honest answer.
   *
   * The same route path as the read, and deliberately so — it is the same resource, addressed the way the
   * caller already addresses it, which is why nothing here takes an identifier either. The owner is resolved
   * from the caller's own access token before the body is used for anything, and the body's own schema is
   * strict, so `userId`, `status` and `verificationStatus` are refused rather than ignored.
   *
   * The response is the row that committed, not an echo of the request.
   */
  @Post('me')
  @HttpCode(201)
  async create(
    @Req() request: SellerIdentityRequestContext,
    @Body(new ZodValidationPipe(SellerOnboardingRequestSchema)) body: SellerOnboardingRequest,
  ): Promise<SellerOnboardingResponse> {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();

    const user = await this.users.forToken(accessToken);
    return { seller: await this.onboarding.createForUser(user.id, body) };
  }

  /**
   * `PATCH /v1/sellers/me` — edit the caller's own storefront (Phase 6-D).
   *
   * PATCH rather than PUT, and the distinction is the contract rather than a preference: a field the body
   * does not mention keeps its value, so this is a partial update by definition. A PUT would mean "here is
   * the whole storefront", which would make an omitted field an instruction to empty it — and would hand a
   * client the job of resending values it may never have been able to read.
   *
   * 200 rather than 201: nothing is created, and the same edit sent twice is the same storefront.
   *
   * The same route path as the read and the creation, because it is the same resource, addressed the way the
   * caller already addresses it — which is why nothing here takes an identifier either. The owner is
   * resolved from the caller's own access token before the body is used for anything, and the body's schema
   * is strict, so `slug`, `userId`, `status` and `verificationStatus` are refused rather than ignored.
   */
  @Patch('me')
  @HttpCode(200)
  async update(
    @Req() request: SellerIdentityRequestContext,
    @Body(new ZodValidationPipe(SellerProfileUpdateRequestSchema)) body: SellerProfileUpdateRequest,
  ): Promise<SellerProfileUpdateResponse> {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();

    const user = await this.users.forToken(accessToken);
    return { seller: await this.updates.updateForUser(user.id, body) };
  }
}
