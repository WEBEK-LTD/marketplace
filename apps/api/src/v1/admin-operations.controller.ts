import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  ADMIN_OPS_DEFAULT_LIMIT,
  ADMIN_OPS_MAX_LIMIT,
  RecoveryCompletionRequestSchema,
  RecoveryDecisionRequestSchema,
  RecoveryReviewRequestSchema,
  SESSION_TOKEN_HEADER,
  SellerStatusChangeRequestSchema,
  StaffRoleGrantRequestSchema,
  StaffRoleRevokeRequestSchema,
  parseMessagingLimit,
  type AdminRoleCatalogueResponse,
  type AdminSecurityEventsResponse,
  type AdminSellerDetailResponse,
  type AdminSellerPageResponse,
  type AdminUserDetailResponse,
  type AdminUserPageResponse,
  type AdminUserRolesResponse,
  type AuditPageResponse,
  type RecoveryCompletionRequest,
  type RecoveryCompletionResponse,
  type RecoveryDecisionRequest,
  type RecoveryDecisionResponse,
  type RecoveryEvidenceResponse,
  type RecoveryQueueResponse,
  type RecoveryRequestDetailResponse,
  type RecoveryReviewRequest,
  type RecoveryReviewResponse,
  type SellerStatusChangeRequest,
  type SellerStatusChangeResponse,
  type StaffGrantableRolesResponse,
  type StaffRoleGrantRequest,
  type StaffRoleRevokeRequest,
  type StaffRoleWriteResponse,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { AdminOperationsService } from '../admin/admin-operations.service.js';
import { RequestValidationException } from '../common/request-validation.exception.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface AdminOperationsRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(request: AdminOperationsRequestContext, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `seller_profiles_slug_format`, so nothing that could not be a slug reaches a parameter binding. */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/;

/** A PostgreSQL identifier, which is all either audit filter can ever legitimately be. */
const PG_IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

/** How many security events one timeline returns. A fixed page: the timeline is not paged. */
const SECURITY_TIMELINE_LIMIT = 50;

/**
 * Seller and user reads, role reads, recovery review and the audit trail (Phase 7-O).
 *
 * Fifteen operations, eleven of them reads.
 *
 * **There is deliberately no sixteenth that assigns or removes a role.** `public.user_roles` is written by
 * nothing in `app_private`, and by owner decision that writer is deferred to a dedicated security-focused
 * increment after Phase 7 — so the role surface on this controller is GET and nothing else, and no request
 * body anywhere here has a field through which a grant could travel.
 *
 * **Seller account status is the one seller write**, and it is one operation rather than a suspend, a close
 * and a reinstate: the body names where the storefront should end up, and the database owns which pairs are
 * legal.
 *
 * **The caller's account and assurance level come from their own session**, resolved inside the service
 * through `StaffConsoleService.forToken` and `isAal2` in that order. No route takes an actor, a role, a
 * permission key, a target derived from anything but the path, or an assurance level, and every request
 * schema is `.strict()`, so none could.
 *
 * **Each route requires exactly the key the database requires**, and the service names it. The six are not
 * held together, which is the point: `sellers.profile.read` for storefronts, `users.profile.read` for
 * accounts, `users.role.read` for roles — which a moderator reading the account does *not* hold —
 * `users.security.read` for a security timeline, `security.recovery.review` for recovery, and `audit.read`
 * for the trail. No role name is checked anywhere.
 *
 * **A storefront is addressed by slug and an account by its id.** The slug is a storefront's own public
 * handle; the account id is the one identifier that legitimately crosses on an admin surface, because the
 * account is what is being administered and `users.profile.read` is the permission to read it. Both are
 * checked for shape here, so nothing that is not an identifier ever reaches a parameter binding — and what
 * authorizes either read is the permission and the assurance level, tested in the database before any row
 * is reached, never the shape of the identifier.
 *
 * The controller decides nothing. The recovery state machine, the two-person rule, the refusal of the
 * account holder, the requirement that a new contact was verified by a one-time code before completion, and
 * the hold that completion starts are all applied inside 0028's writers, which 0078's wrappers call with the
 * row locked; restating any of them here would be a second copy of a rule, and the copy without the lock is
 * the one that would be wrong.
 */
@Controller('v1/admin')
export class AdminOperationsController {
  constructor(private readonly operations: AdminOperationsService) {}

  /* ---------------------------------------------------------------------------------------------- */
  /* Storefronts — read only                                                                         */
  /* ---------------------------------------------------------------------------------------------- */

  @Get('sellers')
  async sellers(
    @Req() request: AdminOperationsRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('status') status?: string,
    @Query('verificationStatus') verificationStatus?: string,
  ): Promise<AdminSellerPageResponse> {
    const page = await this.operations.sellerPage({
      accessToken: this.token(request),
      limit: this.limit(limit),
      // Passed through as text. The database compares each as a parameter, so an unknown value matches
      // nothing rather than being refused — which is the reader's own documented behaviour and means a
      // stale filter in a bookmark shows an empty page rather than an error.
      status: this.optional(status),
      verificationStatus: this.optional(verificationStatus),
      cursor: this.optional(cursor),
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Get('sellers/:slug')
  async seller(
    @Req() request: AdminOperationsRequestContext,
    @Param('slug') slug: string,
  ): Promise<AdminSellerDetailResponse> {
    const seller = await this.operations.seller({
      accessToken: this.token(request),
      slug: this.slug(slug),
    });
    return { seller };
  }

  /**
   * Changes one storefront's account status.
   *
   * Behind `sellers.profile.manage`, which is **not** the key that let the caller read the storefront: a
   * moderator holds the read key and cannot reach this. The body carries a target status and, for a
   * suspension, its reason — and no timestamp, no verification value and nothing that reaches another
   * domain; the strict schema would refuse every one of those.
   *
   * Which transitions are legal, that `closed` is terminal, that `pending → active` belongs to 7-G, and the
   * two reinstatement conditions are all applied inside 0079's writer with the row locked. Restating any of
   * them here would be a second copy of a rule, and the copy without the lock is the one that would be wrong.
   */
  @Post('sellers/:slug/status')
  @HttpCode(200)
  async setSellerStatus(
    @Req() request: AdminOperationsRequestContext,
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(SellerStatusChangeRequestSchema)) body: SellerStatusChangeRequest,
  ): Promise<SellerStatusChangeResponse> {
    return await this.operations.setSellerStatus({
      accessToken: this.token(request),
      slug: this.slug(slug),
      status: body.status,
      reason: body.reason ?? null,
    });
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Accounts — read only                                                                            */
  /* ---------------------------------------------------------------------------------------------- */

  @Get('users')
  async users(
    @Req() request: AdminOperationsRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('status') status?: string,
  ): Promise<AdminUserPageResponse> {
    const page = await this.operations.userPage({
      accessToken: this.token(request),
      limit: this.limit(limit),
      status: this.optional(status),
      cursor: this.optional(cursor),
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Get('users/:userId')
  async user(
    @Req() request: AdminOperationsRequestContext,
    @Param('userId') userId: string,
  ): Promise<AdminUserDetailResponse> {
    const user = await this.operations.user({
      accessToken: this.token(request),
      userId: this.identifier(userId, 'userId'),
    });
    return { user };
  }

  /**
   * What roles one account holds.
   *
   * Behind `users.role.read`, and **unchanged by 0100**: it reports no actor and no reason, so who granted or
   * withdrew a role is on the row and in no response. The two writers that change a grant are below, behind
   * `users.role.manage`, and the questions this comment used to list as undefined are now owner decisions
   * applied in the database: the ceiling is `roles.sort_order`, a self-grant is refused, and a withdrawal
   * takes effect on the target's next request because nothing in this platform ends a session.
   */
  @Get('users/:userId/roles')
  async userRoles(
    @Req() request: AdminOperationsRequestContext,
    @Param('userId') userId: string,
  ): Promise<AdminUserRolesResponse> {
    const items = await this.operations.userRoles({
      accessToken: this.token(request),
      userId: this.identifier(userId, 'userId'),
    });
    return { items: [...items] };
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Roles — the writers (0100)                                                                      */
  /* ---------------------------------------------------------------------------------------------- */

  /**
   * The roles this caller may grant.
   *
   * Behind `users.role.manage`, and computed in the database from the caller's own effective roles. A console
   * renders this list; it does not filter a catalogue, because a filter in a client is a convention and this
   * is a privilege boundary.
   */
  @Get('roles/grantable')
  async grantableRoles(
    @Req() request: AdminOperationsRequestContext,
  ): Promise<StaffGrantableRolesResponse> {
    const items = await this.operations.grantableRoles({ accessToken: this.token(request) });
    return { items: [...items] };
  }

  /**
   * Grants a role to one account, or reinstates one that was withdrawn.
   *
   * The account is named by the path and never by the body. Every boundary — the ceiling, `super_admin`,
   * assignability, the self rule, the reason and the expiry — is applied by the database against this
   * caller's own effective roles.
   */
  @Post('users/:userId/roles')
  @HttpCode(200)
  async grantRole(
    @Req() request: AdminOperationsRequestContext,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(StaffRoleGrantRequestSchema)) body: StaffRoleGrantRequest,
  ): Promise<StaffRoleWriteResponse> {
    return this.operations.grantRole({
      accessToken: this.token(request),
      userId: this.identifier(userId, 'userId'),
      roleKey: body.roleKey,
      reason: body.reason,
      expiresAt: body.expiresAt ?? null,
    });
  }

  /**
   * Withdraws a role from one account.
   *
   * A `POST` to its own address rather than a `DELETE` on the grant, because the row is not deleted: the
   * withdrawal is recorded on it, with who did it and why, and the grant it withdraws stays beside it. Every
   * write on this surface is a POST, and this is one.
   */
  @Post('users/:userId/roles/revoke')
  @HttpCode(200)
  async revokeRole(
    @Req() request: AdminOperationsRequestContext,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(StaffRoleRevokeRequestSchema)) body: StaffRoleRevokeRequest,
  ): Promise<StaffRoleWriteResponse> {
    return this.operations.revokeRole({
      accessToken: this.token(request),
      userId: this.identifier(userId, 'userId'),
      roleKey: body.roleKey,
      reason: body.reason,
    });
  }

  @Get('users/:userId/security-events')
  async userSecurityEvents(
    @Req() request: AdminOperationsRequestContext,
    @Param('userId') userId: string,
  ): Promise<AdminSecurityEventsResponse> {
    const items = await this.operations.securityTimeline({
      accessToken: this.token(request),
      userId: this.identifier(userId, 'userId'),
      limit: SECURITY_TIMELINE_LIMIT,
    });
    return { items: [...items] };
  }

  @Get('roles')
  async roles(@Req() request: AdminOperationsRequestContext): Promise<AdminRoleCatalogueResponse> {
    const items = await this.operations.roleCatalogue({ accessToken: this.token(request) });
    return { items: [...items] };
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Account recovery                                                                                */
  /* ---------------------------------------------------------------------------------------------- */

  @Get('recovery/requests')
  async recoveryQueue(
    @Req() request: AdminOperationsRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('status') status?: string,
  ): Promise<RecoveryQueueResponse> {
    const page = await this.operations.recoveryQueue({
      accessToken: this.token(request),
      limit: this.limit(limit),
      status: this.optional(status),
      cursor: this.optional(cursor),
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Get('recovery/requests/:requestId')
  async recoveryRequest(
    @Req() request: AdminOperationsRequestContext,
    @Param('requestId') requestId: string,
  ): Promise<RecoveryRequestDetailResponse> {
    const result = await this.operations.recoveryRequest({
      accessToken: this.token(request),
      requestId: this.identifier(requestId, 'requestId'),
    });
    return { request: result };
  }

  @Get('recovery/requests/:requestId/evidence')
  async recoveryEvidence(
    @Req() request: AdminOperationsRequestContext,
    @Param('requestId') requestId: string,
  ): Promise<RecoveryEvidenceResponse> {
    const items = await this.operations.recoveryEvidence({
      accessToken: this.token(request),
      requestId: this.identifier(requestId, 'requestId'),
    });
    return { items: [...items] };
  }

  /**
   * Records the identity review.
   *
   * The body carries a note and nothing else — there is no reviewer field, and the strict schema would
   * refuse one. The writer fixes the caller as the reviewer, which is the identity the second approver is
   * later checked against.
   */
  @Post('recovery/requests/:requestId/review')
  @HttpCode(200)
  async recoveryReview(
    @Req() request: AdminOperationsRequestContext,
    @Param('requestId') requestId: string,
    @Body(new ZodValidationPipe(RecoveryReviewRequestSchema)) body: RecoveryReviewRequest,
  ): Promise<RecoveryReviewResponse> {
    return await this.operations.recoveryReview({
      accessToken: this.token(request),
      requestId: this.identifier(requestId, 'requestId'),
      note: body.note ?? null,
    });
  }

  /**
   * The second approver's decision.
   *
   * The body carries the writer's own two words and a reason where one is required. There is no approver
   * field: the writer refuses the reviewer and the account holder by identity, from the session.
   */
  @Post('recovery/requests/:requestId/decision')
  @HttpCode(200)
  async recoveryDecision(
    @Req() request: AdminOperationsRequestContext,
    @Param('requestId') requestId: string,
    @Body(new ZodValidationPipe(RecoveryDecisionRequestSchema)) body: RecoveryDecisionRequest,
  ): Promise<RecoveryDecisionResponse> {
    return await this.operations.recoveryDecision({
      accessToken: this.token(request),
      requestId: this.identifier(requestId, 'requestId'),
      decision: body.decision,
      note: body.note ?? null,
    });
  }

  /**
   * Finishes a recovery.
   *
   * The body carries one boolean recording what the colleague did out of band. It does not carry the hold,
   * the session revocation or the MFA reset time: the writer computes and records all three, and no field
   * here could shorten or skip any of them.
   */
  @Post('recovery/requests/:requestId/completion')
  @HttpCode(200)
  async recoveryCompletion(
    @Req() request: AdminOperationsRequestContext,
    @Param('requestId') requestId: string,
    @Body(new ZodValidationPipe(RecoveryCompletionRequestSchema)) body: RecoveryCompletionRequest,
  ): Promise<RecoveryCompletionResponse> {
    return await this.operations.recoveryCompletion({
      accessToken: this.token(request),
      requestId: this.identifier(requestId, 'requestId'),
      mfaWasReset: body.mfaWasReset,
    });
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* The audit trail — read only                                                                     */
  /* ---------------------------------------------------------------------------------------------- */

  /**
   * One page of the audit trail.
   *
   * The two filters are the ones the audit indexes support. Each is checked against the shape a PostgreSQL
   * identifier can have, so a filter is either a name or a validation failure — never something that
   * reaches a comparison as anything else. There is deliberately no actor filter: assembling one
   * colleague's activity is not what an audit read is for, and no index supports it either.
   */
  @Get('audit')
  async audit(
    @Req() request: AdminOperationsRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('tableSchema') tableSchema?: string,
    @Query('tableName') tableName?: string,
    @Query('recordId') recordId?: string,
  ): Promise<AuditPageResponse> {
    const schema = this.identifierFilter(tableSchema, 'tableSchema');
    const table = this.identifierFilter(tableName, 'tableName');
    const record = this.optional(recordId);
    if (record !== null && (schema === null || table === null)) {
      throw new RequestValidationException([
        { path: 'recordId', message: 'A record is named within a table.' },
      ]);
    }

    const page = await this.operations.auditPage({
      accessToken: this.token(request),
      limit: this.limit(limit),
      tableSchema: schema,
      tableName: table,
      recordId: record,
      cursor: this.optional(cursor),
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  /* ---------------------------------------------------------------------------------------------- */

  /** The caller's own session token. A request without one never reaches a reader. */
  private token(request: AdminOperationsRequestContext): string {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    return accessToken;
  }

  private optional(value: string | undefined): string | null {
    return value === undefined || value === '' ? null : value;
  }

  private limit(value: string | undefined): number {
    const parsed = parseMessagingLimit(value, {
      fallback: ADMIN_OPS_DEFAULT_LIMIT,
      maximum: ADMIN_OPS_MAX_LIMIT,
    });
    if (!parsed.ok) {
      throw new RequestValidationException([{ path: 'limit', message: 'The limit is invalid.' }]);
    }
    return parsed.limit;
  }

  /**
   * A path parameter that names an account or a recovery request.
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

  /** A storefront's own handle, checked against the column's format for the same reason. */
  private slug(value: string): string {
    if (typeof value !== 'string' || !SLUG_PATTERN.test(value)) {
      throw new RequestValidationException([{ path: 'slug', message: 'The slug is invalid.' }]);
    }
    return value;
  }

  private identifierFilter(value: string | undefined, path: string): string | null {
    const text = this.optional(value);
    if (text === null) return null;
    if (!PG_IDENTIFIER_PATTERN.test(text)) {
      throw new RequestValidationException([{ path, message: 'The filter is invalid.' }]);
    }
    return text;
  }
}
