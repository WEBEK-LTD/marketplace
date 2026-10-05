import { describe, expect, it } from 'vitest';
import {
  ArchiveNotificationsRequestSchema,
  MarkNotificationsReadRequestSchema,
  NOTIFICATIONS_DEFAULT_LIMIT,
  NOTIFICATIONS_MAX_LIMIT,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_IDS_MAX,
  NOTIFICATION_SUBJECT_TYPES,
  NotificationItemSchema,
  NotificationsMutationResponseSchema,
  NotificationsResponseSchema,
  NotificationsUnreadCountResponseSchema,
  generateOpenApiDocument,
} from '../src/index.js';

/**
 * The notification contracts (Phase 7-C).
 *
 * Three promises are held here. **No request names a user**, so nothing in this surface can act on
 * somebody else's inbox. **The vocabularies are the schema's**, not this package's — the twelve
 * categories and seventeen subject types are exactly migration 0029's `CHECK` lists, and the event type
 * is carried as the *shape* the schema enforces rather than as a list nobody approved. And **an item
 * carries metadata, never prose or a payload**: no title, no body, no variables, no template key.
 */

const ID = '11111111-1111-4111-8111-111111111111';
const SUBJECT = '22222222-2222-4222-8222-222222222222';

const ITEM = {
  id: ID,
  category: 'messages',
  eventType: 'message.created',
  subjectType: 'message',
  subjectId: SUBJECT,
  actionPath: '/dashboard/messages/abc',
  createdAt: '2026-09-01T10:00:00.000Z',
  readAt: null,
  archivedAt: null,
};

describe('the vocabularies come from the schema', () => {
  it('lists exactly the twelve categories 0029 permits', () => {
    expect([...NOTIFICATION_CATEGORIES]).toEqual([
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
    ]);
    for (const category of NOTIFICATION_CATEGORIES) {
      expect(NotificationItemSchema.safeParse({ ...ITEM, category }).success, category).toBe(true);
    }
    for (const category of ['marketing', 'other', 'Orders', '']) {
      expect(NotificationItemSchema.safeParse({ ...ITEM, category }).success, category).toBe(false);
    }
  });

  it('lists exactly the seventeen subject types 0029 permits', () => {
    expect(NOTIFICATION_SUBJECT_TYPES).toHaveLength(17);
    for (const subjectType of NOTIFICATION_SUBJECT_TYPES) {
      expect(NotificationItemSchema.safeParse({ ...ITEM, subjectType }).success, subjectType).toBe(true);
    }
    for (const subjectType of ['user', 'invoice', 'Order', '']) {
      expect(NotificationItemSchema.safeParse({ ...ITEM, subjectType }).success, subjectType).toBe(false);
    }
  });

  it('carries the event type as a shape, because the schema does not close that list', () => {
    // A closed list here would be a vocabulary invented in the contracts package, and it would refuse
    // the first event a domain added. The schema constrains the format; so does this.
    for (const eventType of ['message.created', 'order.shipped', 'payout.batch.settled']) {
      expect(NotificationItemSchema.safeParse({ ...ITEM, eventType }).success, eventType).toBe(true);
    }
    for (const eventType of ['message', 'Message.Created', '.created', 'message.', 'a b', '']) {
      expect(NotificationItemSchema.safeParse({ ...ITEM, eventType }).success, eventType).toBe(false);
    }
  });
});

describe('a notification item', () => {
  it('accepts the metadata the reader returns', () => {
    expect(NotificationItemSchema.safeParse(ITEM).success).toBe(true);
    expect(
      NotificationItemSchema.safeParse({
        ...ITEM,
        subjectType: null,
        subjectId: null,
        actionPath: null,
        readAt: '2026-09-01T11:00:00.000Z',
        archivedAt: '2026-09-01T12:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('carries no prose, no payload and no account', () => {
    for (const field of [
      'title',
      'body',
      'message',
      'text',
      'variables',
      'templateKey',
      'userId',
      'actorUserId',
      'origin',
      'isMarketing',
      'dedupeKey',
      'emailOutboxId',
      'publishedAt',
    ]) {
      expect(NotificationItemSchema.safeParse({ ...ITEM, [field]: 'x' }).success, field).toBe(false);
    }
  });

  it('keeps an action path relative, so a notification cannot send somebody to another host', () => {
    for (const actionPath of ['/dashboard', '/', '/a/b?c=d&e=f']) {
      expect(NotificationItemSchema.safeParse({ ...ITEM, actionPath }).success, actionPath).toBe(true);
    }
    for (const actionPath of [
      'https://evil.test/x',
      '//evil.test/x',
      'dashboard',
      'javascript:alert(1)',
      '',
    ]) {
      expect(NotificationItemSchema.safeParse({ ...ITEM, actionPath }).success, actionPath).toBe(false);
    }
  });
});

describe('the list response', () => {
  it('is items and a cursor, and nothing else', () => {
    expect(NotificationsResponseSchema.safeParse({ items: [ITEM], nextCursor: null }).success).toBe(true);
    expect(NotificationsResponseSchema.safeParse({ items: [], nextCursor: 'abc' }).success).toBe(true);
    for (const field of ['total', 'unreadCount', 'userId', 'view']) {
      expect(
        NotificationsResponseSchema.safeParse({ items: [], nextCursor: null, [field]: 1 }).success,
        field,
      ).toBe(false);
    }
  });

  it('uses the same page sizes the messaging inbox uses', () => {
    expect(NOTIFICATIONS_DEFAULT_LIMIT).toBe(20);
    expect(NOTIFICATIONS_MAX_LIMIT).toBe(50);
  });
});

describe('the unread count', () => {
  it('is one non-negative integer and nothing else', () => {
    expect(NotificationsUnreadCountResponseSchema.safeParse({ unreadCount: 0 }).success).toBe(true);
    expect(NotificationsUnreadCountResponseSchema.safeParse({ unreadCount: -1 }).success).toBe(false);
    expect(NotificationsUnreadCountResponseSchema.safeParse({ unreadCount: 1.5 }).success).toBe(false);
    expect(
      NotificationsUnreadCountResponseSchema.safeParse({ unreadCount: 1, archivedCount: 2 }).success,
    ).toBe(false);
  });
});

describe('marking read', () => {
  it('names specific notifications, or none at all to mean all of them', () => {
    expect(MarkNotificationsReadRequestSchema.safeParse({}).success).toBe(true);
    expect(MarkNotificationsReadRequestSchema.safeParse({ ids: [ID] }).success).toBe(true);
    // An empty array is refused: it means nothing, and accepting it would make "name none" ambiguous
    // with "mark everything".
    expect(MarkNotificationsReadRequestSchema.safeParse({ ids: [] }).success).toBe(false);
  });

  it('names no user, ever', () => {
    for (const field of ['userId', 'accountId', 'ownerId']) {
      expect(MarkNotificationsReadRequestSchema.safeParse({ [field]: ID }).success, field).toBe(false);
    }
  });

  it('bounds how many can be named at once', () => {
    const many = Array.from({ length: NOTIFICATION_IDS_MAX }, () => ID);
    expect(MarkNotificationsReadRequestSchema.safeParse({ ids: many }).success).toBe(true);
    expect(MarkNotificationsReadRequestSchema.safeParse({ ids: [...many, ID] }).success).toBe(false);
  });

  it('refuses an identifier that is not one', () => {
    for (const bad of ['not-a-uuid', '', "' or 1=1", '../..']) {
      expect(MarkNotificationsReadRequestSchema.safeParse({ ids: [bad] }).success, bad).toBe(false);
    }
  });
});

describe('archiving', () => {
  it('requires the identifiers, because no action archives a whole inbox', () => {
    expect(ArchiveNotificationsRequestSchema.safeParse({ ids: [ID] }).success).toBe(true);
    expect(ArchiveNotificationsRequestSchema.safeParse({}).success).toBe(false);
    expect(ArchiveNotificationsRequestSchema.safeParse({ ids: [] }).success).toBe(false);
  });

  it('names no user and bounds the batch, exactly as marking read does', () => {
    expect(ArchiveNotificationsRequestSchema.safeParse({ ids: [ID], userId: ID }).success).toBe(false);
    const many = Array.from({ length: NOTIFICATION_IDS_MAX + 1 }, () => ID);
    expect(ArchiveNotificationsRequestSchema.safeParse({ ids: many }).success).toBe(false);
  });
});

describe('the mutation response', () => {
  it('reports what moved and what the badge now reads', () => {
    expect(NotificationsMutationResponseSchema.safeParse({ changed: 0, unreadCount: 3 }).success).toBe(
      true,
    );
    // Zero is a success, which is what makes idempotency observable rather than merely claimed.
    expect(NotificationsMutationResponseSchema.safeParse({ changed: -1, unreadCount: 0 }).success).toBe(
      false,
    );
    for (const field of ['ids', 'items', 'userId', 'archivedCount']) {
      expect(
        NotificationsMutationResponseSchema.safeParse({ changed: 1, unreadCount: 0, [field]: 'x' })
          .success,
        field,
      ).toBe(false);
    }
  });
});

describe('the documented operations', () => {
  const doc = generateOpenApiDocument();
  const paths = [
    '/v1/notifications',
    '/v1/notifications/unread-count',
    '/v1/notifications/read',
    '/v1/notifications/archive',
  ];

  it('documents exactly four: two reads and two writes', () => {
    expect(Object.keys(doc.paths?.['/v1/notifications'] ?? {})).toEqual(['get']);
    expect(Object.keys(doc.paths?.['/v1/notifications/unread-count'] ?? {})).toEqual(['get']);
    expect(Object.keys(doc.paths?.['/v1/notifications/read'] ?? {})).toEqual(['post']);
    expect(Object.keys(doc.paths?.['/v1/notifications/archive'] ?? {})).toEqual(['post']);
    expect(
      Object.keys(doc.paths ?? {}).filter((path) => path.startsWith('/v1/notifications')),
    ).toHaveLength(4);
  });

  it('documents no way to create or delete a notification', () => {
    // Creation belongs to the domains that cause notifications, through 0029's single writer; clearing
    // an inbox is archiving. Both absences are asserted so adding either has to be deliberate.
    for (const path of paths) {
      expect(Object.keys(doc.paths?.[path] ?? {}), path).not.toContain('delete');
      expect(Object.keys(doc.paths?.[path] ?? {}), path).not.toContain('put');
      expect(Object.keys(doc.paths?.[path] ?? {}), path).not.toContain('patch');
    }
    const all = Object.keys(doc.paths ?? {}).join(' ');
    expect(all).not.toContain('/v1/notifications/saved-search');
    expect(all).not.toContain('/v1/notifications/preferences');
  });

  it('requires the caller’s session on every one of them', () => {
    for (const path of paths) {
      const operation = doc.paths?.[path]?.get ?? doc.paths?.[path]?.post;
      const responses = Object.keys(operation?.responses ?? {});
      expect(responses, path).toContain('401');
      expect(responses, path).toContain('403');
      expect(responses, path).toContain('503');
    }
  });

  it('declares the cursor refusal on the list alone', () => {
    expect(Object.keys(doc.paths?.['/v1/notifications']?.get?.responses ?? {})).toContain('400');
    // Nothing else takes a cursor, so nothing else can refuse one.
    expect(
      Object.keys(doc.paths?.['/v1/notifications/unread-count']?.get?.responses ?? {}),
    ).not.toContain('400');
  });

  it('says in its own prose what it never accepts and never returns', () => {
    const prose = paths
      .map((path) => {
        const operation = doc.paths?.[path]?.get ?? doc.paths?.[path]?.post;
        return `${operation?.summary ?? ''} ${operation?.description ?? ''}`;
      })
      .join(' ');
    expect(prose).toMatch(/no identifier is accepted from the request/i);
    expect(prose).toMatch(/never the template variables/i);
    expect(prose).toMatch(/Idempotent/);
    expect(prose).toMatch(/Nothing is ever deleted/i);
  });
});
