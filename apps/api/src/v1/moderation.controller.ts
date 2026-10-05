import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  MODERATION_DEFAULT_LIMIT,
  MODERATION_HISTORY_LIMIT,
  MODERATION_MAX_LIMIT,
  ModerateListingRequestSchema,
  ResolveReportRequestSchema,
  SESSION_TOKEN_HEADER,
  parseMessagingLimit,
  type ListingModerationHistoryResponse,
  type ModerateListingRequest,
  type ModerateListingResponse,
  type ModerationActionsResponse,
  type ModerationListingDetailResponse,
  type ModerationListingQueueResponse,
  type ModerationReportDetailResponse,
  type ModerationReportQueueResponse,
  type ResolveReportRequest,
  type ResolveReportResponse,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { ModerationService } from '../admin/moderation.service.js';
import { RequestValidationException } from '../common/request-validation.exception.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface ModerationRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(request: ModerationRequestContext, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Listing moderation and report management (Phase 7-N).
 *
 * Eight operations, and deliberately no ninth. There is nothing here that edits a decision, reverses one,
 * assigns a report or deletes anything — no writer in this repository does any of those, and the two trails
 * are append-only by trigger, so an edit route would be a route to an exception.
 *
 * **The caller's account and assurance level come from their own session**, resolved inside the service
 * through `StaffConsoleService.forToken` and `isAal2` in that order. No route takes an actor, a role, a
 * permission or an assurance level, and every request schema is `.strict()`, so none could.
 *
 * **Each route requires exactly the key the database requires**, and the service names it: the report read
 * key for the queue and the detail, the manage key for the decision, the **action** key for either trail —
 * which is what 0027's own policy gates those tables on and is not the report key — the catalogue read key
 * for a listing, and the catalogue moderate key for a decision about one. No role name is checked anywhere.
 *
 * **A report and a listing are addressed by their own ids**, which is what 0027's writers take and what a
 * colleague holding the read keys legitimately holds. No operation accepts a storage path or a bucket,
 * because moderating a listing touches no storage at all.
 *
 * The controller decides nothing. Which statuses a report may move to, that a decision carries a reason,
 * that a duplicate names its original, that nobody rules on their own report or moderates their own listing,
 * and that an action must move the status, are all applied inside migration 0077's wrappers, which call
 * 0027's own writers with the rows locked; restating any of them here would be a second copy of a rule, and
 * the copy without the lock is the one that would be wrong.
 */
@Controller('v1/admin/moderation')
export class ModerationController {
  constructor(private readonly moderation: ModerationService) {}

  @Get('reports')
  async reportQueue(
    @Req() request: ModerationRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('status') status?: string,
  ): Promise<ModerationReportQueueResponse> {
    const page = await this.moderation.reportQueue({
      accessToken: this.token(request),
      limit: this.limit(limit),
      // Passed through as text. The database compares it as a parameter, so an unknown value matches
      // nothing rather than being refused — which is the reader's own documented behaviour and means a
      // stale filter in a bookmark shows an empty queue rather than an error.
      status: status === undefined || status === '' ? null : status,
      cursor: cursor === undefined || cursor === '' ? null : cursor,
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Get('reports/:reportId')
  async report(
    @Req() request: ModerationRequestContext,
    @Param('reportId') reportId: string,
  ): Promise<ModerationReportDetailResponse> {
    const report = await this.moderation.report({
      accessToken: this.token(request),
      reportId: this.identifier(reportId, 'reportId'),
    });
    return { report };
  }

  /**
   * Records a decision on one report.
   *
   * The body carries one of the four statuses the existing writer accepts, a note where one is required, and
   * — only for a duplicate — the report it duplicates. There is no moderator field, no priority field and no
   * assignee field, and the strict schema would refuse every one of them.
   */
  @Post('reports/:reportId/resolution')
  @HttpCode(200)
  async resolveReport(
    @Req() request: ModerationRequestContext,
    @Param('reportId') reportId: string,
    @Body(new ZodValidationPipe(ResolveReportRequestSchema)) body: ResolveReportRequest,
  ): Promise<ResolveReportResponse> {
    return await this.moderation.resolveReport({
      accessToken: this.token(request),
      reportId: this.identifier(reportId, 'reportId'),
      request: body,
    });
  }

  @Get('reports/:reportId/actions')
  async reportActions(
    @Req() request: ModerationRequestContext,
    @Param('reportId') reportId: string,
  ): Promise<ModerationActionsResponse> {
    const items = await this.moderation.reportActions({
      accessToken: this.token(request),
      reportId: this.identifier(reportId, 'reportId'),
      limit: MODERATION_HISTORY_LIMIT,
    });
    return { items: [...items] };
  }

  @Get('listings')
  async listingQueue(
    @Req() request: ModerationRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<ModerationListingQueueResponse> {
    const page = await this.moderation.listingQueue({
      accessToken: this.token(request),
      limit: this.limit(limit),
      cursor: cursor === undefined || cursor === '' ? null : cursor,
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Get('listings/:listingId')
  async listing(
    @Req() request: ModerationRequestContext,
    @Param('listingId') listingId: string,
  ): Promise<ModerationListingDetailResponse> {
    const listing = await this.moderation.listing({
      accessToken: this.token(request),
      listingId: this.identifier(listingId, 'listingId'),
    });
    return { listing };
  }

  /**
   * Moderates one listing.
   *
   * The body carries one of the five actions the existing writer defines and the reason both writers
   * require, and may cite the report that prompted it. There is no status field — the status the listing
   * lands on is the writer's own mapping — and no expiry and no reversal, because no writer in this
   * repository sets either.
   */
  @Post('listings/:listingId/actions')
  @HttpCode(200)
  async moderateListing(
    @Req() request: ModerationRequestContext,
    @Param('listingId') listingId: string,
    @Body(new ZodValidationPipe(ModerateListingRequestSchema)) body: ModerateListingRequest,
  ): Promise<ModerateListingResponse> {
    return await this.moderation.moderateListing({
      accessToken: this.token(request),
      listingId: this.identifier(listingId, 'listingId'),
      request: body,
    });
  }

  @Get('listings/:listingId/history')
  async listingHistory(
    @Req() request: ModerationRequestContext,
    @Param('listingId') listingId: string,
  ): Promise<ListingModerationHistoryResponse> {
    const items = await this.moderation.listingHistory({
      accessToken: this.token(request),
      listingId: this.identifier(listingId, 'listingId'),
      limit: MODERATION_HISTORY_LIMIT,
    });
    return { items: [...items] };
  }

  /* ---------------------------------------------------------------------------------------------- */

  /** The caller's own session token. A request without one never reaches a reader. */
  private token(request: ModerationRequestContext): string {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    return accessToken;
  }

  private limit(value: string | undefined): number {
    const parsed = parseMessagingLimit(value, {
      fallback: MODERATION_DEFAULT_LIMIT,
      maximum: MODERATION_MAX_LIMIT,
    });
    if (!parsed.ok) {
      throw new RequestValidationException([{ path: 'limit', message: 'The limit is invalid.' }]);
    }
    return parsed.limit;
  }

  /**
   * A path parameter that names a row.
   *
   * Checked for shape here so a malformed identifier is a validation failure rather than a database error,
   * and so nothing that is not an identifier ever reaches a parameter binding.
   */
  private identifier(value: string, path: string): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new RequestValidationException([{ path, message: 'The identifier is invalid.' }]);
    }
    return value.toLowerCase();
  }
}
