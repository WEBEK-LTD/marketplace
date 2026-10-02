import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import {
  FileMessagingReportRequestSchema,
  MESSAGING_INBOX_DEFAULT_LIMIT,
  MESSAGING_INBOX_MAX_LIMIT,
  MESSAGING_MESSAGES_DEFAULT_LIMIT,
  MESSAGING_MESSAGES_MAX_LIMIT,
  MarkReadRequestSchema,
  SESSION_TOKEN_HEADER,
  SendMessageRequestSchema,
  SetMutedRequestSchema,
  StartConversationRequestSchema,
  parseMessagingLimit,
  type CloseConversationResponse,
  type ConversationMessagesResponse,
  type FileMessagingReportRequest,
  type FileMessagingReportResponse,
  type LeaveConversationResponse,
  type MarkReadRequest,
  type MarkReadResponse,
  type MessagingInboxResponse,
  type SendMessageRequest,
  type SendMessageResponse,
  type SetMutedRequest,
  type SetMutedResponse,
  type StartConversationRequest,
  type StartConversationResponse,
  type UnreadCountResponse,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { MessagingService } from '../messaging/messaging.service.js';
import { MessagingWriteService } from '../messaging/messaging-write.service.js';
import { CurrentUserService } from '../users/current-user.service.js';
import { RequestValidationException } from '../common/request-validation.exception.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface MessagingRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(context: MessagingRequestContext, name: string): string | null {
  const value = context.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The messaging read routes (Phase 5-C).
 *
 * All three are authenticated, and all three resolve the caller the same way: from their own access
 * token, through {@link CurrentUserService}, which asks the provider whose token it is and then the
 * database whether that account still exists. **No route accepts a user identifier.** There is no
 * parameter, header or body field anywhere below from which a caller could name somebody else, which is
 * what makes the readers' own scoping a second line rather than the only one.
 *
 * The controller decides nothing about who may read what. Membership, the left-participant rule and the
 * refusal that a stranger gets are all migration 0053's, and they are not restated here — restating an
 * authorization rule is how two copies of it start to disagree.
 *
 * A conversation id that is not a uuid is refused before anything is read: it cannot name a
 * conversation, so looking it up would spend a query to learn nothing. It is a validation failure and
 * not a not-found, because the shape of the request is wrong rather than the thing it asks for missing —
 * and that distinction reveals nothing, since a malformed id names no conversation for anybody.
 */
@Controller('v1/messaging')
export class MessagingController {
  constructor(
    private readonly messaging: MessagingService,
    private readonly writes: MessagingWriteService,
    private readonly users: CurrentUserService,
  ) {}

  @Get('conversations')
  async inbox(
    @Req() request: MessagingRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<MessagingInboxResponse> {
    const userId = await this.caller(request);
    const parsed = parseMessagingLimit(limit, {
      fallback: MESSAGING_INBOX_DEFAULT_LIMIT,
      maximum: MESSAGING_INBOX_MAX_LIMIT,
    });
    if (!parsed.ok) throw new RequestValidationException([{ path: 'limit', message: 'The limit is invalid.' }]);

    const page = await this.messaging.inbox({
      userId,
      limit: parsed.limit,
      cursor: cursor === undefined || cursor === '' ? null : cursor,
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Get('conversations/:conversationId/messages')
  async messages(
    @Req() request: MessagingRequestContext,
    @Param('conversationId') conversationId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<ConversationMessagesResponse> {
    const userId = await this.caller(request);
    this.assertConversationId(conversationId);
    const parsed = parseMessagingLimit(limit, {
      fallback: MESSAGING_MESSAGES_DEFAULT_LIMIT,
      maximum: MESSAGING_MESSAGES_MAX_LIMIT,
    });
    if (!parsed.ok) throw new RequestValidationException([{ path: 'limit', message: 'The limit is invalid.' }]);

    // The refusal for a conversation the caller may not read is raised by the service, where the rule
    // lives; restating it here would be a second copy of an authorization decision.
    const page = await this.messaging.messages({
      userId,
      conversationId,
      limit: parsed.limit,
      cursor: cursor === undefined || cursor === '' ? null : cursor,
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Get('unread-count')
  async unreadCount(@Req() request: MessagingRequestContext): Promise<UnreadCountResponse> {
    const userId = await this.caller(request);
    return { unreadCount: await this.messaging.unreadCount(userId) };
  }

  /**
   * `POST /v1/messaging/conversations` — start a conversation, or resolve to the open one.
   *
   * `reused` is a success, not a conflict: the caller asked to talk to somebody and there is a place to
   * do it. The surface navigates to `conversationId` either way.
   */
  @Post('conversations')
  @HttpCode(200)
  async startConversation(
    @Req() request: MessagingRequestContext,
    @Body(new ZodValidationPipe(StartConversationRequestSchema)) body: StartConversationRequest,
  ): Promise<StartConversationResponse> {
    const userId = await this.caller(request);
    const started = await this.writes.startConversation(userId, body);
    return { outcome: started.outcome, conversationId: started.conversationId };
  }

  /** `POST /v1/messaging/conversations/:id/messages` — send one text message as the caller. */
  @Post('conversations/:conversationId/messages')
  @HttpCode(201)
  async sendMessage(
    @Req() request: MessagingRequestContext,
    @Param('conversationId') conversationId: string,
    @Body(new ZodValidationPipe(SendMessageRequestSchema)) body: SendMessageRequest,
  ): Promise<SendMessageResponse> {
    const userId = await this.caller(request);
    this.assertConversationId(conversationId);
    return { message: await this.writes.sendMessage(userId, conversationId, body.body) };
  }

  /** `PUT /v1/messaging/conversations/:id/read` — move the caller's own marker forward. */
  @Put('conversations/:conversationId/read')
  @HttpCode(200)
  async markRead(
    @Req() request: MessagingRequestContext,
    @Param('conversationId') conversationId: string,
    @Body(new ZodValidationPipe(MarkReadRequestSchema)) body: MarkReadRequest,
  ): Promise<MarkReadResponse> {
    const userId = await this.caller(request);
    this.assertConversationId(conversationId);
    return { lastReadSeq: await this.writes.markRead(userId, conversationId, body.seq) };
  }

  /** `PUT /v1/messaging/conversations/:id/muted` — the caller's own mute flag. */
  @Put('conversations/:conversationId/muted')
  @HttpCode(200)
  async setMuted(
    @Req() request: MessagingRequestContext,
    @Param('conversationId') conversationId: string,
    @Body(new ZodValidationPipe(SetMutedRequestSchema)) body: SetMutedRequest,
  ): Promise<SetMutedResponse> {
    const userId = await this.caller(request);
    this.assertConversationId(conversationId);
    return { isMuted: await this.writes.setMuted(userId, conversationId, body.isMuted) };
  }

  /**
   * `DELETE /v1/messaging/conversations/:id/membership` — the caller leaves.
   *
   * `DELETE` on the caller's own membership rather than a verb, because that is what it is: one
   * membership, the caller's, removed from the active set. Nothing else is deleted.
   */
  @Delete('conversations/:conversationId/membership')
  @HttpCode(200)
  async leave(
    @Req() request: MessagingRequestContext,
    @Param('conversationId') conversationId: string,
  ): Promise<LeaveConversationResponse> {
    const userId = await this.caller(request);
    this.assertConversationId(conversationId);
    await this.writes.leaveConversation(userId, conversationId);
    return { membershipState: 'left' };
  }

  /** `PUT /v1/messaging/conversations/:id/closed` — close it. Idempotent, and there is no reopen. */
  @Put('conversations/:conversationId/closed')
  @HttpCode(200)
  async close(
    @Req() request: MessagingRequestContext,
    @Param('conversationId') conversationId: string,
  ): Promise<CloseConversationResponse> {
    const userId = await this.caller(request);
    this.assertConversationId(conversationId);
    const closedAt = await this.writes.closeConversation(userId, conversationId);
    return { isClosed: true, closedAt: closedAt.toISOString() };
  }

  /**
   * `POST /v1/messaging/reports` — report a message or a conversation (Phase 5-H).
   *
   * 200 rather than 201 because a repeat is not a creation: 0027's reporting lands a second submission on
   * the report already open and answers with the same id. The reporter is the caller, resolved from their
   * own session; the body carries the subject and a reason from the existing vocabulary, and no actor.
   *
   * Filing a report changes nothing else — not the message, not the conversation, not the membership, the
   * mute state or the read markers — and creates no moderation action.
   */
  @Post('reports')
  @HttpCode(200)
  async fileReport(
    @Req() request: MessagingRequestContext,
    @Body(new ZodValidationPipe(FileMessagingReportRequestSchema)) body: FileMessagingReportRequest,
  ): Promise<FileMessagingReportResponse> {
    const userId = await this.caller(request);
    const reportId = await this.writes.fileReport(userId, body);
    return { outcome: 'filed', reportId };
  }

  /** A malformed identifier names no conversation, so it is refused before anything is read or written. */
  private assertConversationId(conversationId: string): void {
    if (!UUID_PATTERN.test(conversationId)) {
      throw new RequestValidationException([
        { path: 'conversationId', message: 'The conversation identifier is invalid.' },
      ]);
    }
  }

  /** The caller's own account id. A request without a usable session never reaches a reader. */
  private async caller(request: MessagingRequestContext): Promise<string> {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    const user = await this.users.forToken(accessToken);
    return user.id;
  }
}
