import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  SESSION_TOKEN_HEADER,
  SellerVerificationDocumentRequestSchema,
  SellerVerificationUploadRequestSchema,
  type SellerVerificationDocumentCountResponse,
  type SellerVerificationDocumentRequest,
  type SellerVerificationResponse,
  type SellerVerificationStateResponse,
  type SellerVerificationUploadRequest,
  type SellerVerificationUploadResponse,
} from '@repo/contracts';
import { z } from 'zod';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { SellerVerificationService } from '../sellers/seller-verification.service.js';
import { CurrentUserService } from '../users/current-user.service.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface SellerVerificationRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(context: SellerVerificationRequestContext, name: string): string | null {
  const value = context.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

/**
 * A document id, validated before it reaches the database.
 *
 * Not because a non-uuid would be dangerous — every call is a bound parameter — but because a malformed id
 * should be a 400 that names the field rather than a 503 from a type cast failing inside a function.
 */
const DocumentIdSchema = z.string().uuid();

/**
 * The seller's own verification submission (Phase 6-I).
 *
 * Five routes under `/v1/sellers/me/verification`, the namespace the caller already uses for their own
 * storefront — which is why not one of them takes a seller, an owner or an account. The caller is resolved
 * from their own access token before any body or path segment is used for anything.
 *
 * **There is no route here that decides a verification**, and there is deliberately no admin surface: no
 * approval, no rejection, no decision reason, no activation, no status change on the storefront. The existing
 * review mechanism remains the sole authority for a decision, and this controller offers a seller no way to
 * reach one — not by a field, not by a status, not by a second call.
 *
 * **Why its own controller.** `SellerIdentityController` owns the profile, `SellerMediaController` the media,
 * `SellerListingsController` the listings and `SellerServicesController` the services; verification is a
 * fifth resource with its own store, and keeping it apart is what leaves the frozen 6-A, 6-C, 6-D, 6-E, 6-F
 * and 6-G routes untouched by this increment. Nest mounts all five on `v1/sellers` without any shadowing
 * another: `me/verification` is a static prefix that cannot collide with `me`, `me/media`, `me/listings`,
 * `me/services` or the parametric `:slug`.
 *
 * 201 where something now exists that did not — the attempt, the authorization, the document record. 200 for
 * the submission, which moves an attempt that already existed, and 200 for the removal, which answers with
 * what is left. The DELETE is the only one in the seller API, and it removes **one document**: never an
 * attempt, which a seller cannot withdraw, and never a storefront or a listing.
 */
@Controller('v1/sellers')
export class SellerVerificationController {
  constructor(
    private readonly users: CurrentUserService,
    private readonly verification: SellerVerificationService,
  ) {}

  /** `GET /v1/sellers/me/verification` — the caller's own attempt, or none. */
  @Get('me/verification')
  async read(
    @Req() request: SellerVerificationRequestContext,
  ): Promise<SellerVerificationResponse> {
    const userId = await this.caller(request);
    return { verification: await this.verification.read(userId) };
  }

  /**
   * `POST /v1/sellers/me/verification` — open one attempt.
   *
   * No body at all: a status the caller could send would be a status the caller could choose.
   */
  @Post('me/verification')
  @HttpCode(201)
  async start(
    @Req() request: SellerVerificationRequestContext,
  ): Promise<SellerVerificationStateResponse> {
    const userId = await this.caller(request);
    return { status: await this.verification.start(userId) };
  }

  /** `POST /v1/sellers/me/verification/documents/uploads` — authorize one document upload. */
  @Post('me/verification/documents/uploads')
  @HttpCode(201)
  async authorizeUpload(
    @Req() request: SellerVerificationRequestContext,
    @Body(new ZodValidationPipe(SellerVerificationUploadRequestSchema))
    body: SellerVerificationUploadRequest,
  ): Promise<SellerVerificationUploadResponse> {
    const userId = await this.caller(request);
    return { upload: await this.verification.authorizeUpload(userId, body) };
  }

  /** `POST /v1/sellers/me/verification/documents` — record one uploaded document. */
  @Post('me/verification/documents')
  @HttpCode(201)
  async recordDocument(
    @Req() request: SellerVerificationRequestContext,
    @Body(new ZodValidationPipe(SellerVerificationDocumentRequestSchema))
    body: SellerVerificationDocumentRequest,
  ): Promise<SellerVerificationDocumentCountResponse> {
    const userId = await this.caller(request);
    return { documentCount: await this.verification.recordDocument(userId, body) };
  }

  /**
   * `DELETE /v1/sellers/me/verification/documents/:documentId` — remove one of the caller's own documents.
   *
   * Permitted only while the attempt is `draft` or `submitted` (owner decision 3), and that window is checked
   * inside the SECURITY DEFINER writer rather than here, so it holds however the request arrives.
   */
  @Delete('me/verification/documents/:documentId')
  @HttpCode(200)
  async removeDocument(
    @Req() request: SellerVerificationRequestContext,
    @Param('documentId', new ZodValidationPipe(DocumentIdSchema)) documentId: string,
  ): Promise<SellerVerificationDocumentCountResponse> {
    const userId = await this.caller(request);
    return { documentCount: await this.verification.removeDocument(userId, documentId) };
  }

  /**
   * `POST /v1/sellers/me/verification/submission` — submit the caller's draft.
   *
   * Its own route rather than a field on anything else, and it takes no body, for the same reason the listing
   * submission does: a status in a request body is a status the caller chose.
   */
  @Post('me/verification/submission')
  @HttpCode(200)
  async submit(
    @Req() request: SellerVerificationRequestContext,
  ): Promise<SellerVerificationStateResponse> {
    const userId = await this.caller(request);
    return { status: await this.verification.submit(userId) };
  }

  /** The caller, from their own token. No route here accepts an identifier from anywhere else. */
  private async caller(request: SellerVerificationRequestContext): Promise<string> {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    const user = await this.users.forToken(accessToken);
    return user.id;
  }
}
