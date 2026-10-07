import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  NotificationCategory,
  NotificationItem,
  NotificationSubjectType,
  NotificationView,
  ProblemCode,
} from '@repo/contracts';
import {
  decodeNotificationsCursor,
  encodeNotificationsCursor,
} from './notifications-cursor.js';

/**
 * The cursor could not be used (Phase 7-C).
 *
 * One code for a malformed cursor, a tampered one and one from a version this API no longer reads,
 * exactly as messaging has one: the client's remedy is identical in all three — drop it and start again —
 * and naming which structural check failed would only help somebody mapping the format.
 */
export class InvalidNotificationsCursorError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'NOTIFICATIONS_CURSOR_INVALID',
  };

  constructor() {
    super('The list position could not be used.');
    this.name = 'InvalidNotificationsCursorError';
  }
}

/** The reader or the writer could not be reached. Never rendered as an empty inbox. */
export class NotificationsUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(override readonly cause: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'NotificationsUnavailableError';
  }
}

/** One row of `app_private.notifications_inbox`, as the driver returns it. */
export interface NotificationRow {
  readonly id: string;
  readonly category: string;
  readonly eventType: string;
  readonly subjectType: string | null;
  readonly subjectId: string | null;
  readonly actionPath: string | null;
  readonly createdAt: Date;
  readonly readAt: Date | null;
  readonly archivedAt: Date | null;
}

export interface NotificationsStore {
  /** `app_private.notifications_inbox(uuid, integer, timestamptz, uuid, boolean)`. */
  notificationsInbox(input: {
    userId: string;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
    archived: boolean;
  }): Promise<readonly NotificationRow[]>;

  /** `app_private.notifications_unread_count(uuid)`. */
  notificationsUnreadCount(userId: string): Promise<string>;

  /** `app_private.mark_notifications_read(uuid, uuid[])` — 0029's writer, reused unchanged. */
  markNotificationsRead(input: { userId: string; ids: readonly string[] | null }): Promise<number>;

  /** `app_private.archive_notifications(uuid, uuid[])`. */
  archiveNotifications(input: { userId: string; ids: readonly string[] }): Promise<number>;
}

export const NOTIFICATIONS_STORE = Symbol('NOTIFICATIONS_STORE');

export interface NotificationsPage {
  readonly items: readonly NotificationItem[];
  readonly nextCursor: string | null;
}

/** What a mutation changed, and the badge as it now stands. */
export interface NotificationsMutation {
  readonly changed: number;
  readonly unreadCount: number;
}

/** ISO-8601 for a timestamp, or null. The only date formatting this service does. */
function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/**
 * The in-app notification read surface (Phase 7-C).
 *
 * Every question of authority is answered by migration 0066 and by 0029 before it: which notifications
 * belong to the caller, which of them are unread, which may be marked and which may be archived. **None
 * of it is re-decided here.** This layer decodes and encodes the opaque cursor, converts rows into the
 * shared contract, and turns a database failure into the approved 503 — and that is the whole of it.
 *
 * Three properties are worth stating because they are what the tests hold onto.
 *
 * **The caller is never named by a request.** `userId` is always the value the API resolved from the
 * caller's own access token before this service was reached. No method takes a user identifier from
 * anywhere else, and every reader and writer puts that account in its own predicate — so a notification
 * belonging to somebody else is *absent from the result*, not refused from it. There is nothing here to
 * leak, because there is no branch that could tell the two apart.
 *
 * **A mutation reports what moved, and re-reads the badge.** `changed` is the row count the writer
 * returned, which makes idempotency observable: a repeat reports zero and is still a success. The unread
 * count comes from the database after the write rather than from arithmetic, so the badge a surface shows
 * is the database's own answer and not this layer's guess about what it did.
 *
 * **The item is metadata.** No title, no body, no variables. This project has no in-app template renderer
 * and the notification templates table holds no rows; a surface renders what the schema defines — the
 * category, the event type, the subject and the relative action path — and inventing a sentence per event
 * type here would be inventing the vocabulary itself.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(@Inject(NOTIFICATIONS_STORE) private readonly store: NotificationsStore) {}

  /**
   * One page of the caller's notifications.
   *
   * The page is read one row longer than asked for. If that extra row exists there is more to come, and
   * the cursor is built from the last row the caller actually receives — so `nextCursor` is null exactly
   * when the page is the last one, rather than one request later.
   */
  async list(input: {
    userId: string;
    view: NotificationView;
    limit: number;
    cursor: string | null;
  }): Promise<NotificationsPage> {
    let position = null as { createdAt: Date; notificationId: string } | null;
    if (input.cursor !== null) {
      position = decodeNotificationsCursor(input.cursor);
      if (position === null) throw new InvalidNotificationsCursorError();
    }

    let rows: readonly NotificationRow[];
    try {
      rows = await this.store.notificationsInbox({
        userId: input.userId,
        // One more than asked for: the extra row is how "is there another page?" is answered without a
        // count. The reader's ceiling is the public maximum plus one so this row survives the clamp (0106).
        limit: input.limit + 1,
        cursorCreatedAt: position?.createdAt ?? null,
        cursorId: position?.notificationId ?? null,
        archived: input.view === 'archived',
      });
    } catch (error) {
      this.logger.error('A notification list could not be read.');
      throw new NotificationsUnavailableError(error);
    }

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map((row) => this.toItem(row)),
      nextCursor:
        hasMore && last !== undefined
          ? encodeNotificationsCursor({ createdAt: last.createdAt, notificationId: last.id })
          : null,
    };
  }

  /** The badge: unread and not archived, which is the predicate the schema's own index carries. */
  async unreadCount(userId: string): Promise<number> {
    let raw: string;
    try {
      raw = await this.store.notificationsUnreadCount(userId);
    } catch (error) {
      this.logger.error('An unread notification count could not be read.');
      throw new NotificationsUnavailableError(error);
    }
    return this.count(raw);
  }

  /**
   * Marks notifications read, or all of the caller's unread ones when none are named.
   *
   * `ids` of null is 0029's own "all of them" form, which is what the mark-everything action needs. The
   * writer excludes archived rows, and this service does not add a rule of its own on top of that.
   */
  async markRead(input: { userId: string; ids: readonly string[] | null }): Promise<NotificationsMutation> {
    let changed: number;
    try {
      changed = await this.store.markNotificationsRead({ userId: input.userId, ids: input.ids });
    } catch (error) {
      this.logger.error('Notifications could not be marked read.');
      throw new NotificationsUnavailableError(error);
    }
    return { changed, unreadCount: await this.unreadCount(input.userId) };
  }

  /**
   * Archives the named notifications.
   *
   * Always explicit identifiers: there is no form of this that empties an inbox. An identifier belonging
   * to somebody else matches nothing, so a mixed list archives exactly the caller's own — and `changed`
   * says how many that was, which is the only thing the caller learns about the rest.
   */
  async archive(input: { userId: string; ids: readonly string[] }): Promise<NotificationsMutation> {
    let changed: number;
    try {
      changed = await this.store.archiveNotifications({ userId: input.userId, ids: input.ids });
    } catch (error) {
      this.logger.error('Notifications could not be archived.');
      throw new NotificationsUnavailableError(error);
    }
    return { changed, unreadCount: await this.unreadCount(input.userId) };
  }

  /**
   * A `bigint` count as a number, or a failure.
   *
   * Silently truncating would turn an impossible number into a plausible wrong one, so a value a double
   * cannot hold exactly is treated as a disagreement between this service and the reader rather than
   * rounded into the response.
   */
  private count(value: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new NotificationsUnavailableError(new Error('unreadable count'));
    }
    return parsed;
  }

  /**
   * One row as the contract's item.
   *
   * The category and subject type are narrowed to the contract's enums, which are the schema's own
   * `CHECK` lists. A value outside them cannot exist in the table — the constraint sees to that — so this
   * is a type narrowing rather than a validation, and it is written as a cast with that stated rather
   * than as a check whose failure branch could never run.
   */
  private toItem(row: NotificationRow): NotificationItem {
    return {
      id: row.id,
      category: row.category as NotificationCategory,
      eventType: row.eventType,
      subjectType: row.subjectType === null ? null : (row.subjectType as NotificationSubjectType),
      subjectId: row.subjectId,
      actionPath: row.actionPath,
      createdAt: row.createdAt.toISOString(),
      readAt: iso(row.readAt),
      archivedAt: iso(row.archivedAt),
    };
  }
}
