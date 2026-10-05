import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  DISPUTES_DEFAULT_LIMIT,
  DISPUTES_MAX_LIMIT,
  DISPUTE_THREAD_LIMIT,
  PostDisputeMessageRequestSchema,
  ResolveDisputeRequestSchema,
  SELECTABLE_DISPUTE_STATUSES,
  SESSION_TOKEN_HEADER,
  parseMessagingLimit,
  type DisputeDetailResponse,
  type DisputeMessagesResponse,
  type DisputeQueueResponse,
  type PostDisputeMessageRequest,
  type PostDisputeMessageResponse,
  type ResolveDisputeRequest,
  type ResolveDisputeResponse,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { DisputeManagementService } from '../admin/dispute-management.service.js';
import { RequestValidationException } from '../common/request-validation.exception.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface DisputeRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(request: DisputeRequestContext, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Dispute management (Phase 7-R).
 *
 * Five operations: the queue, one dispute, its thread, a staff message, and the decision.
 *
 * ---------------------------------------------------------------------------------------------------
 * **NEITHER WRITE ON THIS CONTROLLER MOVES MONEY.**
 *
 * A resolution records a decision. `refund_buyer` and `partial_refund` record that a refund is owed, and this
 * controller creates no refund, reverses no payment, posts no ledger entry, changes no balance, touches no
 * payout or withdrawal and calls no provider. Issuing the refund is a separate, later financial operation with
 * its own record and its own permission — `payments.refund.*`, which this controller never consults — and no
 * writer for it exists in this platform yet.
 *
 * So there is no refund route here, no reversal route, no payout route and no request body through which one
 * could be asked for. The resolution response carries no refund identifier and no payment reference, because
 * none is created.
 * ---------------------------------------------------------------------------------------------------
 *
 * **The caller's account and assurance level come from their own session**, resolved inside the service
 * through `StaffConsoleService.forToken` and then `isAal2` on that same now-validated token, in that order. No
 * route takes an actor, a role, a permission key, an assurance level or a resolver, and both request schemas
 * are `.strict()`, so none could.
 *
 * **Two keys, and each route requires exactly the one the database requires.** `disputes.dispute.read` for the
 * three reads; `disputes.dispute.manage` for the two writes — which is why the detail reports `canManage`
 * rather than leaving a console to guess. Only Admin and Super Admin hold either, and a Moderator is
 * deliberately granted neither. No role name is checked anywhere.
 *
 * **Only the two reachable statuses are accepted as a filter.** The other four exist in the schema and no
 * writer sets any of them, so a filter naming one would match nothing for ever. It is refused rather than
 * passed through — the opposite of this platform's usual "an unknown value matches nothing" behaviour, and
 * deliberately so: a *well-formed but unreachable* state is a console asking for a workflow that does not
 * exist, which is worth saying rather than answering with a silent empty page.
 *
 * **A dispute is addressed by its id**, checked for shape here so nothing that is not an identifier reaches a
 * parameter binding — but what authorizes the read is the permission and the assurance level, tested in the
 * database before any row is reached.
 *
 * **The controller decides nothing.** The four resolutions, the required reason, the amount-only-for-a-refund
 * rule, the refusal of a resolver who is a party, the refusal of an internal note from a party, the closed
 * thread and the order's snapshot restoration are all decided in the database. Restating any of them here
 * would be a second copy of a rule, and the copy without the lock is the one that would be wrong.
 */
@Controller('v1/admin/disputes')
export class DisputeManagementController {
  constructor(private readonly disputes: DisputeManagementService) {}

  /** One page of the queue, oldest first. */
  @Get()
  async queue(
    @Req() request: DisputeRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('status') status?: string,
  ): Promise<DisputeQueueResponse> {
    const page = await this.disputes.queue({
      accessToken: this.token(request),
      limit: this.limit(limit),
      status: this.status(status),
      cursor: this.optional(cursor),
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  /** One dispute, with the order it is about. */
  @Get(':disputeId')
  async dispute(
    @Req() request: DisputeRequestContext,
    @Param('disputeId') disputeId: string,
  ): Promise<DisputeDetailResponse> {
    const dispute = await this.disputes.dispute({
      accessToken: this.token(request),
      disputeId: this.identifier(disputeId, 'disputeId'),
    });
    return { dispute };
  }

  /**
   * The thread, including the internal staff notes.
   *
   * A fixed page: a dispute thread is short by construction, and paging one would mean a colleague could read
   * half an exchange and rule on it.
   */
  @Get(':disputeId/messages')
  async messages(
    @Req() request: DisputeRequestContext,
    @Param('disputeId') disputeId: string,
  ): Promise<DisputeMessagesResponse> {
    const items = await this.disputes.messages({
      accessToken: this.token(request),
      disputeId: this.identifier(disputeId, 'disputeId'),
      limit: DISPUTE_THREAD_LIMIT,
    });
    return { items: [...items] };
  }

  /**
   * Adds a staff message or an internal note.
   *
   * The body carries the text and whether it is internal. It names no author and no time, because the writer
   * works the role out of the dispute itself and records when.
   */
  @Post(':disputeId/messages')
  @HttpCode(200)
  async postMessage(
    @Req() request: DisputeRequestContext,
    @Param('disputeId') disputeId: string,
    @Body(new ZodValidationPipe(PostDisputeMessageRequestSchema)) body: PostDisputeMessageRequest,
  ): Promise<PostDisputeMessageResponse> {
    return this.disputes.postMessage({
      accessToken: this.token(request),
      disputeId: this.identifier(disputeId, 'disputeId'),
      body: body.body,
      isInternal: body.isInternal,
    });
  }

  /**
   * Records a decision.
   *
   * **This moves no money.** The body names where the dispute should end up and why, and for a refund
   * resolution the decided amount — as a decimal string in minor units, which is how every amount crosses this
   * API. Recording it means a colleague decided a refund is owed; paying it is a separate operation.
   */
  @Post(':disputeId/resolution')
  @HttpCode(200)
  async resolve(
    @Req() request: DisputeRequestContext,
    @Param('disputeId') disputeId: string,
    @Body(new ZodValidationPipe(ResolveDisputeRequestSchema)) body: ResolveDisputeRequest,
  ): Promise<ResolveDisputeResponse> {
    return this.disputes.resolve({
      accessToken: this.token(request),
      disputeId: this.identifier(disputeId, 'disputeId'),
      resolution: body.resolution,
      resolutionNote: body.resolutionNote,
      // Passed along as the string it arrived as, all the way to a `bigint` parameter. A `Number()` here would
      // silently round a large decision.
      resolutionAmountMinor: body.resolutionAmountMinor ?? null,
    });
  }

  /* ---------------------------------------------------------------------------------------------- */

  /** The caller's own session token. A request without one never reaches a reader. */
  private token(request: DisputeRequestContext): string {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    return accessToken;
  }

  private optional(value: string | undefined): string | null {
    return value === undefined || value === '' ? null : value;
  }

  private limit(value: string | undefined): number {
    const parsed = parseMessagingLimit(value, {
      fallback: DISPUTES_DEFAULT_LIMIT,
      maximum: DISPUTES_MAX_LIMIT,
    });
    if (!parsed.ok) {
      throw new RequestValidationException([{ path: 'limit', message: 'The limit is invalid.' }]);
    }
    return parsed.limit;
  }

  /**
   * The status filter, refused unless it is one a writer can produce.
   *
   * Refused rather than dropped, and refused rather than forwarded: a filter naming `under_review` is asking
   * for a state this platform cannot put a dispute into, and answering it with an empty page would suggest the
   * workflow exists and simply has nothing in it today.
   */
  private status(value: string | undefined): string | null {
    const text = this.optional(value);
    if (text === null) return null;
    if (!(SELECTABLE_DISPUTE_STATUSES as readonly string[]).includes(text)) {
      throw new RequestValidationException([{ path: 'status', message: 'The filter is invalid.' }]);
    }
    return text;
  }

  /**
   * The path parameter that names a dispute.
   *
   * Checked for shape here so a malformed identifier is a validation failure rather than a database error, and
   * so nothing that is not an identifier ever reaches a parameter binding.
   */
  private identifier(value: string, path: string): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new RequestValidationException([{ path, message: 'The identifier is invalid.' }]);
    }
    return value.toLowerCase();
  }
}
