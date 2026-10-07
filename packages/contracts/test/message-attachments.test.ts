import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MESSAGE_ATTACHMENT_CONTENT_TYPES,
  MESSAGE_ATTACHMENT_MAX_BYTES,
  MESSAGE_ATTACHMENT_MAX_PER_MESSAGE,
  MessageAttachmentLinkResponseSchema,
  MessageAttachmentRecordRequestSchema,
  MessageAttachmentRecordResponseSchema,
  MessageAttachmentSchema,
  MessageAttachmentUploadRequestSchema,
  MessageAttachmentUploadResponseSchema,
  MessageItemSchema,
} from '../src/messaging.js';
import { PROBLEM_CODES } from '../src/problem-details.js';

/**
 * The conversation attachment contract (0104).
 *
 * Most of this is refusal, because what the shapes cannot express is the point:
 *
 *   * **SVG is not a permitted type**, and the enum is closed so no client can name it;
 *   * **no request names where a file goes** — the upload request has a type and a size and nothing else;
 *   * **no response returns an object path** except the authorization, which returns it so the client can hand
 *     it back; a readback never does;
 *   * **an attachment-only message is unrepresentable** — a message always has a body field and the attachment
 *     shapes are attached to a message rather than being a message;
 *   * `attachments` on a message is **required and usually empty**, so a surface never has two empty states.
 */

const ATTACHMENT = {
  id: '44444444-4444-4444-8444-444444444444',
  contentType: 'image/png',
  byteSize: '1000',
};

const SOURCE = readFileSync(join(import.meta.dirname, '..', 'src', 'messaging.ts'), 'utf8');
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ------------------------------------------------------------------------------------------------ */

describe('the permitted types', () => {
  it('are three image formats and PDF, and nothing else', () => {
    expect([...MESSAGE_ATTACHMENT_CONTENT_TYPES]).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf',
    ]);
  });

  /** Called out rather than merely absent: an SVG is XML a browser executes. */
  it('do not include SVG, in the constant or anywhere in the module', () => {
    expect([...MESSAGE_ATTACHMENT_CONTENT_TYPES]).not.toContain('image/svg+xml');
    expect(CODE).not.toContain('svg+xml');
  });

  it('refuse every other type a client might name', () => {
    for (const contentType of [
      'image/svg+xml',
      'image/avif',
      'image/heic',
      'text/html',
      'application/octet-stream',
      'application/x-msdownload',
      'application/zip',
      'IMAGE/PNG',
      'image/png; charset=binary',
      '',
    ]) {
      expect(
        MessageAttachmentUploadRequestSchema.safeParse({ contentType, byteSize: 1000 }).success,
        contentType,
      ).toBe(false);
    }
  });
});

describe('the limits', () => {
  it('are five per message and ten mebibytes each', () => {
    expect(MESSAGE_ATTACHMENT_MAX_PER_MESSAGE).toBe(5);
    expect(MESSAGE_ATTACHMENT_MAX_BYTES).toBe(10_485_760);
  });

  it('bound the size a request may declare', () => {
    expect(
      MessageAttachmentUploadRequestSchema.safeParse({ contentType: 'image/png', byteSize: 10_485_760 })
        .success,
    ).toBe(true);
    for (const byteSize of [10_485_761, 0, -1, 1.5, '1000', null]) {
      expect(
        MessageAttachmentUploadRequestSchema.safeParse({ contentType: 'image/png', byteSize }).success,
        String(byteSize),
      ).toBe(false);
    }
  });

  it('bound the count a confirmation may report', () => {
    expect(
      MessageAttachmentRecordResponseSchema.safeParse({ attachmentId: ATTACHMENT.id, attachmentCount: 5 })
        .success,
    ).toBe(true);
    expect(
      MessageAttachmentRecordResponseSchema.safeParse({ attachmentId: ATTACHMENT.id, attachmentCount: 6 })
        .success,
    ).toBe(false);
    expect(
      MessageAttachmentRecordResponseSchema.safeParse({ attachmentId: ATTACHMENT.id, attachmentCount: 0 })
        .success,
    ).toBe(false);
  });
});

describe('authorizing an upload', () => {
  it('takes a type and a size, and nothing about where the file goes', () => {
    const parsed = MessageAttachmentUploadRequestSchema.safeParse({
      contentType: 'image/png',
      byteSize: 1000,
    });
    expect(parsed.success).toBe(true);

    for (const extra of [
      { objectPath: 'message-attachments/x/y/z.png' },
      { bucket: 'message-attachments' },
      { bucketId: 'message-attachments' },
      { originalFilename: 'holiday.png' },
      { messageId: '33333333-3333-4333-8333-333333333333' },
      { userId: '99999999-9999-4999-8999-999999999999' },
    ]) {
      expect(
        MessageAttachmentUploadRequestSchema.safeParse({
          contentType: 'image/png',
          byteSize: 1000,
          ...extra,
        }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it('answers with one URL, one path, an expiry and a ceiling', () => {
    const parsed = MessageAttachmentUploadResponseSchema.safeParse({
      upload: {
        uploadUrl: 'https://storage.test/upload/opaque',
        objectPath: 'message-attachments/a/b/c.png',
        expiresAt: '2026-10-04T12:02:00.000Z',
        maxByteSize: 10_485_760,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses an authorization carrying a credential or a bucket', () => {
    for (const extra of [{ token: 'x' }, { apikey: 'x' }, { bucket: 'message-attachments' }]) {
      expect(
        MessageAttachmentUploadResponseSchema.safeParse({
          upload: {
            uploadUrl: 'https://storage.test/upload/opaque',
            objectPath: 'message-attachments/a/b/c.png',
            expiresAt: '2026-10-04T12:02:00.000Z',
            maxByteSize: 1000,
            ...extra,
          },
        }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });
});

describe('confirming an upload', () => {
  it('sends back the path it was given, with the type and size', () => {
    expect(
      MessageAttachmentRecordRequestSchema.safeParse({
        objectPath: 'message-attachments/a/b/c.png',
        contentType: 'image/png',
        byteSize: 1000,
      }).success,
    ).toBe(true);
  });

  it('refuses a path that is absent or absurdly long', () => {
    for (const objectPath of ['', 'x'.repeat(513), null, 42]) {
      expect(
        MessageAttachmentRecordRequestSchema.safeParse({
          objectPath,
          contentType: 'image/png',
          byteSize: 1000,
        }).success,
        JSON.stringify(objectPath),
      ).toBe(false);
    }
  });

  it('answers with an identifier and a count, and never a path', () => {
    const parsed = MessageAttachmentRecordResponseSchema.safeParse({
      attachmentId: ATTACHMENT.id,
      attachmentCount: 1,
    });
    expect(parsed.success).toBe(true);
    for (const extra of [{ objectPath: 'x' }, { url: 'https://storage.test/x' }, { bucket: 'x' }]) {
      expect(
        MessageAttachmentRecordResponseSchema.safeParse({
          attachmentId: ATTACHMENT.id,
          attachmentCount: 1,
          ...extra,
        }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });
});

describe('an attachment, as a participant sees it', () => {
  it('is three fields', () => {
    expect(MessageAttachmentSchema.safeParse(ATTACHMENT).success).toBe(true);
    expect(Object.keys(MessageAttachmentSchema.parse(ATTACHMENT)).sort()).toEqual([
      'byteSize',
      'contentType',
      'id',
    ]);
  });

  it('carries no path, no URL, no filename and no uploader', () => {
    for (const extra of [
      { objectPath: 'message-attachments/a/b/c.png' },
      { url: 'https://storage.test/x' },
      { originalFilename: 'holiday.png' },
      { uploadedBy: '99999999-9999-4999-8999-999999999999' },
      { messageId: '33333333-3333-4333-8333-333333333333' },
      { width: 100 },
      { height: 100 },
    ]) {
      expect(
        MessageAttachmentSchema.safeParse({ ...ATTACHMENT, ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it('carries its size as a decimal string, because it is a bigint', () => {
    expect(MessageAttachmentSchema.safeParse({ ...ATTACHMENT, byteSize: 1000 }).success).toBe(false);
    expect(MessageAttachmentSchema.safeParse({ ...ATTACHMENT, byteSize: '0' }).success).toBe(false);
    expect(MessageAttachmentSchema.safeParse({ ...ATTACHMENT, byteSize: '-1' }).success).toBe(false);
    expect(
      MessageAttachmentSchema.safeParse({ ...ATTACHMENT, byteSize: '9007199254740993' }).success,
    ).toBe(true);
  });
});

describe('a message carrying attachments', () => {
  const MESSAGE = {
    id: '33333333-3333-4333-8333-333333333333',
    seq: '1',
    conversationId: '22222222-2222-4222-8222-222222222222',
    senderUserId: '11111111-1111-4111-8111-111111111111',
    isOwnMessage: true,
    messageType: 'text',
    body: 'Here it is.',
    referenceType: null,
    referenceId: null,
    createdAt: '2026-10-04T10:00:00.000Z',
    editedAt: null,
    deletedAt: null,
    attachments: [ATTACHMENT],
  };

  it('accepts a message with files', () => {
    expect(MessageItemSchema.safeParse(MESSAGE).success).toBe(true);
  });

  /** Required and usually empty, so a surface never has to tell "none" from "field missing". */
  it('requires the field even when there are none', () => {
    expect(MessageItemSchema.safeParse({ ...MESSAGE, attachments: [] }).success).toBe(true);
    const { attachments: _omitted, ...without } = MESSAGE;
    expect(MessageItemSchema.safeParse(without).success).toBe(false);
  });

  it('refuses a message whose body is absent, so an attachment is never a kind of message', () => {
    const { body: _omitted, ...without } = MESSAGE;
    expect(MessageItemSchema.safeParse(without).success).toBe(false);
  });

  it('refuses an attachment inside it that carries a path', () => {
    expect(
      MessageItemSchema.safeParse({
        ...MESSAGE,
        attachments: [{ ...ATTACHMENT, objectPath: 'message-attachments/a/b/c.png' }],
      }).success,
    ).toBe(false);
  });
});

describe('the signed read', () => {
  it('is a URL and an expiry', () => {
    expect(
      MessageAttachmentLinkResponseSchema.safeParse({
        url: 'https://storage.test/read/opaque',
        expiresAt: '2026-10-04T12:10:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('carries no path, no bucket and no credential', () => {
    for (const extra of [{ objectPath: 'x' }, { bucket: 'x' }, { token: 'x' }, { apikey: 'x' }]) {
      expect(
        MessageAttachmentLinkResponseSchema.safeParse({
          url: 'https://storage.test/read/opaque',
          expiresAt: '2026-10-04T12:10:00.000Z',
          ...extra,
        }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it('refuses something that is not a URL', () => {
    expect(
      MessageAttachmentLinkResponseSchema.safeParse({
        url: 'message-attachments/a/b/c.png',
        expiresAt: '2026-10-04T12:10:00.000Z',
      }).success,
    ).toBe(false);
  });
});

describe('the module itself', () => {
  it('adds exactly two problem codes, and reuses MESSAGING_BLOCKED for a block', () => {
    expect(PROBLEM_CODES).toContain('MESSAGE_ATTACHMENT_LIMIT_REACHED');
    expect(PROBLEM_CODES).toContain('MESSAGE_ATTACHMENT_OBJECT_MISSING');
    expect(PROBLEM_CODES).toContain('MESSAGING_BLOCKED');
    expect(PROBLEM_CODES.filter((code) => code.startsWith('MESSAGE_ATTACHMENT_'))).toHaveLength(2);
  });

  it('introduces no permission key', () => {
    expect(CODE).not.toContain('permission');
    expect(CODE).not.toMatch(/'[a-z]+\.[a-z]+\.(read|write|manage)'/);
  });

  it('describes no moderation, scanning, thumbnail or dimension shape', () => {
    for (const name of [
      'Moderat',
      'StaffAttachment',
      'ScanResult',
      'virus',
      'Thumbnail',
      'thumbnail',
      'width',
      'height',
    ]) {
      expect(CODE, name).not.toContain(name);
    }
  });

  /**
   * Scoped to the attachment shapes rather than to the module.
   *
   * `messaging.ts` does mention a currency — 5-C's listing reference carries one — so a module-wide search would
   * fail on something that predates this increment and is correct. What matters is that nothing an attachment
   * carries is money.
   */
  it('makes no attachment shape carry money', () => {
    expect(SOURCE).not.toContain('@repo/money');
    for (const schema of [
      MessageAttachmentSchema,
      MessageAttachmentUploadRequestSchema,
      MessageAttachmentRecordRequestSchema,
      MessageAttachmentRecordResponseSchema,
      MessageAttachmentLinkResponseSchema,
    ]) {
      expect(
        schema.safeParse({ currencyCode: 'EGP', amountMinor: '1000' }).success,
        schema.description ?? 'schema',
      ).toBe(false);
    }
  });
});
