import { z } from './zod.js';

/**
 * The in-app notification read surface (Phase 7-C): list, unread count, mark read, archive.
 *
 * Four operations and nothing more. There is deliberately no create, no delete, no preference write and
 * no saved-search match — notifications are created by the domains that cause them, through 0029's single
 * writer, and archiving is how a row leaves an inbox.
 *
 * Four shapes here are decisions rather than conveniences.
 *
 *   * **No request names a user.** The caller is resolved from their own session, so there is no
 *     `userId` anywhere below. A schema with one would be a schema somebody could use to read, mark or
 *     archive another person's inbox.
 *   * **The item carries metadata, not prose.** `category`, `eventType`, `subjectType`, `subjectId` and
 *     `actionPath` are the fields migration 0029 defines, passed through unchanged. There is no title and
 *     no body: this project has no in-app template renderer, `public.email_templates` holds no rows, and
 *     inventing a sentence per event type would be inventing the very vocabulary this increment is told
 *     not to invent. The surface renders the metadata it is given.
 *   * **`variables` is absent.** It is a substitution payload for a template that does not exist here, it
 *     is the field 0029 singles out as display-only and secret-free, and sending it would be shipping
 *     data nothing can use. The staff actor, the template key and the email link are absent for the same
 *     family of reasons.
 *   * **Archived is a view, not a flag on an item.** The list is asked for one view or the other, because
 *     that is the split the schema already draws: `notifications_unread` is indexed on unread **and**
 *     unarchived, and `public.unread_notification_count` counts with that same predicate. An item still
 *     reports its own `archivedAt`, so a surface can show when something was archived without having to
 *     infer it.
 */

/** The twelve categories `notifications_category_allowed` permits, and exactly those. */
export const NOTIFICATION_CATEGORIES = [
  'orders',
  'payments',
  'payouts',
  'listings',
  'messages',
  'offers',
  'reviews',
  'promotions',
  'support',
  'security',
  'account',
  'system',
] as const;

export const NotificationCategorySchema = z
  .enum(NOTIFICATION_CATEGORIES)
  .openapi('NotificationCategory');

/** The seventeen subject types `notifications_subject_type_allowed` permits, and exactly those. */
export const NOTIFICATION_SUBJECT_TYPES = [
  'order',
  'checkout',
  'payment',
  'payout',
  'withdrawal',
  'listing',
  'conversation',
  'message',
  'offer',
  'service_request',
  'review',
  'promotion',
  'support_ticket',
  'dispute',
  'report',
  'account_recovery',
  'seller_verification',
] as const;

export const NotificationSubjectTypeSchema = z
  .enum(NOTIFICATION_SUBJECT_TYPES)
  .openapi('NotificationSubjectType');

/**
 * The event type, as its own shape rather than as a list.
 *
 * `notifications_event_type_format` constrains it to a dotted lower-case name and nothing further: the
 * vocabulary is open, and one domain writes into it today. So the contract carries the **shape** the
 * schema enforces and refuses to enumerate what the schema does not — a closed list here would be a
 * vocabulary invented in the contracts package, and it would break the moment a domain added an event.
 */
export const NotificationEventTypeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)
  .openapi('NotificationEventType');

/**
 * A relative path, never a URL.
 *
 * The same rule `notifications_action_path_is_relative` enforces in the database, restated here so a
 * malformed value is refused at the boundary too. A notification can never send somebody to another host.
 */
export const NotificationActionPathSchema = z
  .string()
  .regex(/^\/[A-Za-z0-9/_\-?=&.%]*$/)
  .refine((value) => !value.startsWith('//'), { message: 'An action path is relative to this site.' });

/**
 * One notification, as the surface renders it.
 *
 * `subjectType` and `subjectId` are nullable together, exactly as `notifications_subject_is_complete`
 * pairs them, so a surface never has to handle one without the other.
 */
export const NotificationItemSchema = z
  .object({
    id: z.string().uuid(),
    category: NotificationCategorySchema,
    eventType: NotificationEventTypeSchema,
    subjectType: NotificationSubjectTypeSchema.nullable(),
    subjectId: z.string().uuid().nullable(),
    actionPath: NotificationActionPathSchema.nullable(),
    createdAt: z.string().datetime(),
    readAt: z.string().datetime().nullable(),
    archivedAt: z.string().datetime().nullable(),
  })
  .strict()
  .openapi('NotificationItem');

export const NotificationsResponseSchema = z
  .object({
    items: z.array(NotificationItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('NotificationsResponse');

export const NotificationsUnreadCountResponseSchema = z
  .object({
    unreadCount: z.number().int().min(0),
  })
  .strict()
  .openapi('NotificationsUnreadCountResponse');

/** The page sizes, matching the messaging inbox's: the same kind of list, read the same way. */
export const NOTIFICATIONS_DEFAULT_LIMIT = 20;
export const NOTIFICATIONS_MAX_LIMIT = 50;

/** Which view is being read. Two values, because the schema draws exactly one split. */
export const NOTIFICATION_VIEWS = ['inbox', 'archived'] as const;
export const NotificationViewSchema = z.enum(NOTIFICATION_VIEWS).openapi('NotificationView');

/**
 * How many notifications one request may name.
 *
 * Bounded so a single call cannot be made arbitrarily expensive, and so the request body stays small.
 * A surface marks or archives what is on the page, and a page is at most {@link NOTIFICATIONS_MAX_LIMIT}.
 */
export const NOTIFICATION_IDS_MAX = 50;

const NotificationIdsSchema = z.array(z.string().uuid()).min(1).max(NOTIFICATION_IDS_MAX);

/**
 * Marking notifications read.
 *
 * `ids` absent means **all of them**, which is the "mark everything read" action and is exactly the null
 * form `app_private.mark_notifications_read` has accepted since 0029. `ids` present names specific ones.
 * Either way the operation is idempotent: already-read notifications are not matched, so a repeat changes
 * nothing and succeeds. An identifier belonging to somebody else matches nothing, for the same reason.
 */
export const MarkNotificationsReadRequestSchema = z
  .object({
    ids: NotificationIdsSchema.optional(),
  })
  .strict()
  .openapi('MarkNotificationsReadRequest');

/**
 * Archiving notifications.
 *
 * `ids` is **required** here, unlike marking read: no approved action archives an entire inbox, and a
 * request that can is a request that can be sent by mistake. Idempotent in the same way — an
 * already-archived notification is not matched, so its `archivedAt` never moves.
 */
export const ArchiveNotificationsRequestSchema = z
  .object({
    ids: NotificationIdsSchema,
  })
  .strict()
  .openapi('ArchiveNotificationsRequest');

/**
 * What changed, and what the badge now reads.
 *
 * `changed` is the number of rows that actually moved, which is what makes idempotency observable: a
 * repeat reports zero and is still a success. `unreadCount` comes back so a surface updates its badge
 * from the server's own count rather than by arithmetic on a number it guessed.
 */
export const NotificationsMutationResponseSchema = z
  .object({
    changed: z.number().int().min(0),
    unreadCount: z.number().int().min(0),
  })
  .strict()
  .openapi('NotificationsMutationResponse');

export type NotificationCategory = z.infer<typeof NotificationCategorySchema>;
export type NotificationSubjectType = z.infer<typeof NotificationSubjectTypeSchema>;
export type NotificationView = z.infer<typeof NotificationViewSchema>;
export type NotificationItem = z.infer<typeof NotificationItemSchema>;
export type NotificationsResponse = z.infer<typeof NotificationsResponseSchema>;
export type NotificationsUnreadCountResponse = z.infer<typeof NotificationsUnreadCountResponseSchema>;
export type MarkNotificationsReadRequest = z.infer<typeof MarkNotificationsReadRequestSchema>;
export type ArchiveNotificationsRequest = z.infer<typeof ArchiveNotificationsRequestSchema>;
export type NotificationsMutationResponse = z.infer<typeof NotificationsMutationResponseSchema>;
