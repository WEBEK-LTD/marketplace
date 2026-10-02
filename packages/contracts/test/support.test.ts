import { describe, expect, it } from 'vitest';
import {
  OpenSupportTicketResponseSchema,
  OpenSupportTicketSchema,
  PROBLEM_CODES,
  PostSupportMessageSchema,
  SUPPORT_ATTACHMENT_CONTENT_TYPES,
  SUPPORT_ATTACHMENT_MAX_BYTES,
  SUPPORT_MESSAGES_DEFAULT_LIMIT,
  SUPPORT_MESSAGES_MAX_LIMIT,
  SUPPORT_MESSAGE_AUTHOR_ROLES,
  SUPPORT_TICKETS_DEFAULT_LIMIT,
  SUPPORT_TICKETS_MAX_LIMIT,
  SUPPORT_TICKET_CATEGORIES,
  SUPPORT_TICKET_STATUSES,
  SupportAttachmentLinkResponseSchema,
  SupportAttachmentRecordResponseSchema,
  SupportAttachmentRecordSchema,
  SupportAttachmentSchema,
  SupportAttachmentUploadRequestSchema,
  SupportAttachmentUploadResponseSchema,
  SupportMessageMutationResponseSchema,
  SupportMessageSchema,
  SupportMessagesResponseSchema,
  SupportTicketClosureResponseSchema,
  SupportTicketDetailResponseSchema,
  SupportTicketDetailSchema,
  SupportTicketSummarySchema,
  SupportTicketsResponseSchema,
} from '../src/index.js';

/**
 * The requester support contracts (Phase 7-K).
 *
 * A contract is where a field nobody approved either fails to arrive or slips through, so these tests are
 * about what the shapes **refuse**: an account, a role, a status, a priority, an assignee, an author
 * identifier, an internal note and — on every response — a storage path. They also hold the closed
 * vocabularies to exactly what migration 0028's constraints allow, so a ninth category or a sixth status
 * cannot be introduced by a contract change alone.
 */

const TICKET = 'd4000000-0000-4000-8000-000000000001';
const MESSAGE = 'd4000000-0000-4000-8000-0000000000a1';
const ATTACHMENT = 'd4000000-0000-4000-8000-0000000000b1';
const OBJECT_PATH = `support-attachments/${TICKET}/${MESSAGE}/f47ac10b-58cc-4372-a567-0e02b2c3d479.png`;

const SUMMARY = {
  id: TICKET,
  reference: 'SP-26-000001',
  subject: 'My payout has not arrived',
  category: 'payouts',
  status: 'pending_agent',
  messageCount: 2,
  attachmentCount: 1,
  lastMessageAt: '2026-05-02T09:00:00.000Z',
  resolvedAt: null,
  closedAt: null,
  createdAt: '2026-05-01T09:00:00.000Z',
};

const DETAIL = {
  id: TICKET,
  reference: 'SP-26-000001',
  subject: 'My payout has not arrived',
  category: 'payouts',
  status: 'pending_agent',
  messageCount: 2,
  lastMessageAt: '2026-05-02T09:00:00.000Z',
  resolvedAt: null,
  closedAt: null,
  createdAt: '2026-05-01T09:00:00.000Z',
};

const MESSAGE_ROW = {
  id: MESSAGE,
  authorRole: 'requester',
  isOwnMessage: true,
  body: 'It has been eight days since the payout was marked sent.',
  createdAt: '2026-05-01T09:00:00.000Z',
  attachments: [
    {
      id: ATTACHMENT,
      originalFilename: 'statement.pdf',
      contentType: 'application/pdf',
      byteSize: '20480',
    },
  ],
};

const VALID_TICKET = {
  subject: 'My payout has not arrived',
  category: 'payouts',
  body: 'It has been eight days since the payout was marked sent.',
};

describe('the closed vocabularies', () => {
  it('is exactly 0028’s five statuses, in the table’s order', () => {
    expect(SUPPORT_TICKET_STATUSES).toEqual([
      'open',
      'pending_agent',
      'pending_requester',
      'resolved',
      'closed',
    ]);
  });

  it('is exactly 0028’s eight categories, in the table’s order', () => {
    expect(SUPPORT_TICKET_CATEGORIES).toEqual([
      'account',
      'orders',
      'payments',
      'payouts',
      'listings',
      'verification',
      'technical',
      'other',
    ]);
  });

  it('is exactly 0028’s two author roles', () => {
    expect(SUPPORT_MESSAGE_AUTHOR_ROLES).toEqual(['requester', 'agent']);
  });

  it('is exactly 0012’s four attachment types, and its ceiling', () => {
    expect(SUPPORT_ATTACHMENT_CONTENT_TYPES).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf',
    ]);
    expect(SUPPORT_ATTACHMENT_MAX_BYTES).toBe(20_971_520);
  });

  it('bounds both page sizes', () => {
    expect(SUPPORT_TICKETS_DEFAULT_LIMIT).toBe(20);
    expect(SUPPORT_TICKETS_MAX_LIMIT).toBe(50);
    expect(SUPPORT_MESSAGES_DEFAULT_LIMIT).toBe(20);
    expect(SUPPORT_MESSAGES_MAX_LIMIT).toBe(50);
  });

  it('declares the codes the two support surfaces add, and no more', () => {
    // 7-K's three. The fourth, `SUPPORT_TICKET_NOT_WORKABLE`, is 7-L's and belongs to the agent console:
    // it is asserted here so that a fifth cannot appear without a test noticing.
    expect(PROBLEM_CODES).toContain('SUPPORT_TICKET_NOT_ACTIONABLE');
    expect(PROBLEM_CODES).toContain('SUPPORT_TICKETS_CURSOR_INVALID');
    expect(PROBLEM_CODES).toContain('SUPPORT_ATTACHMENT_OBJECT_MISSING');
    expect(PROBLEM_CODES).toContain('SUPPORT_TICKET_NOT_WORKABLE');
    expect(PROBLEM_CODES.filter((code) => code.startsWith('SUPPORT_'))).toHaveLength(4);
  });
});

describe('opening a ticket', () => {
  it('accepts a subject, a category and a first message', () => {
    expect(OpenSupportTicketSchema.safeParse(VALID_TICKET).success).toBe(true);
  });

  it('trims the text it accepts', () => {
    const parsed = OpenSupportTicketSchema.parse({ ...VALID_TICKET, subject: '  padded  ' });
    expect(parsed.subject).toBe('padded');
  });

  it('refuses a priority, a status, an assignee, an order, an account or a reference', () => {
    for (const extra of [
      { priority: 'urgent' },
      { status: 'resolved' },
      { assignedTo: TICKET },
      { orderId: TICKET },
      { requesterUserId: TICKET },
      { reference: 'SP-26-000001' },
      { authorRole: 'agent' },
    ]) {
      expect(OpenSupportTicketSchema.safeParse({ ...VALID_TICKET, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it('refuses a ninth category, an empty subject and an over-long body', () => {
    for (const bad of [
      { ...VALID_TICKET, category: 'billing' },
      { ...VALID_TICKET, subject: '   ' },
      { ...VALID_TICKET, subject: 'x'.repeat(201) },
      { ...VALID_TICKET, body: '' },
      { ...VALID_TICKET, body: 'y'.repeat(8001) },
    ]) {
      expect(OpenSupportTicketSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('answers with the ticket, its first message, its reference and its status', () => {
    const parsed = OpenSupportTicketResponseSchema.parse({
      ticketId: TICKET,
      messageId: MESSAGE,
      reference: 'SP-26-000001',
      status: 'pending_agent',
    });
    expect(parsed.messageId).toBe(MESSAGE);
    expect(Object.keys(parsed).sort()).toEqual(['messageId', 'reference', 'status', 'ticketId']);
  });
});

describe('replying and closing', () => {
  it('accepts a body and nothing else', () => {
    expect(PostSupportMessageSchema.safeParse({ body: 'Yes, that is the address.' }).success).toBe(true);
    for (const extra of [
      { authorRole: 'agent' },
      { authorUserId: TICKET },
      { ticketId: TICKET },
      { status: 'resolved' },
      { isOwnMessage: false },
    ]) {
      expect(
        PostSupportMessageSchema.safeParse({ body: 'Hello', ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it('answers a reply with the message and the status the ticket now holds', () => {
    const parsed = SupportMessageMutationResponseSchema.parse({
      messageId: MESSAGE,
      status: 'pending_agent',
    });
    expect(Object.keys(parsed).sort()).toEqual(['messageId', 'status']);
  });

  it('answers a closure with a status and nothing else', () => {
    expect(SupportTicketClosureResponseSchema.parse({ status: 'closed' })).toEqual({ status: 'closed' });
    expect(SupportTicketClosureResponseSchema.safeParse({ status: 'closed', closedAt: 'x' }).success).toBe(
      false,
    );
  });

  it('has no schema anywhere that could carry a requested status', () => {
    // There is no "close with this status" request in this module at all: the operation names the move.
    const serialised = JSON.stringify([
      OpenSupportTicketSchema.safeParse({ ...VALID_TICKET, status: 'resolved' }),
      PostSupportMessageSchema.safeParse({ body: 'x', status: 'resolved' }),
    ]);
    expect(serialised).not.toContain('"success":true');
  });
});

describe('what a ticket reads back as', () => {
  it('accepts the list row and the detail the API sends', () => {
    expect(SupportTicketsResponseSchema.safeParse({ items: [SUMMARY], nextCursor: null }).success).toBe(true);
    expect(SupportTicketDetailResponseSchema.safeParse({ ticket: DETAIL }).success).toBe(true);
  });

  it('refuses an assigned agent, an assignment time, a priority or a first-response time', () => {
    for (const extra of [
      { assignedTo: TICKET },
      { assignedAt: '2026-05-02T09:00:00.000Z' },
      { priority: 'urgent' },
      { firstResponseAt: '2026-05-02T09:00:00.000Z' },
      { membershipVersion: 2 },
      { requesterUserId: TICKET },
      { internalNotes: [] },
    ]) {
      expect(SupportTicketSummarySchema.safeParse({ ...SUMMARY, ...extra }).success, JSON.stringify(extra)).toBe(false);
      expect(SupportTicketDetailSchema.safeParse({ ...DETAIL, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it('names exactly the fields a requester may read', () => {
    expect(Object.keys(SupportTicketSummarySchema.parse(SUMMARY)).sort()).toEqual([
      'attachmentCount',
      'category',
      'closedAt',
      'createdAt',
      'id',
      'lastMessageAt',
      'messageCount',
      'reference',
      'resolvedAt',
      'status',
      'subject',
    ]);
  });

  it('refuses a status or a category the schema does not define', () => {
    expect(SupportTicketSummarySchema.safeParse({ ...SUMMARY, status: 'escalated' }).success).toBe(false);
    expect(SupportTicketSummarySchema.safeParse({ ...SUMMARY, category: 'billing' }).success).toBe(false);
  });
});

describe('what a message reads back as', () => {
  it('accepts a message with its attachments', () => {
    expect(SupportMessagesResponseSchema.safeParse({ items: [MESSAGE_ROW], nextCursor: null }).success).toBe(
      true,
    );
  });

  it('refuses an author identifier, an internal note and a hidden flag', () => {
    for (const extra of [
      { authorUserId: TICKET },
      { internalNote: 'staff only' },
      { isInternal: false },
      { authorRole: 'moderator' },
    ]) {
      expect(SupportMessageSchema.safeParse({ ...MESSAGE_ROW, ...extra }).success, JSON.stringify(extra)).toBe(
        false,
      );
    }
  });

  it('refuses an attachment that carries a storage path or a bucket', () => {
    for (const extra of [{ objectPath: OBJECT_PATH }, { bucketId: 'support-attachments' }, { url: 'x' }]) {
      expect(
        SupportAttachmentSchema.safeParse({ ...MESSAGE_ROW.attachments[0], ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it('carries a byte size as a decimal string, because the column is a bigint', () => {
    const parsed = SupportAttachmentSchema.parse(MESSAGE_ROW.attachments[0]);
    expect(parsed.byteSize).toBe('20480');
    expect(SupportAttachmentSchema.safeParse({ ...MESSAGE_ROW.attachments[0], byteSize: 20_480 }).success).toBe(
      false,
    );
  });
});

describe('attachments', () => {
  it('asks for a destination with a type and a size, and cannot name one', () => {
    expect(
      SupportAttachmentUploadRequestSchema.safeParse({ contentType: 'image/png', byteSize: 4096 }).success,
    ).toBe(true);
    for (const extra of [
      { objectPath: OBJECT_PATH },
      { bucket: 'support-attachments' },
      { bucketId: 'support-attachments' },
      { path: 'x' },
    ]) {
      expect(
        SupportAttachmentUploadRequestSchema.safeParse({
          contentType: 'image/png',
          byteSize: 4096,
          ...extra,
        }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it('refuses a type the bucket does not allow and a size beyond its ceiling', () => {
    for (const bad of [
      { contentType: 'image/gif', byteSize: 4096 },
      { contentType: 'application/zip', byteSize: 4096 },
      { contentType: 'image/png', byteSize: 0 },
      { contentType: 'image/png', byteSize: SUPPORT_ATTACHMENT_MAX_BYTES + 1 },
    ]) {
      expect(SupportAttachmentUploadRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('discloses a path exactly once, in the authorization it issues', () => {
    const parsed = SupportAttachmentUploadResponseSchema.parse({
      upload: {
        uploadUrl: 'https://storage.test.invalid/upload/one-object',
        objectPath: OBJECT_PATH,
        expiresAt: '2026-05-02T09:02:00.000Z',
        maxByteSize: 20_971_520,
      },
    });
    expect(parsed.upload.objectPath).toBe(OBJECT_PATH);
  });

  it('confirms with the path it was given, plus what the file was', () => {
    const record = {
      objectPath: OBJECT_PATH,
      originalFilename: 'statement.pdf',
      contentType: 'application/pdf',
      byteSize: 20_480,
    };
    expect(SupportAttachmentRecordSchema.safeParse(record).success).toBe(true);
    expect(SupportAttachmentRecordSchema.safeParse({ ...record, ticketId: TICKET }).success).toBe(false);
    expect(SupportAttachmentRecordSchema.safeParse({ ...record, contentType: 'image/gif' }).success).toBe(
      false,
    );
  });

  it('answers a confirmation with the attachment and a count, and never a path', () => {
    const parsed = SupportAttachmentRecordResponseSchema.parse({
      attachmentId: ATTACHMENT,
      attachmentCount: 1,
    });
    expect(Object.keys(parsed).sort()).toEqual(['attachmentCount', 'attachmentId']);
    expect(
      SupportAttachmentRecordResponseSchema.safeParse({
        attachmentId: ATTACHMENT,
        attachmentCount: 1,
        objectPath: OBJECT_PATH,
      }).success,
    ).toBe(false);
  });

  it('answers a link with a URL and an expiry, and never a path', () => {
    const parsed = SupportAttachmentLinkResponseSchema.parse({
      attachmentId: ATTACHMENT,
      url: 'https://storage.test.invalid/read/one-object',
      expiresAt: '2026-05-02T09:02:00.000Z',
    });
    expect(Object.keys(parsed).sort()).toEqual(['attachmentId', 'expiresAt', 'url']);
    expect(
      SupportAttachmentLinkResponseSchema.safeParse({
        attachmentId: ATTACHMENT,
        url: 'https://storage.test.invalid/read/one-object',
        expiresAt: '2026-05-02T09:02:00.000Z',
        objectPath: OBJECT_PATH,
      }).success,
    ).toBe(false);
  });
});
