import { describe, expect, it } from 'vitest';
import {
  VERIFICATION_DECISIONS,
  VERIFICATION_DOCUMENT_TYPES,
  VERIFICATION_QUEUE_FILTERS,
  VERIFICATION_STATUSES,
  VerificationDecisionRequestSchema,
  VerificationDocumentLinkResponseSchema,
  VerificationQueueItemSchema,
  VerificationReviewDocumentSchema,
  VerificationReviewSchema,
  generateOpenApiDocument,
} from '../src/index.js';

/**
 * The seller verification review contract (Phase 7-G).
 *
 * The assertions that matter are about absence, because this is the shape a surface holding somebody's
 * identity documents is built from: what it must *not* carry matters more than what it does.
 */

const DOCUMENT = {
  id: 'a0000000-0000-4000-8000-000000000001',
  documentType: 'national_id',
  originalFilename: 'id-front.jpg',
  contentType: 'image/jpeg',
  byteSize: '120000',
  status: 'pending',
  uploadedAt: '2026-05-01T08:30:00.000Z',
};

const SELLER = {
  slug: 'rev-shop-one',
  displayName: 'Review Shop One',
  legalName: 'One Trading LLC',
  countryCode: 'EG',
  governorate: 'Giza',
  city: 'Dokki',
  contactEmail: 'one@shops.invalid',
  contactPhone: '+201000000101',
  status: 'pending',
  verificationStatus: 'pending',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const REVIEW = {
  id: 'f0000000-0000-4000-8000-000000000001',
  status: 'submitted',
  submittedAt: '2026-05-01T09:00:00.000Z',
  createdAt: '2026-05-01T08:00:00.000Z',
  updatedAt: '2026-05-01T09:00:00.000Z',
  reviewedAt: null,
  decisionReason: null,
  expiresAt: null,
  emailVerified: true,
  phoneVerified: true,
  decidable: true,
  seller: SELLER,
  documents: [DOCUMENT],
};

const QUEUE_ITEM = {
  id: REVIEW.id,
  status: 'submitted',
  submittedAt: REVIEW.submittedAt,
  createdAt: REVIEW.createdAt,
  reviewedAt: null,
  emailVerified: true,
  phoneVerified: true,
  documentCount: 1,
  sellerSlug: SELLER.slug,
  sellerDisplayName: SELLER.displayName,
  sellerStatus: 'pending',
  sellerVerificationStatus: 'pending',
};

describe('7-G the vocabularies are 0009’s, unchanged', () => {
  it('names the six statuses 0009 defines and no seventh', () => {
    expect(VERIFICATION_STATUSES).toEqual([
      'draft',
      'submitted',
      'under_review',
      'approved',
      'rejected',
      'expired',
    ]);
  });

  it('names 0009’s six document types and no seventh', () => {
    expect(VERIFICATION_DOCUMENT_TYPES).toEqual([
      'national_id',
      'passport',
      'commercial_register',
      'tax_card',
      'bank_statement',
      'other',
    ]);
  });

  it('offers exactly two decisions, and neither belongs to the seller’s own flow', () => {
    expect(VERIFICATION_DECISIONS).toEqual(['approved', 'rejected']);
    for (const status of ['draft', 'submitted', 'under_review', 'expired']) {
      expect(
        VerificationDecisionRequestSchema.safeParse({ decision: status }).success,
        status,
      ).toBe(false);
    }
  });

  it('offers five queue filters, and draft is not one of them', () => {
    expect(VERIFICATION_QUEUE_FILTERS).toEqual([
      'submitted',
      'under_review',
      'approved',
      'rejected',
      'expired',
    ]);
    expect(VERIFICATION_QUEUE_FILTERS).not.toContain('draft');
  });
});

describe('7-G what the shapes refuse to carry', () => {
  it('accepts the shapes the console renders', () => {
    expect(VerificationReviewSchema.safeParse(REVIEW).success).toBe(true);
    expect(VerificationQueueItemSchema.safeParse(QUEUE_ITEM).success).toBe(true);
  });

  it('carries no account identifier, anywhere', () => {
    for (const field of ['sellerUserId', 'userId', 'reviewedBy', 'reviewerId']) {
      expect(VerificationReviewSchema.safeParse({ ...REVIEW, [field]: REVIEW.id }).success, field).toBe(false);
      expect(VerificationQueueItemSchema.safeParse({ ...QUEUE_ITEM, [field]: REVIEW.id }).success, field).toBe(
        false,
      );
      expect(VerificationReviewSchema.safeParse({ ...REVIEW, seller: { ...SELLER, [field]: REVIEW.id } }).success, field).toBe(
        false,
      );
    }
  });

  it('carries no storage location on a document, and no internal note', () => {
    for (const field of ['objectPath', 'object_path', 'bucket', 'bucketId', 'reviewNote', 'reviewedBy']) {
      expect(VerificationReviewDocumentSchema.safeParse({ ...DOCUMENT, [field]: 'x' }).success, field).toBe(
        false,
      );
    }
    expect(Object.keys(VerificationReviewDocumentSchema.shape).sort()).toEqual([
      'byteSize',
      'contentType',
      'documentType',
      'id',
      'originalFilename',
      'status',
      'uploadedAt',
    ]);
  });

  it('keeps a byte size as a string, because the column is a bigint', () => {
    expect(VerificationReviewDocumentSchema.safeParse({ ...DOCUMENT, byteSize: 120000 }).success).toBe(false);
  });

  it('accepts nothing in a decision but the two fields', () => {
    expect(VerificationDecisionRequestSchema.safeParse({ decision: 'approved' }).success).toBe(true);
    expect(
      VerificationDecisionRequestSchema.safeParse({ decision: 'rejected', reason: 'Unreadable.' }).success,
    ).toBe(true);
    for (const field of ['verificationId', 'reviewerId', 'reviewedAt', 'status', 'objectPath']) {
      expect(
        VerificationDecisionRequestSchema.safeParse({ decision: 'approved', [field]: 'x' }).success,
        field,
      ).toBe(false);
    }
  });

  it('refuses a blank reason and an unbounded one', () => {
    expect(VerificationDecisionRequestSchema.safeParse({ decision: 'rejected', reason: '   ' }).success).toBe(
      false,
    );
    expect(
      VerificationDecisionRequestSchema.safeParse({ decision: 'rejected', reason: 'x'.repeat(2001) }).success,
    ).toBe(false);
  });

  it('answers a document link with a URL and nothing that could be reused', () => {
    expect(
      VerificationDocumentLinkResponseSchema.safeParse({
        documentId: DOCUMENT.id,
        url: 'https://storage.test/one.jpg?token=abc',
        expiresAt: '2026-05-01T09:02:00.000Z',
      }).success,
    ).toBe(true);
    for (const field of ['objectPath', 'bucket', 'apiKey', 'secretKey', 'token']) {
      expect(
        VerificationDocumentLinkResponseSchema.safeParse({
          documentId: DOCUMENT.id,
          url: 'https://storage.test/one.jpg',
          expiresAt: '2026-05-01T09:02:00.000Z',
          [field]: 'x',
        }).success,
        field,
      ).toBe(false);
    }
  });

  it('exports no request shape that names a person or a path', async () => {
    const module = await import('../src/verification-review.js');
    for (const name of Object.keys(module)) {
      const lower = name.toLowerCase();
      expect(lower, name).not.toContain('path');
      expect(lower, name).not.toContain('bucket');
      expect(lower, name).not.toContain('grant');
    }
  });
});

describe('7-G the documented operations', () => {
  const doc = generateOpenApiDocument();

  it('documents four operations: three reads and one decision', () => {
    const paths = Object.keys(doc.paths ?? {}).filter((path) =>
      path.startsWith('/v1/admin/seller-verifications'),
    );
    expect(paths.sort()).toEqual([
      '/v1/admin/seller-verifications',
      '/v1/admin/seller-verifications/{verificationId}',
      '/v1/admin/seller-verifications/{verificationId}/decision',
      '/v1/admin/seller-verifications/{verificationId}/documents/{documentId}/link',
    ]);
    expect(Object.keys(doc.paths?.['/v1/admin/seller-verifications'] ?? {})).toEqual(['get']);
    expect(Object.keys(doc.paths?.['/v1/admin/seller-verifications/{verificationId}'] ?? {})).toEqual(['get']);
    expect(
      Object.keys(doc.paths?.['/v1/admin/seller-verifications/{verificationId}/decision'] ?? {}),
    ).toEqual(['post']);
  });

  it('takes no parameter anywhere that could name a person or an object', () => {
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      if (!path.startsWith('/v1/admin/seller-verifications')) continue;
      for (const operation of Object.values(item ?? {})) {
        const names = ((operation as { parameters?: unknown[] }).parameters ?? []).map((parameter) =>
          typeof parameter === 'object' && parameter !== null && 'name' in parameter
            ? String((parameter as { name: unknown }).name)
            : '',
        );
        for (const name of names) {
          expect(name.toLowerCase(), `${path} ${name}`).not.toContain('user');
          expect(name.toLowerCase(), `${path} ${name}`).not.toContain('seller-user');
          expect(name.toLowerCase(), `${path} ${name}`).not.toContain('path');
          expect(name.toLowerCase(), `${path} ${name}`).not.toContain('bucket');
          expect(name.toLowerCase(), `${path} ${name}`).not.toContain('permission');
          expect(name.toLowerCase(), `${path} ${name}`).not.toContain('aal');
        }
      }
    }
  });

  it('documents the refusals a reviewer surface must have', () => {
    const decision = doc.paths?.['/v1/admin/seller-verifications/{verificationId}/decision']?.post;
    expect(decision?.responses?.['401']).toBeDefined();
    expect(decision?.responses?.['403']).toBeDefined();
    expect(decision?.responses?.['404']).toBeDefined();
    expect(decision?.responses?.['409']).toBeDefined();
  });
});
