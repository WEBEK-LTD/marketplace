import { describe, expect, it } from 'vitest';
import {
  LISTING_MODERATION_ACTIONS,
  LISTING_STATUSES,
  ListingModerationHistoryResponseSchema,
  ListingModerationRowSchema,
  MODERATION_ACTIONS,
  MODERATION_DEFAULT_LIMIT,
  MODERATION_MAX_LIMIT,
  ModerateListingRequestSchema,
  ModerateListingResponseSchema,
  ModerationActionRowSchema,
  ModerationListingDetailSchema,
  ModerationReportDetailSchema,
  ModerationReportQueueResponseSchema,
  ModerationReportRowSchema,
  PROBLEM_CODES,
  REPORT_PRIORITIES,
  REPORT_RESOLUTIONS,
  REPORT_STATUSES,
  REPORT_SUBJECT_TYPES_ALL,
  ResolveReportRequestSchema,
  ResolveReportResponseSchema,
} from '../src/index.js';

/**
 * Listing moderation and report management (Phase 7-N).
 *
 * The contract is where this surface's refusals begin, so this is where they are checked: that no request
 * can name a moderator, a permission or an assurance level; that a report resolution cannot say `open`,
 * because the writer refuses it; that the five listing actions and the ten listing statuses are the
 * database's own; and that no response has a place for an account identifier.
 */

const RESOLVE = { status: 'actioned', resolutionNote: 'A reason.' } as const;
const MODERATE = { action: 'suspend', reason: 'A reason.' } as const;
const ACCOUNT = '11111111-1111-4111-8111-111111111111';

describe('the vocabularies are the database’s own', () => {
  it('carries 0027’s eight report subject types', () => {
    expect(REPORT_SUBJECT_TYPES_ALL).toEqual([
      'listing',
      'review',
      'review_reply',
      'message',
      'conversation',
      'seller',
      'user',
      'promotion',
    ]);
  });

  it('carries 0027’s five report statuses and three priorities', () => {
    expect(REPORT_STATUSES).toEqual(['open', 'triaged', 'actioned', 'dismissed', 'duplicate']);
    expect(REPORT_PRIORITIES).toEqual(['low', 'normal', 'high']);
  });

  it('accepts the four statuses the writer accepts, and never open', () => {
    expect(REPORT_RESOLUTIONS).toEqual(['triaged', 'actioned', 'dismissed', 'duplicate']);
    for (const status of REPORT_RESOLUTIONS) {
      const body = status === 'duplicate' ? { status, resolutionNote: 'A reason.', duplicateOfReportId: ACCOUNT } : { status, resolutionNote: 'A reason.' };
      expect(ResolveReportRequestSchema.safeParse(body).success, status).toBe(true);
    }
    // `open` is the one status in the table that this surface cannot set, because the writer raises on it.
    expect(ResolveReportRequestSchema.safeParse({ status: 'open' }).success).toBe(false);
    for (const status of ['reopened', 'closed', 'resolved', 'pending', '']) {
      expect(ResolveReportRequestSchema.safeParse({ ...RESOLVE, status }).success, status).toBe(false);
    }
  });

  it('carries the writer’s five listing actions and the eight generic ones', () => {
    expect(LISTING_MODERATION_ACTIONS).toEqual([
      'approve',
      'reject',
      'suspend',
      'reinstate',
      'request_changes',
    ]);
    expect(MODERATION_ACTIONS).toEqual([
      'none',
      'warn',
      'hide',
      'remove',
      'restrict',
      'suspend',
      'reinstate',
      'escalate',
    ]);
    for (const action of LISTING_MODERATION_ACTIONS) {
      expect(ModerateListingRequestSchema.safeParse({ ...MODERATE, action }).success, action).toBe(true);
    }
    // The generic vocabulary is read back on the trail and is not what a listing decision sends.
    for (const action of ['remove', 'hide', 'warn', 'escalate', 'delete', 'unpublish']) {
      expect(ModerateListingRequestSchema.safeParse({ ...MODERATE, action }).success, action).toBe(false);
    }
  });

  it('carries 0011’s ten listing statuses', () => {
    expect(LISTING_STATUSES).toHaveLength(10);
    expect(LISTING_STATUSES).toContain('pending_review');
    expect(LISTING_STATUSES).toContain('suspended');
  });

  it('pages like every other list on the platform', () => {
    expect(MODERATION_DEFAULT_LIMIT).toBe(20);
    expect(MODERATION_MAX_LIMIT).toBe(50);
  });
});

describe('what a report resolution cannot say', () => {
  it('names no moderator, however the field is spelled', () => {
    for (const field of ['moderatorUserId', 'moderatorId', 'userId', 'actorId', 'resolvedBy']) {
      expect(ResolveReportRequestSchema.safeParse({ ...RESOLVE, [field]: ACCOUNT }).success, field).toBe(
        false,
      );
    }
  });

  it('names no permission, role or assurance level', () => {
    for (const field of ['permission', 'role', 'isAal2', 'aal', 'requiresStepUp']) {
      expect(ResolveReportRequestSchema.safeParse({ ...RESOLVE, [field]: true }).success, field).toBe(false);
    }
  });

  it('requires a note for every decision and allows triage without one', () => {
    for (const status of ['actioned', 'dismissed'] as const) {
      expect(ResolveReportRequestSchema.safeParse({ status }).success, status).toBe(false);
    }
    expect(ResolveReportRequestSchema.safeParse({ status: 'triaged' }).success).toBe(true);
    expect(ResolveReportRequestSchema.safeParse({ status: 'triaged', resolutionNote: 'A note.' }).success).toBe(
      true,
    );
    expect(ResolveReportRequestSchema.safeParse({ status: 'actioned', resolutionNote: '' }).success).toBe(
      false,
    );
  });

  it('requires the original exactly when the status is duplicate', () => {
    expect(
      ResolveReportRequestSchema.safeParse({ status: 'duplicate', resolutionNote: 'A note.' }).success,
    ).toBe(false);
    expect(
      ResolveReportRequestSchema.safeParse({
        status: 'duplicate',
        resolutionNote: 'A note.',
        duplicateOfReportId: ACCOUNT,
      }).success,
    ).toBe(true);
    // And refuses one on a status that is not duplicate, which the schema would null out anyway.
    expect(
      ResolveReportRequestSchema.safeParse({ ...RESOLVE, duplicateOfReportId: ACCOUNT }).success,
    ).toBe(false);
  });
});

describe('what a listing decision cannot say', () => {
  it('names no moderator, no status and no seller', () => {
    for (const field of ['moderatorUserId', 'status', 'toStatus', 'sellerUserId', 'fromStatus']) {
      expect(ModerateListingRequestSchema.safeParse({ ...MODERATE, [field]: 'anything' }).success, field).toBe(
        false,
      );
    }
  });

  it('names no storage path or bucket, because moderating a listing touches no storage', () => {
    for (const field of ['objectPath', 'bucket', 'bucketId', 'mediaId']) {
      expect(ModerateListingRequestSchema.safeParse({ ...MODERATE, [field]: 'x' }).success, field).toBe(false);
    }
  });

  it('cannot set a reversal, because no writer in this repository ever has', () => {
    expect(
      ModerateListingRequestSchema.safeParse({ ...MODERATE, reversesActionId: ACCOUNT }).success,
    ).toBe(false);
    expect(ModerateListingRequestSchema.safeParse({ ...MODERATE, expiresAt: '2026-05-01T09:00:00.000Z' }).success)
      .toBe(false);
  });

  it('requires a reason within the length both tables allow', () => {
    expect(ModerateListingRequestSchema.safeParse({ action: 'suspend' }).success).toBe(false);
    expect(ModerateListingRequestSchema.safeParse({ ...MODERATE, reason: '' }).success).toBe(false);
    expect(ModerateListingRequestSchema.safeParse({ ...MODERATE, reason: 'x'.repeat(500) }).success).toBe(true);
    expect(ModerateListingRequestSchema.safeParse({ ...MODERATE, reason: 'x'.repeat(501) }).success).toBe(
      false,
    );
  });

  it('may cite the report that prompted it, and nothing else about one', () => {
    expect(ModerateListingRequestSchema.safeParse({ ...MODERATE, reportId: ACCOUNT }).success).toBe(true);
    expect(
      ModerateListingRequestSchema.safeParse({ ...MODERATE, reportStatus: 'actioned' }).success,
    ).toBe(false);
  });
});

describe('what comes back', () => {
  const REPORT_ROW = {
    id: ACCOUNT,
    subjectType: 'listing',
    subjectLabel: 'A listing',
    reasonCode: 'counterfeit',
    status: 'open',
    priority: 'normal',
    isOwnReport: false,
    actionCount: 0,
    createdAt: '2026-05-01T09:00:00.000Z',
  } as const;

  it('accepts a queue row and refuses one that names an account', () => {
    expect(ModerationReportRowSchema.safeParse(REPORT_ROW).success).toBe(true);
    for (const field of ['reporterUserId', 'assignedTo', 'resolvedBy', 'resolutionNote']) {
      expect(ModerationReportRowSchema.safeParse({ ...REPORT_ROW, [field]: ACCOUNT }).success, field).toBe(
        false,
      );
    }
  });

  it('accepts a subject it cannot resolve, with no label', () => {
    expect(
      ModerationReportRowSchema.safeParse({ ...REPORT_ROW, subjectType: 'message', subjectLabel: null })
        .success,
    ).toBe(true);
  });

  it('accepts a report detail and refuses one that names an account', () => {
    const detail = {
      ...REPORT_ROW,
      subjectSlug: 'a-listing',
      subjectStatus: 'active',
      subjectIsResolvable: true,
      details: 'What they said.',
      resolution: null,
      resolutionNote: null,
      resolvedAt: null,
      resolvedByMe: false,
      duplicateOfReportId: null,
      updatedAt: '2026-05-01T09:00:00.000Z',
    };
    const { actionCount: _count, ...withoutCount } = detail;
    expect(ModerationReportDetailSchema.safeParse(withoutCount).success).toBe(true);
    for (const field of ['reporterUserId', 'assignedTo', 'resolvedBy', 'moderatorUserId']) {
      expect(ModerationReportDetailSchema.safeParse({ ...withoutCount, [field]: ACCOUNT }).success, field)
        .toBe(false);
    }
  });

  it('accepts either trail row and refuses a moderator on it', () => {
    const generic = {
      id: ACCOUNT,
      action: 'suspend',
      reason: 'A reason.',
      notes: null,
      reportId: null,
      expiresAt: null,
      reversesActionId: null,
      isOwnAction: true,
      createdAt: '2026-05-01T09:00:00.000Z',
    };
    expect(ModerationActionRowSchema.safeParse(generic).success).toBe(true);
    expect(ModerationActionRowSchema.safeParse({ ...generic, moderatorUserId: ACCOUNT }).success).toBe(false);

    const shaped = {
      id: ACCOUNT,
      action: 'suspend',
      fromStatus: 'active',
      toStatus: 'suspended',
      reason: 'A reason.',
      reportId: null,
      isOwnAction: true,
      createdAt: '2026-05-01T09:00:00.000Z',
    };
    expect(ListingModerationRowSchema.safeParse(shaped).success).toBe(true);
    expect(ListingModerationRowSchema.safeParse({ ...shaped, moderatorUserId: ACCOUNT }).success).toBe(false);
    expect(ListingModerationHistoryResponseSchema.safeParse({ items: [shaped] }).success).toBe(true);
  });

  it('accepts a listing detail and refuses a seller account or a storage path on it', () => {
    const listing = {
      id: ACCOUNT,
      slug: 'a-listing',
      title: 'A listing',
      description: 'A description.',
      contentLanguage: 'en',
      status: 'pending_review',
      listingTypeCode: 'product',
      currencyCode: 'EGP',
      priceMinor: '150000',
      city: 'Cairo',
      sellerSlug: 'a-shop',
      sellerDisplayName: 'A Shop',
      isOwnListing: false,
      canModerate: true,
      openReportCount: 0,
      createdAt: '2026-05-01T09:00:00.000Z',
      approvedAt: null,
    };
    expect(ModerationListingDetailSchema.safeParse(listing).success).toBe(true);
    for (const field of ['sellerUserId', 'objectPath', 'bucketId']) {
      expect(ModerationListingDetailSchema.safeParse({ ...listing, [field]: 'x' }).success, field).toBe(
        false,
      );
    }
  });

  it('answers each write with one outcome and the status now held', () => {
    expect(ResolveReportResponseSchema.safeParse({ outcome: 'resolved', status: 'actioned' }).success).toBe(
      true,
    );
    expect(ResolveReportResponseSchema.safeParse({ outcome: 'ok', status: 'actioned' }).success).toBe(false);
    expect(ModerateListingResponseSchema.safeParse({ outcome: 'moderated', status: 'suspended' }).success).toBe(
      true,
    );
    expect(ModerateListingResponseSchema.safeParse({ outcome: 'moderated', status: 'gone' }).success).toBe(
      false,
    );
  });

  it('refuses an unknown field on the queue envelope', () => {
    expect(ModerationReportQueueResponseSchema.safeParse({ items: [], nextCursor: null }).success).toBe(true);
    expect(
      ModerationReportQueueResponseSchema.safeParse({ items: [], nextCursor: null, total: 3 }).success,
    ).toBe(false);
  });
});

describe('the problem codes', () => {
  it('carries the five 7-N adds', () => {
    for (const code of [
      'REPORT_ALREADY_FINAL',
      'REPORT_IS_OWN',
      'LISTING_IS_OWN',
      'LISTING_MODERATION_NO_CHANGE',
      'LISTING_MODERATION_NOT_APPLICABLE',
    ]) {
      expect(PROBLEM_CODES, code).toContain(code);
    }
    // No forbidden on this surface: a row a caller may not read and one that does not exist are one 404.
    expect(PROBLEM_CODES).not.toContain('MODERATION_FORBIDDEN');
    expect(PROBLEM_CODES).not.toContain('REPORT_FORBIDDEN');
  });
});
