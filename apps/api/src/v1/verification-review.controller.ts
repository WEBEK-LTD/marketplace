import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  SESSION_TOKEN_HEADER,
  VERIFICATION_QUEUE_DEFAULT_LIMIT,
  VERIFICATION_QUEUE_FILTERS,
  VERIFICATION_QUEUE_MAX_LIMIT,
  VerificationDecisionRequestSchema,
  parseMessagingLimit,
  type VerificationDecisionRequest,
  type VerificationDecisionResponse,
  type VerificationDocumentLinkResponse,
  type VerificationQueueFilter,
  type VerificationQueueResponse,
  type VerificationReviewResponse,
} from '@repo/contracts';
import { VerificationReasonRequiredError } from '../admin/verification-review.errors.js';
import { VerificationReviewService } from '../admin/verification-review.service.js';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { RequestValidationException } from '../common/request-validation.exception.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface ReviewRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(context: ReviewRequestContext, name: string): string | null {
  const value = context.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const QUEUE_FILTERS = new Set<string>(VERIFICATION_QUEUE_FILTERS);

/**
 * The admin seller verification review surface (Phase 7-G).
 *
 * **Nothing about the caller is in any request.** There is no seller identifier, no reviewer identifier,
 * no role, no permission and no assurance level in a parameter, a header this controller reads or a body
 * schema it accepts. The reviewer is resolved from their own access token inside the service, on every
 * route, and the only identifiers below name rows: a verification and a document.
 *
 * **No status is in any request either.** The one write takes `approved` or `rejected`, which are the two
 * decisions 0009's model reaches through a reviewer. A caller cannot ask for `submitted`, `under_review`,
 * `expired` or `draft`, because the contract has no value for them.
 *
 * The controller decides nothing about who may do what. Authorization is the permission key, applied in
 * the service and again inside every `app_private` function — restating it here would be a second copy of
 * a rule, which is how two copies start to disagree. A caller who may not review therefore receives the
 * ordinary not-found, identical to the answer for a verification that is not there.
 */
@Controller('v1/admin')
export class VerificationReviewController {
  constructor(private readonly review: VerificationReviewService) {}

  @Get('seller-verifications')
  async queue(
    @Req() request: ReviewRequestContext,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<VerificationQueueResponse> {
    const page = await this.review.queue({
      accessToken: this.token(request),
      status: this.status(status),
      limit: this.limit(limit),
      cursor: cursor === undefined || cursor === '' ? null : cursor,
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Get('seller-verifications/:verificationId')
  async detail(
    @Param('verificationId') verificationId: string,
    @Req() request: ReviewRequestContext,
  ): Promise<VerificationReviewResponse> {
    const verification = await this.review.detail({
      accessToken: this.token(request),
      verificationId: this.identifier(verificationId, 'verificationId'),
    });
    return { verification };
  }

  /**
   * Approve or reject.
   *
   * A rejection without a reason is refused here, as a validation failure naming the field, so a form can
   * point at the box. That is not a second copy of an authorization rule: 0009's own CHECK would refuse
   * the same write, and the database refuses it again — this is the layer that can say *which field*.
   */
  @Post('seller-verifications/:verificationId/decision')
  @HttpCode(200)
  async decide(
    @Param('verificationId') verificationId: string,
    @Body(new ZodValidationPipe(VerificationDecisionRequestSchema)) body: VerificationDecisionRequest,
    @Req() request: ReviewRequestContext,
  ): Promise<VerificationDecisionResponse> {
    const reason = body.reason === undefined ? null : body.reason;
    if (body.decision === 'rejected' && reason === null) throw new VerificationReasonRequiredError();

    const status = await this.review.decide({
      accessToken: this.token(request),
      verificationId: this.identifier(verificationId, 'verificationId'),
      decision: body.decision,
      reason,
    });
    return { status };
  }

  /**
   * One short-lived look at one document.
   *
   * Both identifiers name rows, and the service requires them to agree: a document id is only usable
   * against the verification it actually belongs to. **Neither is a path**, and there is no parameter on
   * this route through which one could be supplied.
   */
  @Post('seller-verifications/:verificationId/documents/:documentId/link')
  @HttpCode(200)
  async documentLink(
    @Param('verificationId') verificationId: string,
    @Param('documentId') documentId: string,
    @Req() request: ReviewRequestContext,
  ): Promise<VerificationDocumentLinkResponse> {
    return await this.review.documentLink({
      accessToken: this.token(request),
      verificationId: this.identifier(verificationId, 'verificationId'),
      documentId: this.identifier(documentId, 'documentId'),
    });
  }

  /* ---------------------------------------------------------------------------------------------- */

  private token(request: ReviewRequestContext): string {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    return accessToken;
  }

  /** The queue's status filter, checked against the contract's five. `draft` is not one of them. */
  private status(value: string | undefined): VerificationQueueFilter | null {
    if (value === undefined || value === '') return null;
    if (!QUEUE_FILTERS.has(value)) {
      throw new RequestValidationException([{ path: 'status', message: 'The status is invalid.' }]);
    }
    return value as VerificationQueueFilter;
  }

  private limit(value: string | undefined): number {
    const parsed = parseMessagingLimit(value, {
      fallback: VERIFICATION_QUEUE_DEFAULT_LIMIT,
      maximum: VERIFICATION_QUEUE_MAX_LIMIT,
    });
    if (!parsed.ok) throw new RequestValidationException([{ path: 'limit', message: 'The limit is invalid.' }]);
    return parsed.limit;
  }

  /**
   * A path parameter that names a row.
   *
   * Checked for shape here so a malformed identifier is a validation failure rather than a database
   * error, and so nothing that is not an identifier ever reaches a parameter binding.
   */
  private identifier(value: string, path: string): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new RequestValidationException([{ path, message: 'The identifier is invalid.' }]);
    }
    return value.toLowerCase();
  }
}
