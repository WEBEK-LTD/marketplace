import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import {
  SESSION_TOKEN_HEADER,
  SellerMediaAttachRequestSchema,
  SellerMediaUploadRequestSchema,
  type SellerMediaAttachRequest,
  type SellerMediaAttachResponse,
  type SellerMediaUploadRequest,
  type SellerMediaUploadResponse,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { SellerMediaService } from '../sellers/seller-media.service.js';
import { CurrentUserService } from '../users/current-user.service.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface SellerMediaRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(context: SellerMediaRequestContext, name: string): string | null {
  const value = context.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

/**
 * Seller profile media (Phase 6-E).
 *
 * Two routes, one per half of the approved flow, and both under `/v1/sellers/me/` — the path the caller
 * already uses for their own storefront, which is why neither takes an identifier. The owner is resolved from
 * the caller's own access token before either body is used for anything.
 *
 * **Why this is its own controller.** `SellerIdentityController` owns the read, the creation and the edit of
 * the profile itself; media is a different resource with a different store and a different provider
 * dependency, and keeping them apart means the 6-A, 6-C and 6-D routes are untouched by this increment. Nest
 * mounts both on `v1/sellers` without either shadowing the other: `me/media` and `me/media/uploads` are static
 * paths that cannot collide with `me` or with the parametric `:slug`.
 *
 * 201 for the authorization, because it creates something — a signed, time-limited permission that did not
 * exist before. 200 for the confirmation, because recording where a file went replaces a column and creates
 * nothing.
 */
@Controller('v1/sellers')
export class SellerMediaController {
  constructor(
    private readonly users: CurrentUserService,
    private readonly media: SellerMediaService,
  ) {}

  /** `POST /v1/sellers/me/media/uploads` — authorize one upload. */
  @Post('me/media/uploads')
  @HttpCode(201)
  async authorize(
    @Req() request: SellerMediaRequestContext,
    @Body(new ZodValidationPipe(SellerMediaUploadRequestSchema)) body: SellerMediaUploadRequest,
  ): Promise<SellerMediaUploadResponse> {
    const userId = await this.caller(request);
    return { upload: await this.media.authorizeUpload(userId, body) };
  }

  /** `POST /v1/sellers/me/media` — confirm one upload. */
  @Post('me/media')
  @HttpCode(200)
  async confirm(
    @Req() request: SellerMediaRequestContext,
    @Body(new ZodValidationPipe(SellerMediaAttachRequestSchema)) body: SellerMediaAttachRequest,
  ): Promise<SellerMediaAttachResponse> {
    const userId = await this.caller(request);
    return { media: await this.media.confirmUpload(userId, body) };
  }

  /** The caller, from their own token. No route here accepts an identifier from anywhere else. */
  private async caller(request: SellerMediaRequestContext): Promise<string> {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    const user = await this.users.forToken(accessToken);
    return user.id;
  }
}
