import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  OpenSupportTicketSchema,
  PostSupportMessageSchema,
  SESSION_TOKEN_HEADER,
  SUPPORT_MESSAGES_DEFAULT_LIMIT,
  SUPPORT_MESSAGES_MAX_LIMIT,
  SUPPORT_TICKETS_DEFAULT_LIMIT,
  SUPPORT_TICKETS_MAX_LIMIT,
  SupportAttachmentRecordSchema,
  SupportAttachmentUploadRequestSchema,
  parseMessagingLimit,
  type OpenSupportTicket,
  type OpenSupportTicketResponse,
  type PostSupportMessage,
  type SupportAttachmentLinkResponse,
  type SupportAttachmentRecord,
  type SupportAttachmentRecordResponse,
  type SupportAttachmentUploadRequest,
  type SupportAttachmentUploadResponse,
  type SupportMessageMutationResponse,
  type SupportMessagesResponse,
  type SupportTicketClosureResponse,
  type SupportTicketDetailResponse,
  type SupportTicketsResponse,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { RequestValidationException } from '../common/request-validation.exception.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { SupportService } from '../support/support.service.js';
import { CurrentUserService } from '../users/current-user.service.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface SupportRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(context: SupportRequestContext, name: string): string | null {
  const value = context.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Support — the requester side (Phase 7-K).
 *
 * Every route here is authenticated and every one resolves the caller the same way: from their own access
 * token, through {@link CurrentUserService}. **No route accepts a user identifier, a role, a side or a
 * status.** The path parameters are a ticket, a message and an attachment, all of which name rows, and the
 * bodies carry a subject, a category, a message and the two facts about a file that the bucket has the
 * final say on. There is no value a caller could send that would show them somebody else's ticket or let
 * them act on it.
 *
 * **Nothing here is an agent operation.** There is no assignment route, no internal-note route, no status
 * route, no priority route and no queue: 7-L owns the console, and none of 0028's two staff writers is
 * reachable from this file. The one closure route names its transition and carries no body at all.
 *
 * **An attachment is addressed through its own ticket.** The upload halves sit under
 * `/{ticketId}/messages/{messageId}/attachments…` and the signed read under
 * `/{ticketId}/attachments/{attachmentId}/link`, and the database refuses a message or an attachment that
 * does not belong to that ticket — so neither identifier can be spent from the wrong page.
 *
 * The controller decides nothing about who may do what. Ownership, the ticket's state and the object path
 * are all applied inside migration 0074's functions, which call 0028's writers with the rows locked;
 * restating any of them here would be a second copy of a rule, and the copy without the lock is the one
 * that would be wrong.
 */
@Controller('v1/support')
export class SupportController {
  constructor(
    private readonly support: SupportService,
    private readonly users: CurrentUserService,
  ) {}

  @Get('tickets')
  async tickets(
    @Req() request: SupportRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<SupportTicketsResponse> {
    const userId = await this.caller(request);
    const page = await this.support.tickets({
      userId,
      limit: this.limit(limit, SUPPORT_TICKETS_DEFAULT_LIMIT, SUPPORT_TICKETS_MAX_LIMIT),
      cursor: cursor === undefined || cursor === '' ? null : cursor,
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  /**
   * Opens one ticket.
   *
   * The body names a subject, one of the eight existing categories and the first message. There is no
   * priority field, no status field, no assignee field and no order field, and the strict schema would
   * refuse every one of them.
   */
  @Post('tickets')
  @HttpCode(201)
  async open(
    @Body(new ZodValidationPipe(OpenSupportTicketSchema)) body: OpenSupportTicket,
    @Req() request: SupportRequestContext,
  ): Promise<OpenSupportTicketResponse> {
    const userId = await this.caller(request);
    return await this.support.open({
      userId,
      subject: body.subject,
      category: body.category,
      body: body.body,
    });
  }

  @Get('tickets/:ticketId')
  async ticket(
    @Param('ticketId') ticketId: string,
    @Req() request: SupportRequestContext,
  ): Promise<SupportTicketDetailResponse> {
    const userId = await this.caller(request);
    return {
      ticket: await this.support.ticket({
        userId,
        ticketId: this.identifier(ticketId, 'ticketId'),
      }),
    };
  }

  @Get('tickets/:ticketId/messages')
  async messages(
    @Param('ticketId') ticketId: string,
    @Req() request: SupportRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<SupportMessagesResponse> {
    const userId = await this.caller(request);
    const page = await this.support.messages({
      userId,
      ticketId: this.identifier(ticketId, 'ticketId'),
      limit: this.limit(limit, SUPPORT_MESSAGES_DEFAULT_LIMIT, SUPPORT_MESSAGES_MAX_LIMIT),
      cursor: cursor === undefined || cursor === '' ? null : cursor,
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  /** Replies on one's own ticket. The author's role is the database's to decide, not this body's. */
  @Post('tickets/:ticketId/messages')
  @HttpCode(201)
  async reply(
    @Param('ticketId') ticketId: string,
    @Body(new ZodValidationPipe(PostSupportMessageSchema)) body: PostSupportMessage,
    @Req() request: SupportRequestContext,
  ): Promise<SupportMessageMutationResponse> {
    const userId = await this.caller(request);
    return await this.support.reply({
      userId,
      ticketId: this.identifier(ticketId, 'ticketId'),
      body: body.body,
    });
  }

  /**
   * Closes one's own ticket.
   *
   * No body and no status: the operation is the transition. `resolved` has no representation on this
   * surface — it is the agent outcome, and the database passes the literal `closed` to 0028's writer.
   */
  @Post('tickets/:ticketId/close')
  @HttpCode(200)
  async close(
    @Param('ticketId') ticketId: string,
    @Req() request: SupportRequestContext,
  ): Promise<SupportTicketClosureResponse> {
    const userId = await this.caller(request);
    return await this.support.close({
      userId,
      ticketId: this.identifier(ticketId, 'ticketId'),
    });
  }

  /**
   * Asks for somewhere to put one file.
   *
   * The body says what kind of file and how large; **it carries no path**, and the strict schema has no
   * field for one. The message is named in the route together with its ticket, and the database refuses a
   * message that is not the caller's own.
   */
  @Post('tickets/:ticketId/messages/:messageId/attachments/uploads')
  @HttpCode(201)
  async authorizeAttachment(
    @Param('ticketId') ticketId: string,
    @Param('messageId') messageId: string,
    @Body(new ZodValidationPipe(SupportAttachmentUploadRequestSchema))
    body: SupportAttachmentUploadRequest,
    @Req() request: SupportRequestContext,
  ): Promise<SupportAttachmentUploadResponse> {
    const userId = await this.caller(request);
    return await this.support.authorizeAttachment({
      userId,
      ticketId: this.identifier(ticketId, 'ticketId'),
      messageId: this.identifier(messageId, 'messageId'),
      contentType: body.contentType,
      byteSize: body.byteSize,
    });
  }

  /** Records the file that was uploaded, at the path the previous operation issued. */
  @Post('tickets/:ticketId/messages/:messageId/attachments')
  @HttpCode(201)
  async recordAttachment(
    @Param('ticketId') ticketId: string,
    @Param('messageId') messageId: string,
    @Body(new ZodValidationPipe(SupportAttachmentRecordSchema)) body: SupportAttachmentRecord,
    @Req() request: SupportRequestContext,
  ): Promise<SupportAttachmentRecordResponse> {
    const userId = await this.caller(request);
    return await this.support.recordAttachment({
      userId,
      ticketId: this.identifier(ticketId, 'ticketId'),
      messageId: this.identifier(messageId, 'messageId'),
      objectPath: body.objectPath,
      originalFilename: body.originalFilename,
      contentType: body.contentType,
      byteSize: body.byteSize,
    });
  }

  /** A short-lived link to one file on one's own ticket. No route here accepts a storage path. */
  @Get('tickets/:ticketId/attachments/:attachmentId/link')
  async attachmentLink(
    @Param('ticketId') ticketId: string,
    @Param('attachmentId') attachmentId: string,
    @Req() request: SupportRequestContext,
  ): Promise<SupportAttachmentLinkResponse> {
    const userId = await this.caller(request);
    return await this.support.attachmentLink({
      userId,
      ticketId: this.identifier(ticketId, 'ticketId'),
      attachmentId: this.identifier(attachmentId, 'attachmentId'),
    });
  }

  /* ---------------------------------------------------------------------------------------------- */

  /** The caller's account, from their own token. The one place this controller learns who is asking. */
  private async caller(request: SupportRequestContext): Promise<string> {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    const user = await this.users.forToken(accessToken);
    return user.id;
  }

  private limit(value: string | undefined, fallback: number, maximum: number): number {
    const parsed = parseMessagingLimit(value, { fallback, maximum });
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
