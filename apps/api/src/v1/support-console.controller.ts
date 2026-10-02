import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  AddSupportInternalNoteSchema,
  PostSupportAgentMessageSchema,
  SESSION_TOKEN_HEADER,
  SUPPORT_CONSOLE_DEFAULT_LIMIT,
  SUPPORT_CONSOLE_MAX_LIMIT,
  SupportAgentDecisionRequestSchema,
  parseMessagingLimit,
  type AddSupportInternalNote,
  type PostSupportAgentMessage,
  type SupportAgentDecisionRequest,
  type SupportAgentDecisionResponse,
  type SupportAssignedResponse,
  type SupportAssignmentResponse,
  type SupportConsoleAttachmentLinkResponse,
  type SupportConsoleMessageMutationResponse,
  type SupportConsoleMessagesResponse,
  type SupportConsoleTicketResponse,
  type SupportInternalNoteMutationResponse,
  type SupportInternalNotesResponse,
  type SupportQueueResponse,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { SupportConsoleService } from '../admin/support-console.service.js';
import { RequestValidationException } from '../common/request-validation.exception.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface ConsoleRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(context: ConsoleRequestContext, name: string): string | null {
  const value = context.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The support agent console (Phase 7-L).
 *
 * Every route here requires a staff session and resolves the caller the same way: the access token is handed
 * to the service, which has the provider validate it, reads the assurance level from that validated token,
 * and asks the database for the caller's effective permissions. **No route accepts an account, a role, a
 * permission, an assurance level or an assignee.** The path parameters are a ticket and an attachment, both
 * of which name rows.
 *
 * **Claiming and releasing carry no body at all**, so one agent cannot be assigned by another: the account
 * comes from the session and the database assigns that account and no other.
 *
 * **The decision route is the only one in the whole API that carries a support status**, and its contract
 * admits `resolved` or `closed` — 0028's own two agent outcomes. There is no reopen route, because nothing in
 * the repository reopens a ticket, and there is no status route, no priority route and no assignee route.
 *
 * **Internal notes live on this controller and on no other.** The read and the write are two operations on
 * one route, both gated in the database on the support keys; nothing in the requester's API can reach the
 * table they use.
 *
 * The controller decides nothing about who may do what. The permission, the assurance level, the assignment
 * rule and both state machines are applied inside migration 0075's functions, which call 0028's writers with
 * the rows locked; restating any of them here would be a second copy of a rule, and the copy without the lock
 * is the one that would be wrong.
 */
@Controller('v1/admin/support')
export class SupportConsoleController {
  constructor(private readonly support: SupportConsoleService) {}

  @Get('queue')
  async queue(
    @Req() request: ConsoleRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<SupportQueueResponse> {
    const page = await this.support.queue({
      accessToken: this.token(request),
      limit: this.limit(limit),
      cursor: this.cursor(cursor),
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Get('assigned')
  async assigned(
    @Req() request: ConsoleRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<SupportAssignedResponse> {
    const page = await this.support.assigned({
      accessToken: this.token(request),
      limit: this.limit(limit),
      cursor: this.cursor(cursor),
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Get('tickets/:ticketId')
  async ticket(
    @Param('ticketId') ticketId: string,
    @Req() request: ConsoleRequestContext,
  ): Promise<SupportConsoleTicketResponse> {
    return {
      ticket: await this.support.ticket({
        accessToken: this.token(request),
        ticketId: this.identifier(ticketId, 'ticketId'),
      }),
    };
  }

  @Get('tickets/:ticketId/messages')
  async messages(
    @Param('ticketId') ticketId: string,
    @Req() request: ConsoleRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<SupportConsoleMessagesResponse> {
    const page = await this.support.messages({
      accessToken: this.token(request),
      ticketId: this.identifier(ticketId, 'ticketId'),
      limit: this.limit(limit),
      cursor: this.cursor(cursor),
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  /** Replies to the requester. The author's role is the database's to decide, not this body's. */
  @Post('tickets/:ticketId/messages')
  @HttpCode(201)
  async reply(
    @Param('ticketId') ticketId: string,
    @Body(new ZodValidationPipe(PostSupportAgentMessageSchema)) body: PostSupportAgentMessage,
    @Req() request: ConsoleRequestContext,
  ): Promise<SupportConsoleMessageMutationResponse> {
    return await this.support.reply({
      accessToken: this.token(request),
      ticketId: this.identifier(ticketId, 'ticketId'),
      body: body.body,
    });
  }

  /** The staff-only side of a ticket. No requester surface can reach this table. */
  @Get('tickets/:ticketId/notes')
  async notes(
    @Param('ticketId') ticketId: string,
    @Req() request: ConsoleRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<SupportInternalNotesResponse> {
    const page = await this.support.notes({
      accessToken: this.token(request),
      ticketId: this.identifier(ticketId, 'ticketId'),
      limit: this.limit(limit),
      cursor: this.cursor(cursor),
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Post('tickets/:ticketId/notes')
  @HttpCode(201)
  async addNote(
    @Param('ticketId') ticketId: string,
    @Body(new ZodValidationPipe(AddSupportInternalNoteSchema)) body: AddSupportInternalNote,
    @Req() request: ConsoleRequestContext,
  ): Promise<SupportInternalNoteMutationResponse> {
    return await this.support.addNote({
      accessToken: this.token(request),
      ticketId: this.identifier(ticketId, 'ticketId'),
      body: body.body,
    });
  }

  /**
   * Takes a ticket from the queue.
   *
   * No body: the account is the session's, so there is no field through which one agent could be assigned by
   * another, and no route here that assigns anybody else.
   */
  @Post('tickets/:ticketId/claim')
  @HttpCode(200)
  async claim(
    @Param('ticketId') ticketId: string,
    @Req() request: ConsoleRequestContext,
  ): Promise<SupportAssignmentResponse> {
    return await this.support.claim({
      accessToken: this.token(request),
      ticketId: this.identifier(ticketId, 'ticketId'),
    });
  }

  /** Returns a ticket the caller holds to the queue. It changes no status. */
  @Post('tickets/:ticketId/release')
  @HttpCode(200)
  async release(
    @Param('ticketId') ticketId: string,
    @Req() request: ConsoleRequestContext,
  ): Promise<SupportAssignmentResponse> {
    return await this.support.release({
      accessToken: this.token(request),
      ticketId: this.identifier(ticketId, 'ticketId'),
    });
  }

  /** Records the agent outcome: `resolved` or `closed`, and nothing else is expressible. */
  @Post('tickets/:ticketId/decision')
  @HttpCode(200)
  async decide(
    @Param('ticketId') ticketId: string,
    @Body(new ZodValidationPipe(SupportAgentDecisionRequestSchema)) body: SupportAgentDecisionRequest,
    @Req() request: ConsoleRequestContext,
  ): Promise<SupportAgentDecisionResponse> {
    return await this.support.decide({
      accessToken: this.token(request),
      ticketId: this.identifier(ticketId, 'ticketId'),
      status: body.status,
    });
  }

  /** A short-lived link to one file. No route here accepts a storage path or a bucket. */
  @Get('tickets/:ticketId/attachments/:attachmentId/link')
  async attachmentLink(
    @Param('ticketId') ticketId: string,
    @Param('attachmentId') attachmentId: string,
    @Req() request: ConsoleRequestContext,
  ): Promise<SupportConsoleAttachmentLinkResponse> {
    return await this.support.attachmentLink({
      accessToken: this.token(request),
      ticketId: this.identifier(ticketId, 'ticketId'),
      attachmentId: this.identifier(attachmentId, 'attachmentId'),
    });
  }

  /* ---------------------------------------------------------------------------------------------- */

  /** The caller's own token, and nothing else this controller knows about them. */
  private token(request: ConsoleRequestContext): string {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    return accessToken;
  }

  private limit(value: string | undefined): number {
    const parsed = parseMessagingLimit(value, {
      fallback: SUPPORT_CONSOLE_DEFAULT_LIMIT,
      maximum: SUPPORT_CONSOLE_MAX_LIMIT,
    });
    if (!parsed.ok) {
      throw new RequestValidationException([{ path: 'limit', message: 'The limit is invalid.' }]);
    }
    return parsed.limit;
  }

  private cursor(value: string | undefined): string | null {
    return value === undefined || value === '' ? null : value;
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
