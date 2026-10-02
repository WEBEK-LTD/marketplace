import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import {
  ArchiveNotificationsRequestSchema,
  MarkNotificationsReadRequestSchema,
  NOTIFICATIONS_DEFAULT_LIMIT,
  NOTIFICATIONS_MAX_LIMIT,
  SESSION_TOKEN_HEADER,
  parseMessagingLimit,
  type ArchiveNotificationsRequest,
  type MarkNotificationsReadRequest,
  type NotificationView,
  type NotificationsMutationResponse,
  type NotificationsResponse,
  type NotificationsUnreadCountResponse,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { CurrentUserService } from '../users/current-user.service.js';
import { RequestValidationException } from '../common/request-validation.exception.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface NotificationsRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(context: NotificationsRequestContext, name: string): string | null {
  const value = context.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

/**
 * The in-app notification read surface (Phase 7-C): list, unread count, mark read, archive.
 *
 * All four are authenticated, and all four resolve the caller the same way: from their own access token,
 * through {@link CurrentUserService}, which asks the provider whose token it is and then the database
 * whether that account still exists. **No route accepts a user identifier.** There is no parameter,
 * header or body field anywhere below from which a caller could name somebody else, which is what makes
 * the readers' and writers' own scoping a second line rather than the only one.
 *
 * The controller decides nothing about who may read or change what. Ownership is enforced inside the
 * statement in migrations 0029 and 0066, and it is not restated here — restating an authorization rule is
 * how two copies of it start to disagree. A notification belonging to somebody else is therefore not
 * refused by this layer; it is simply never matched, and the response says only how many of the caller's
 * own rows moved.
 *
 * Not here, deliberately: **no create and no delete**. Notifications are written by the domains that
 * cause them, through 0029's single writer, and archiving is how an inbox is cleared — the table's
 * delete trigger refuses the alternative outright.
 */
@Controller('v1/notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly users: CurrentUserService,
  ) {}

  /**
   * One page of the caller's own notifications.
   *
   * `view` chooses the inbox or the archived list. An unrecognised value is a validation failure rather
   * than a silent fallback: a caller who asked for something this API does not have should be told, not
   * quietly shown something else.
   */
  @Get()
  async list(
    @Req() request: NotificationsRequestContext,
    @Query('view') view?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<NotificationsResponse> {
    const userId = await this.caller(request);

    const resolved = this.assertView(view);
    const parsed = parseMessagingLimit(limit, {
      fallback: NOTIFICATIONS_DEFAULT_LIMIT,
      maximum: NOTIFICATIONS_MAX_LIMIT,
    });
    if (!parsed.ok) throw new RequestValidationException([{ path: 'limit', message: 'The limit is invalid.' }]);

    // The refusal for an unusable cursor is raised by the service, where the decoding lives.
    const page = await this.notifications.list({
      userId,
      view: resolved,
      limit: parsed.limit,
      cursor: cursor === undefined || cursor === '' ? null : cursor,
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  /** The badge: unread and not archived, as the schema's own index defines unread. */
  @Get('unread-count')
  async unreadCount(
    @Req() request: NotificationsRequestContext,
  ): Promise<NotificationsUnreadCountResponse> {
    const userId = await this.caller(request);
    return { unreadCount: await this.notifications.unreadCount(userId) };
  }

  /**
   * Marks notifications read, or all of the caller's unread ones when none are named.
   *
   * Idempotent: a notification that is already read is not matched, so `changed` reports zero and the
   * request still succeeds. That is a success and not a conflict — the caller asked for a state, and the
   * state holds.
   */
  @Post('read')
  @HttpCode(200)
  async markRead(
    @Body(new ZodValidationPipe(MarkNotificationsReadRequestSchema)) body: MarkNotificationsReadRequest,
    @Req() request: NotificationsRequestContext,
  ): Promise<NotificationsMutationResponse> {
    const userId = await this.caller(request);
    // `undefined` means "all of them", which is 0029's own null form. The two are kept distinct here so
    // an absent field cannot be confused with an empty list, which the schema refuses outright.
    return await this.notifications.markRead({
      userId,
      ids: body.ids === undefined ? null : body.ids,
    });
  }

  /**
   * Archives the named notifications, removing them from the inbox and the badge.
   *
   * Idempotent in the same way, and always explicit: the schema requires at least one identifier, so
   * there is no request shape that empties an inbox.
   */
  @Post('archive')
  @HttpCode(200)
  async archive(
    @Body(new ZodValidationPipe(ArchiveNotificationsRequestSchema)) body: ArchiveNotificationsRequest,
    @Req() request: NotificationsRequestContext,
  ): Promise<NotificationsMutationResponse> {
    const userId = await this.caller(request);
    return await this.notifications.archive({ userId, ids: body.ids });
  }

  /** The caller's account, from their own token. The one place this controller learns who is asking. */
  private async caller(request: NotificationsRequestContext): Promise<string> {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    const user = await this.users.forToken(accessToken);
    return user.id;
  }

  /** The view, or a validation failure. Two values, because the schema draws exactly one split. */
  private assertView(view: string | undefined): NotificationView {
    if (view === undefined || view === '' || view === 'inbox') return 'inbox';
    if (view === 'archived') return 'archived';
    throw new RequestValidationException([{ path: 'view', message: 'The view is invalid.' }]);
  }
}
