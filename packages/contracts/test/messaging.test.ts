import { describe, expect, it } from 'vitest';
import {
  AvailableListingReferenceSchema,
  CONVERSATION_ENTRY_POINTS,
  FileMessagingReportRequestSchema,
  FileMessagingReportResponseSchema,
  MESSAGING_REPORT_SUBJECTS,
  REPORT_REASON_CODES,
  CloseConversationResponseSchema,
  LeaveConversationResponseSchema,
  MESSAGE_BODY_MAX_LENGTH,
  MarkReadRequestSchema,
  MarkReadResponseSchema,
  SendMessageRequestSchema,
  SendMessageResponseSchema,
  SetMutedRequestSchema,
  StartConversationRequestSchema,
  StartConversationResponseSchema,
  ConversationMessagesResponseSchema,
  InboxItemSchema,
  ListingReferenceSchema,
  MESSAGING_INBOX_DEFAULT_LIMIT,
  MESSAGING_INBOX_MAX_LIMIT,
  MESSAGING_MESSAGES_DEFAULT_LIMIT,
  MESSAGING_MESSAGES_MAX_LIMIT,
  MessageItemSchema,
  MessagingInboxResponseSchema,
  PROBLEM_CODES,
  UnavailableListingReferenceSchema,
  UnreadCountResponseSchema,
  generateOpenApiDocument,
  parseMessagingLimit,
} from '../src/index.js';

/**
 * The messaging read contracts (Phase 5-C).
 *
 * These schemas exist to make a drifting response a clean failure, so the assertions are mostly about
 * refusal: a field the reader does not return, a vocabulary the database does not use, an attachment
 * shape that belongs to a later increment, and — the one that matters most — a URL or a price on a
 * listing that is no longer available.
 */

const INBOX_ITEM = {
  conversationId: 'e0000000-0000-4000-8000-000000000001',
  subjectType: 'listing',
  listingId: '11110000-0000-4000-8000-000000000001',
  listingTitleSnapshot: 'Walnut dining table',
  membershipState: 'active',
  isMuted: false,
  isClosed: false,
  closedAt: null,
  unreadCount: 3,
  lastMessageId: 'a1000000-0000-4000-8000-000000000005',
  lastMessageSeq: '5',
  lastMessageAt: '2026-09-24T18:30:00.000Z',
  lastMessageType: 'system',
  lastMessageBody: 'The listing was updated.',
  lastMessageSenderUserId: null,
  lastMessageDeletedAt: null,
  createdAt: '2026-09-20T10:00:00.000Z',
};

const MESSAGE_ITEM = {
  id: 'a1000000-0000-4000-8000-000000000001',
  seq: '1',
  conversationId: 'e0000000-0000-4000-8000-000000000001',
  senderUserId: '22222222-2222-4222-8222-222222222222',
  isOwnMessage: false,
  messageType: 'text',
  body: 'Hello',
  referenceType: null,
  referenceId: null,
  createdAt: '2026-09-24T18:00:00.000Z',
  editedAt: null,
  deletedAt: null,
  // 0104. Required and usually empty, so a surface never has to tell "no files" from "field missing".
  attachments: [],
};

describe('the inbox item', () => {
  it('accepts the projection migration 0053 returns', () => {
    expect(InboxItemSchema.parse(INBOX_ITEM)).toEqual(INBOX_ITEM);
  });

  it('accepts a conversation with no messages, where the whole summary is null', () => {
    const empty = {
      ...INBOX_ITEM,
      subjectType: 'direct',
      listingId: null,
      listingTitleSnapshot: null,
      unreadCount: 0,
      lastMessageId: null,
      lastMessageSeq: null,
      lastMessageAt: null,
      lastMessageType: null,
      lastMessageBody: null,
      lastMessageSenderUserId: null,
      lastMessageDeletedAt: null,
    };
    expect(InboxItemSchema.safeParse(empty).success).toBe(true);
  });

  it('refuses a field the reader does not return', () => {
    for (const extra of [
      { otherParticipantEmail: 'x@test.invalid' },
      { lastReadSeq: '3' },
      { attachments: [] },
      { sellerUserId: '22222222-2222-4222-8222-222222222222' },
    ]) {
      expect(InboxItemSchema.safeParse({ ...INBOX_ITEM, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it('refuses a subject type outside the 0014 vocabulary', () => {
    expect(InboxItemSchema.safeParse({ ...INBOX_ITEM, subjectType: 'dispute' }).success).toBe(false);
  });

  it('refuses a membership state outside the two the reader can produce', () => {
    expect(InboxItemSchema.safeParse({ ...INBOX_ITEM, membershipState: 'pending' }).success).toBe(false);
  });

  it('carries a sequence as digits, never as a number', () => {
    expect(InboxItemSchema.safeParse({ ...INBOX_ITEM, lastMessageSeq: 5 }).success).toBe(false);
    expect(InboxItemSchema.safeParse({ ...INBOX_ITEM, lastMessageSeq: '05' }).success).toBe(false);
    expect(InboxItemSchema.safeParse({ ...INBOX_ITEM, lastMessageSeq: '0' }).success).toBe(false);
  });

  it('refuses a negative or fractional unread count', () => {
    expect(InboxItemSchema.safeParse({ ...INBOX_ITEM, unreadCount: -1 }).success).toBe(false);
    expect(InboxItemSchema.safeParse({ ...INBOX_ITEM, unreadCount: 1.5 }).success).toBe(false);
  });

  it('wraps into a page with a nullable cursor and nothing else', () => {
    expect(MessagingInboxResponseSchema.safeParse({ items: [INBOX_ITEM], nextCursor: null }).success).toBe(true);
    expect(MessagingInboxResponseSchema.safeParse({ items: [], nextCursor: 'abc' }).success).toBe(true);
    expect(MessagingInboxResponseSchema.safeParse({ items: [], nextCursor: null, total: 0 }).success).toBe(false);
  });
});

describe('the message item', () => {
  it('accepts the projection migration 0053 returns', () => {
    expect(MessageItemSchema.parse(MESSAGE_ITEM)).toEqual(MESSAGE_ITEM);
  });

  it('accepts a reference message and a system message', () => {
    const reference = {
      ...MESSAGE_ITEM,
      messageType: 'reference',
      body: null,
      referenceType: 'listing',
      referenceId: '11110000-0000-4000-8000-000000000001',
    };
    const system = { ...MESSAGE_ITEM, messageType: 'system', senderUserId: null, isOwnMessage: false };
    expect(MessageItemSchema.safeParse(reference).success).toBe(true);
    expect(MessageItemSchema.safeParse(system).success).toBe(true);
  });

  /**
   * Reversed by 0104, which built the operations 5-D deferred.
   *
   * 5-D recorded that this contract deliberately could not describe an attachment, because describing one
   * would have been the first half of building them. They are built, so the field exists — and the rules that
   * survive are the ones that were never about the field's presence: it is **required**, so a response cannot
   * omit it, and it describes a file without describing where the file is.
   */
  it('has an attachments field that is required, and carries no storage detail', () => {
    expect(Object.keys(MessageItemSchema.shape)).toContain('attachments');

    const { attachments: _omitted, ...without } = MESSAGE_ITEM;
    expect(MessageItemSchema.safeParse(without).success).toBe(false);

    expect(MessageItemSchema.safeParse({ ...MESSAGE_ITEM, attachmentCount: 0 }).success).toBe(false);
    expect(
      MessageItemSchema.safeParse({
        ...MESSAGE_ITEM,
        attachments: [
          {
            id: 'b2000000-0000-4000-8000-000000000001',
            contentType: 'image/png',
            byteSize: '1000',
            objectPath: 'message-attachments/a/b/c.png',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('refuses a message type or reference type outside the 0014 vocabularies', () => {
    expect(MessageItemSchema.safeParse({ ...MESSAGE_ITEM, messageType: 'image' }).success).toBe(false);
    expect(MessageItemSchema.safeParse({ ...MESSAGE_ITEM, referenceType: 'invoice' }).success).toBe(false);
  });

  it('wraps into a page with a nullable cursor', () => {
    expect(
      ConversationMessagesResponseSchema.safeParse({ items: [MESSAGE_ITEM], nextCursor: null }).success,
    ).toBe(true);
    expect(
      ConversationMessagesResponseSchema.safeParse({ items: [], nextCursor: null, hasMore: false }).success,
    ).toBe(false);
  });
});

describe('the unread count response', () => {
  it('is one number and nothing else', () => {
    expect(UnreadCountResponseSchema.parse({ unreadCount: 4 })).toEqual({ unreadCount: 4 });
    expect(UnreadCountResponseSchema.safeParse({ unreadCount: 4, conversations: 2 }).success).toBe(false);
    expect(UnreadCountResponseSchema.safeParse({ unreadCount: '4' }).success).toBe(false);
  });
});

describe('a listing reference', () => {
  const available = {
    status: 'available',
    id: '11110000-0000-4000-8000-000000000001',
    slug: 'walnut-table',
    canonicalType: 'product',
    title: 'Walnut dining table',
    priceMinor: '250000',
    currencyCode: 'EGP',
    currencyMinorUnit: 2,
  };
  const unavailable = {
    status: 'no_longer_available',
    id: '11110000-0000-4000-8000-000000000002',
    title: 'Sold oak chair',
  };

  it('accepts the available projection with the fields 0053 returns', () => {
    expect(AvailableListingReferenceSchema.parse(available)).toEqual(available);
    expect(ListingReferenceSchema.safeParse(available).success).toBe(true);
  });

  it('names the surface its canonical URL belongs to, and carries no URL itself', () => {
    expect(Object.keys(AvailableListingReferenceSchema.shape)).not.toContain('url');
    expect(AvailableListingReferenceSchema.safeParse({ ...available, canonicalType: 'listing' }).success).toBe(false);
    expect(AvailableListingReferenceSchema.safeParse({ ...available, canonicalType: 'service' }).success).toBe(true);
  });

  it('accepts the unavailable projection, including a withheld title', () => {
    expect(UnavailableListingReferenceSchema.parse(unavailable)).toEqual(unavailable);
    expect(UnavailableListingReferenceSchema.safeParse({ ...unavailable, title: null }).success).toBe(true);
    expect(ListingReferenceSchema.safeParse(unavailable).success).toBe(true);
  });

  it('gives the unavailable shape nowhere to put a URL, a price or a seller', () => {
    for (const leak of [
      { slug: 'sold-chair' },
      { url: '/listing/sold-chair' },
      { canonicalType: 'product' },
      { priceMinor: '90000' },
      { currencyCode: 'EGP' },
      { currencyMinorUnit: 2 },
      { sellerUserId: '22222222-2222-4222-8222-222222222222' },
      { media: [] },
      { moderationStatus: 'removed' },
    ]) {
      expect(UnavailableListingReferenceSchema.safeParse({ ...unavailable, ...leak }).success, JSON.stringify(leak)).toBe(false);
      expect(ListingReferenceSchema.safeParse({ ...unavailable, ...leak }).success, JSON.stringify(leak)).toBe(false);
    }
  });

  it('discriminates on status, so neither shape can be mistaken for the other', () => {
    expect(ListingReferenceSchema.safeParse({ ...available, status: 'no_longer_available' }).success).toBe(false);
    expect(ListingReferenceSchema.safeParse({ ...unavailable, status: 'available' }).success).toBe(false);
  });
});

describe('the limit parser', () => {
  const inbox = { fallback: MESSAGING_INBOX_DEFAULT_LIMIT, maximum: MESSAGING_INBOX_MAX_LIMIT };
  const messages = { fallback: MESSAGING_MESSAGES_DEFAULT_LIMIT, maximum: MESSAGING_MESSAGES_MAX_LIMIT };

  it('falls back to the default when absent', () => {
    for (const absent of [undefined, null, '']) {
      expect(parseMessagingLimit(absent, inbox)).toEqual({ ok: true, limit: 20 });
      expect(parseMessagingLimit(absent, messages)).toEqual({ ok: true, limit: 50 });
    }
  });

  it('clamps an oversized value down to the maximum rather than refusing it', () => {
    expect(parseMessagingLimit('500', inbox)).toEqual({ ok: true, limit: 50 });
    expect(parseMessagingLimit('9999', messages)).toEqual({ ok: true, limit: 100 });
  });

  it('accepts a value inside the range unchanged', () => {
    expect(parseMessagingLimit('7', inbox)).toEqual({ ok: true, limit: 7 });
    expect(parseMessagingLimit('100', messages)).toEqual({ ok: true, limit: 100 });
  });

  it('refuses anything that is not a whole positive number', () => {
    for (const bad of ['0', '-1', '1.5', 'ten', ' 5', '05', '99999', 5]) {
      expect(parseMessagingLimit(bad, inbox), JSON.stringify(bad)).toEqual({ ok: false });
    }
  });
});

describe('the messaging problem codes', () => {
  it('live inside the one existing envelope', () => {
    expect(PROBLEM_CODES).toContain('MESSAGING_CURSOR_INVALID');
    expect(PROBLEM_CODES).toContain('MESSAGING_CONVERSATION_NOT_FOUND');
  });

  it('and no second envelope was introduced', () => {
    const doc = generateOpenApiDocument();
    const schemas = Object.keys(doc.components?.schemas ?? {});
    expect(schemas).toContain('ProblemDetails');
    expect(schemas.filter((name) => name.toLowerCase().includes('error'))).toEqual([]);
  });
});

describe('the documented messaging operations', () => {
  const doc = generateOpenApiDocument();

  /** Extended once, by 0104's three attachment operations. The inventory is still exhaustive. */
  it('are exactly the approved reads, writes, the one report and 0104’s three attachment operations', () => {
    const messaging = Object.keys(doc.paths ?? {}).filter((path) => path.startsWith('/v1/messaging'));
    expect(messaging.sort()).toEqual([
      '/v1/messaging/conversations',
      '/v1/messaging/conversations/{conversationId}/attachments/{attachmentId}/link',
      '/v1/messaging/conversations/{conversationId}/closed',
      '/v1/messaging/conversations/{conversationId}/membership',
      '/v1/messaging/conversations/{conversationId}/messages',
      '/v1/messaging/conversations/{conversationId}/messages/{messageId}/attachments',
      '/v1/messaging/conversations/{conversationId}/messages/{messageId}/attachments/uploads',
      '/v1/messaging/conversations/{conversationId}/muted',
      '/v1/messaging/conversations/{conversationId}/read',
      '/v1/messaging/reports',
      '/v1/messaging/unread-count',
    ]);
  });

  it('never document a request body on a read', () => {
    for (const path of ['/v1/messaging/conversations', '/v1/messaging/unread-count']) {
      expect(doc.paths?.[path]?.get?.requestBody, path).toBeUndefined();
    }
    expect(
      doc.paths?.['/v1/messaging/conversations/{conversationId}/messages']?.get?.requestBody,
    ).toBeUndefined();
  });

  it('expose no edit, delete-message, or reopen operation anywhere', () => {
    const messaging = Object.keys(doc.paths ?? {}).filter((path) => path.startsWith('/v1/messaging'));
    for (const path of messaging) {
      const methods = Object.keys(doc.paths?.[path] ?? {});
      expect(methods, path).not.toContain('patch');
      // The one DELETE is the caller's own membership; no message or conversation is ever deleted.
      if (methods.includes('delete')) expect(path).toContain('/membership');
    }
    expect(messaging.some((path) => path.includes('reopen'))).toBe(false);
  });

  it('carry their operation ids', () => {
    expect(doc.paths?.['/v1/messaging/conversations']?.get?.operationId).toBe('getV1MessagingConversations');
    expect(doc.paths?.['/v1/messaging/conversations/{conversationId}/messages']?.get?.operationId).toBe(
      'getV1MessagingConversationMessages',
    );
    expect(doc.paths?.['/v1/messaging/unread-count']?.get?.operationId).toBe('getV1MessagingUnreadCount');
  });
});

/**
 * The messaging write contracts (Phase 5-E).
 *
 * Every schema here is `.strict()`, and that is the point: these are the shapes a browser can post, so
 * the assertions are about what cannot be posted. Nobody can name a sender. Nobody can name a message
 * type, a reference or an attachment. Nobody can name a seller by identifier — only by the public slug,
 * because the public seller profile has no identifier in it to name.
 */
describe('the write requests', () => {
  const LISTING = '11110000-0000-4000-8000-000000000001';

  it('accept exactly the two approved entry points', () => {
    expect([...CONVERSATION_ENTRY_POINTS]).toEqual(['listing', 'direct']);
    expect(
      StartConversationRequestSchema.safeParse({ subjectType: 'listing', listingId: LISTING }).success,
    ).toBe(true);
    expect(
      StartConversationRequestSchema.safeParse({ subjectType: 'direct', sellerSlug: 'good-shop' }).success,
    ).toBe(true);
  });

  it('refuse every other subject type, including ones the database knows', () => {
    for (const subjectType of ['service_request', 'order', 'dispute', 'support', '']) {
      expect(
        StartConversationRequestSchema.safeParse({ subjectType, listingId: LISTING }).success,
        subjectType,
      ).toBe(false);
    }
  });

  it('refuse a seller named by identifier rather than by public slug', () => {
    expect(
      StartConversationRequestSchema.safeParse({
        subjectType: 'direct',
        sellerUserId: '22222222-2222-4222-8222-222222222222',
      }).success,
    ).toBe(false);
    expect(
      StartConversationRequestSchema.safeParse({
        subjectType: 'direct',
        sellerSlug: 'good-shop',
        sellerUserId: '22222222-2222-4222-8222-222222222222',
      }).success,
    ).toBe(false);
  });

  it('refuse an entry point that carries the other one’s field, or both', () => {
    for (const request of [
      { subjectType: 'listing', sellerSlug: 'good-shop' },
      { subjectType: 'direct', listingId: LISTING },
      { subjectType: 'listing', listingId: LISTING, sellerSlug: 'good-shop' },
      { subjectType: 'listing', listingId: 'not-a-uuid' },
      { subjectType: 'direct', sellerSlug: '' },
    ]) {
      expect(StartConversationRequestSchema.safeParse(request).success, JSON.stringify(request)).toBe(
        false,
      );
    }
  });

  it('let a message carry a body and nothing else', () => {
    expect(SendMessageRequestSchema.safeParse({ body: 'Still available?' }).success).toBe(true);
    for (const extra of [
      { senderUserId: '22222222-2222-4222-8222-222222222222' },
      { messageType: 'system' },
      { referenceType: 'listing' },
      { referenceId: LISTING },
      { attachments: [] },
      { seq: '5' },
      { conversationId: 'e0000000-0000-4000-8000-000000000001' },
    ]) {
      expect(
        SendMessageRequestSchema.safeParse({ body: 'hello', ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it('hold a message body to the same 1..5000 the database does', () => {
    expect(MESSAGE_BODY_MAX_LENGTH).toBe(5000);
    expect(SendMessageRequestSchema.safeParse({ body: '' }).success).toBe(false);
    expect(SendMessageRequestSchema.safeParse({ body: 'x' }).success).toBe(true);
    expect(SendMessageRequestSchema.safeParse({ body: 'x'.repeat(5000) }).success).toBe(true);
    expect(SendMessageRequestSchema.safeParse({ body: 'x'.repeat(5001) }).success).toBe(false);
  });

  it('take a read marker as a digit-string sequence, never a number', () => {
    expect(MarkReadRequestSchema.safeParse({ seq: '5' }).success).toBe(true);
    for (const seq of [5, '0', '-1', '1.5', '', 'five', null]) {
      expect(MarkReadRequestSchema.safeParse({ seq }).success, JSON.stringify(seq)).toBe(false);
    }
  });

  it('take a mute flag as a boolean, never a string', () => {
    expect(SetMutedRequestSchema.safeParse({ isMuted: true }).success).toBe(true);
    for (const isMuted of ['true', 1, null, undefined]) {
      expect(SetMutedRequestSchema.safeParse({ isMuted }).success, String(isMuted)).toBe(false);
    }
  });
});

describe('the write responses', () => {
  it('report a start as created or reused, and nothing else', () => {
    for (const outcome of ['created', 'reused']) {
      expect(
        StartConversationResponseSchema.safeParse({
          outcome,
          conversationId: 'e0000000-0000-4000-8000-000000000001',
        }).success,
        outcome,
      ).toBe(true);
    }
    for (const outcome of ['blocked', 'not_contactable', 'invalid', 'existing']) {
      expect(
        StartConversationResponseSchema.safeParse({
          outcome,
          conversationId: 'e0000000-0000-4000-8000-000000000001',
        }).success,
        outcome,
      ).toBe(false);
    }
  });

  it('return the stored message, so a surface renders what committed', () => {
    const message = {
      id: 'a1000000-0000-4000-8000-000000000005',
      seq: '5',
      conversationId: 'e0000000-0000-4000-8000-000000000001',
      senderUserId: '11111111-1111-4111-8111-111111111111',
      isOwnMessage: true,
      messageType: 'text',
      body: 'Still available?',
      referenceType: null,
      referenceId: null,
      createdAt: '2026-09-24T18:30:00.000Z',
      editedAt: null,
      deletedAt: null,
      // 0104. Empty on a read-back: a message cannot be created with a file, so one that has just committed
      // has none, and the field is required so the shape cannot omit it.
      attachments: [],
    };
    expect(SendMessageResponseSchema.safeParse({ message }).success).toBe(true);
    expect(SendMessageResponseSchema.safeParse({ message, echo: true }).success).toBe(false);
  });

  it('allow a read marker that has never moved, and refuse a zero', () => {
    expect(MarkReadResponseSchema.safeParse({ lastReadSeq: null }).success).toBe(true);
    expect(MarkReadResponseSchema.safeParse({ lastReadSeq: '3' }).success).toBe(true);
    expect(MarkReadResponseSchema.safeParse({ lastReadSeq: '0' }).success).toBe(false);
  });

  it('let a leave report only that it left', () => {
    expect(LeaveConversationResponseSchema.safeParse({ membershipState: 'left' }).success).toBe(true);
    expect(LeaveConversationResponseSchema.safeParse({ membershipState: 'active' }).success).toBe(false);
  });

  it('let a close report only that it is closed, with when', () => {
    expect(
      CloseConversationResponseSchema.safeParse({
        isClosed: true,
        closedAt: '2026-09-24T18:30:00.000Z',
      }).success,
    ).toBe(true);
    // There is no reopen, so there is no shape in which `isClosed` is false.
    expect(
      CloseConversationResponseSchema.safeParse({ isClosed: false, closedAt: null }).success,
    ).toBe(false);
  });
});

/**
 * The reporting contracts (Phase 5-H).
 *
 * Three fields out and two back, and the assertions are mostly about what cannot be sent: a reporter, a
 * free-text details box, a reason outside the platform's existing eleven, or a subject type that belongs
 * to another surface.
 */
describe('reporting', () => {
  const MESSAGE = 'a1000000-0000-4000-8000-000000000005';
  const doc = generateOpenApiDocument();

  it('accepts exactly the two subjects a conversation can produce', () => {
    expect([...MESSAGING_REPORT_SUBJECTS]).toEqual(['message', 'conversation']);
    for (const subjectType of MESSAGING_REPORT_SUBJECTS) {
      expect(
        FileMessagingReportRequestSchema.safeParse({ subjectType, subjectId: MESSAGE, reasonCode: 'other' })
          .success,
        subjectType,
      ).toBe(true);
    }
  });

  it('refuses every other subject type, including ones the reports table allows elsewhere', () => {
    for (const subjectType of ['seller', 'user', 'listing', 'review', 'review_reply', 'promotion', '']) {
      expect(
        FileMessagingReportRequestSchema.safeParse({ subjectType, subjectId: MESSAGE, reasonCode: 'other' })
          .success,
        subjectType,
      ).toBe(false);
    }
  });

  it('reuses the platform’s eleven reasons and adds none', () => {
    expect([...REPORT_REASON_CODES]).toEqual([
      'prohibited_item',
      'counterfeit',
      'intellectual_property',
      'fraud_or_scam',
      'harassment',
      'adult_content',
      'violence',
      'spam',
      'misleading',
      'off_platform',
      'other',
    ]);
    for (const reasonCode of ['rude', 'messaging_abuse', 'OTHER', '']) {
      expect(
        FileMessagingReportRequestSchema.safeParse({
          subjectType: 'message',
          subjectId: MESSAGE,
          reasonCode,
        }).success,
        reasonCode,
      ).toBe(false);
    }
  });

  it('refuses a request that names a reporter, carries details, or decides an outcome', () => {
    for (const extra of [
      { reporterUserId: '11111111-1111-4111-8111-111111111111' },
      { userId: '11111111-1111-4111-8111-111111111111' },
      { details: 'the whole message pasted in' },
      { status: 'actioned' },
      { priority: 'high' },
      { assignedTo: '11111111-1111-4111-8111-111111111111' },
    ]) {
      expect(
        FileMessagingReportRequestSchema.safeParse({
          subjectType: 'message',
          subjectId: MESSAGE,
          reasonCode: 'other',
          ...extra,
        }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it('requires a real uuid for the subject', () => {
    for (const subjectId of ['not-a-uuid', '', 42, null]) {
      expect(
        FileMessagingReportRequestSchema.safeParse({
          subjectType: 'message',
          subjectId,
          reasonCode: 'other',
        }).success,
        String(subjectId),
      ).toBe(false);
    }
  });

  it('answers with one outcome and the report id, and nothing else', () => {
    const reportId = 'c0000000-0000-4000-8000-00000000000a';
    expect(FileMessagingReportResponseSchema.safeParse({ outcome: 'filed', reportId }).success).toBe(true);
    // There is no created/reused pair: a repeat lands on the report already open, which is the same fact.
    for (const body of [
      { outcome: 'created', reportId },
      { outcome: 'reused', reportId },
      { outcome: 'filed' },
      { outcome: 'filed', reportId, status: 'open' },
      { outcome: 'filed', reportId, subjectId: MESSAGE },
    ]) {
      expect(FileMessagingReportResponseSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('documents one reporting operation, and no way to read or resolve a report', () => {
    const paths = Object.keys(doc.paths ?? {}).filter((path) => path.startsWith('/v1/messaging'));
    expect(paths).toContain('/v1/messaging/reports');
    expect(doc.paths?.['/v1/messaging/reports']?.post?.operationId).toBe('postV1MessagingReports');
    expect(Object.keys(doc.paths?.['/v1/messaging/reports'] ?? {})).toEqual(['post']);
    expect(paths.some((path) => path.includes('moderation'))).toBe(false);
    expect(paths.some((path) => path.includes('resolve'))).toBe(false);
  });

  it('carries the leak-free refusal on that operation', () => {
    const responses = doc.paths?.['/v1/messaging/reports']?.post?.responses ?? {};
    expect(Object.keys(responses)).toContain('404');
    // No 403 anywhere on it: a forbidden would confirm the subject is real.
    expect(Object.keys(responses)).not.toContain('409');
    expect(JSON.stringify(responses['404'])).toContain('neither can be told from the other');
  });

  it('has a problem code for the refusal', () => {
    expect(PROBLEM_CODES).toContain('MESSAGING_REPORT_TARGET_NOT_FOUND');
  });
});
