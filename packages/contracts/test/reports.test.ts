import { describe, expect, it } from 'vitest';
import {
  FileReportRequestSchema,
  FileReportResponseSchema,
  PROBLEM_CODES,
  REPORTS_DEFAULT_LIMIT,
  REPORTS_MAX_LIMIT,
  REPORT_REASON_CODES,
  REPORT_STATUSES,
  REPORT_SUBJECT_TYPES,
  ReporterReportSchema,
  ReporterReportsResponseSchema,
} from '../src/index.js';

/**
 * Reports — the reporter side (Phase 7-M).
 *
 * The contract is where most of this surface's refusals live, so this is where they are checked: that no
 * request can name a reporter, a status, a priority or an assignee; that a subject travels as a **slug**
 * and an id is not a slug; that the history projection has no place for any of the seven moderation
 * columns; and that the vocabularies are 0027's, not copies of them.
 */

const VALID = {
  subjectType: 'listing',
  subjectSlug: 'a-real-listing-slug',
  reasonCode: 'counterfeit',
} as const;

describe('the vocabularies are the database’s own', () => {
  it('files against the two subject types a public page can produce, and no others', () => {
    expect(REPORT_SUBJECT_TYPES).toEqual(['listing', 'seller']);
    for (const subjectType of REPORT_SUBJECT_TYPES) {
      expect(FileReportRequestSchema.safeParse({ ...VALID, subjectType }).success).toBe(true);
    }
    // 0027 allows these six as well. They are reported from elsewhere, or from nowhere; see the module.
    for (const subjectType of ['message', 'conversation', 'review', 'review_reply', 'user', 'promotion']) {
      expect(FileReportRequestSchema.safeParse({ ...VALID, subjectType }).success, subjectType).toBe(false);
    }
  });

  it('carries 0027’s eleven reason codes, as one list rather than a second copy', () => {
    expect(REPORT_REASON_CODES).toHaveLength(11);
    expect(REPORT_REASON_CODES).toContain('prohibited_item');
    expect(REPORT_REASON_CODES).toContain('other');
    for (const reasonCode of REPORT_REASON_CODES) {
      expect(FileReportRequestSchema.safeParse({ ...VALID, reasonCode }).success, reasonCode).toBe(true);
    }
    expect(FileReportRequestSchema.safeParse({ ...VALID, reasonCode: 'because_i_said' }).success).toBe(false);
  });

  it('carries 0027’s five statuses, unreduced and unrenamed', () => {
    expect(REPORT_STATUSES).toEqual(['open', 'triaged', 'actioned', 'dismissed', 'duplicate']);
  });

  it('pages like every other list on the platform', () => {
    expect(REPORTS_DEFAULT_LIMIT).toBe(20);
    expect(REPORTS_MAX_LIMIT).toBe(50);
  });
});

describe('what a filing request cannot say', () => {
  it('accepts the three fields and the optional details, and nothing else', () => {
    expect(FileReportRequestSchema.safeParse(VALID).success).toBe(true);
    expect(FileReportRequestSchema.safeParse({ ...VALID, details: 'What they did.' }).success).toBe(true);
  });

  it('names no reporter, however the field is spelled', () => {
    for (const field of ['reporterId', 'reporterUserId', 'userId', 'accountId', 'actorId']) {
      expect(
        FileReportRequestSchema.safeParse({ ...VALID, [field]: '11111111-1111-4111-8111-111111111111' })
          .success,
        field,
      ).toBe(false);
    }
  });

  it('names no moderation state: a report decides nothing', () => {
    for (const field of [
      'status',
      'priority',
      'assignedTo',
      'resolution',
      'resolutionNote',
      'resolvedBy',
      'duplicateOfReportId',
    ]) {
      expect(FileReportRequestSchema.safeParse({ ...VALID, [field]: 'anything' }).success, field).toBe(false);
    }
  });

  it('names no permission, role or assurance level', () => {
    for (const field of ['permission', 'role', 'aal', 'isAal2', 'requiresStepUp']) {
      expect(FileReportRequestSchema.safeParse({ ...VALID, [field]: true }).success, field).toBe(false);
    }
  });

  it('has no subject id field, so an arbitrary uuid has nowhere to go', () => {
    expect(FileReportRequestSchema.safeParse({ ...VALID, subjectId: '22220000-0000-4000-8000-000000000001' }).success)
      .toBe(false);
    expect(FileReportRequestSchema.safeParse({ ...VALID, listingId: '22220000-0000-4000-8000-000000000001' }).success)
      .toBe(false);
    expect(FileReportRequestSchema.safeParse({ ...VALID, sellerUserId: '11111111-1111-4111-8111-111111111111' }).success)
      .toBe(false);
    // A uuid happens to *be* a syntactically valid slug — lower-case, alphanumeric, hyphenated — so the
    // format is not what stops one being sent, and pretending otherwise would be a false assurance. What
    // stops it is that a slug is looked up: `listings.slug` and `seller_profiles.slug` hold no uuids, so it
    // resolves to nothing and answers exactly as a slug that never existed does. 0076's pgTAP proves that
    // for both subject types. The contract's job here is narrower and it does it: there is no field through
    // which a row's own identifier could be supplied at all.
    expect(
      FileReportRequestSchema.safeParse({ ...VALID, subjectSlug: '22220000-0000-4000-8000-000000000001' })
        .success,
    ).toBe(true);
  });
});

describe('the subject slug', () => {
  it('holds to the slug format the listing and seller tables share', () => {
    for (const subjectSlug of ['abc', 'a-listing', 'a1-b2-c3', `a${'b'.repeat(118)}c`]) {
      expect(FileReportRequestSchema.safeParse({ ...VALID, subjectSlug }).success, subjectSlug).toBe(true);
    }
    for (const subjectSlug of [
      'ab',
      '-leading',
      'trailing-',
      'Upper-Case',
      'under_score',
      'has space',
      '../../etc/passwd',
      "o'brien",
      'a-listing; drop table reports',
      `a${'b'.repeat(200)}c`,
      '',
    ]) {
      expect(FileReportRequestSchema.safeParse({ ...VALID, subjectSlug }).success, subjectSlug).toBe(false);
    }
  });
});

describe('the details', () => {
  it('holds to reports_details_length', () => {
    expect(FileReportRequestSchema.safeParse({ ...VALID, details: 'x'.repeat(4000) }).success).toBe(true);
    expect(FileReportRequestSchema.safeParse({ ...VALID, details: 'x'.repeat(4001) }).success).toBe(false);
    expect(FileReportRequestSchema.safeParse({ ...VALID, details: '' }).success).toBe(false);
  });

  it('is optional rather than nullable, because the column is absent and not empty', () => {
    expect(FileReportRequestSchema.safeParse({ ...VALID, details: null }).success).toBe(false);
    expect(FileReportRequestSchema.safeParse(VALID).success).toBe(true);
  });
});

describe('what comes back', () => {
  it('answers one outcome, because a first filing and a repeat are the same fact', () => {
    const filed = { outcome: 'filed', reportId: '33330000-0000-4000-8000-000000000001' };
    expect(FileReportResponseSchema.safeParse(filed).success).toBe(true);
    for (const outcome of ['created', 'already_open', 'duplicate', 'not_found']) {
      expect(FileReportResponseSchema.safeParse({ ...filed, outcome }).success, outcome).toBe(false);
    }
  });
});

describe('the history projection', () => {
  const ROW = {
    id: '33330000-0000-4000-8000-000000000001',
    subjectType: 'listing',
    subjectSlug: 'a-real-listing-slug',
    subjectLabel: 'A real listing',
    reasonCode: 'counterfeit',
    details: 'What they did.',
    status: 'open',
    createdAt: '2026-05-01T09:00:00.000Z',
  } as const;

  it('accepts the eight approved fields', () => {
    expect(ReporterReportSchema.safeParse(ROW).success).toBe(true);
  });

  it('accepts a subject that has since left public view', () => {
    expect(ReporterReportSchema.safeParse({ ...ROW, subjectSlug: null, subjectLabel: null }).success).toBe(
      true,
    );
  });

  it('has no place for the subject id, so a seller report never carries an account', () => {
    expect(
      ReporterReportSchema.safeParse({ ...ROW, subjectId: '11111111-1111-4111-8111-111111111111' }).success,
    ).toBe(false);
  });

  it('has no place for any of the seven moderation columns', () => {
    for (const [field, value] of [
      ['priority', 'high'],
      ['assignedTo', '11111111-1111-4111-8111-111111111111'],
      ['assignedAt', '2026-05-02T09:00:00.000Z'],
      ['resolution', 'actioned'],
      ['resolutionNote', 'An internal note.'],
      ['resolvedAt', '2026-05-02T09:00:00.000Z'],
      ['resolvedBy', '11111111-1111-4111-8111-111111111111'],
      ['duplicateOfReportId', '33330000-0000-4000-8000-000000000002'],
      ['reporterUserId', '11111111-1111-4111-8111-111111111111'],
    ] as const) {
      expect(ReporterReportSchema.safeParse({ ...ROW, [field]: value }).success, field).toBe(false);
    }
  });

  it('reports the status in the database’s own vocabulary and refuses an invented one', () => {
    for (const status of REPORT_STATUSES) {
      expect(ReporterReportSchema.safeParse({ ...ROW, status }).success, status).toBe(true);
    }
    for (const status of ['under_review', 'pending', 'closed', 'resolved', 'rejected']) {
      expect(ReporterReportSchema.safeParse({ ...ROW, status }).success, status).toBe(false);
    }
  });

  it('pages with an opaque cursor and refuses an unknown field on the envelope', () => {
    expect(ReporterReportsResponseSchema.safeParse({ items: [ROW], nextCursor: null }).success).toBe(true);
    expect(ReporterReportsResponseSchema.safeParse({ items: [], nextCursor: 'cnAxfGNhbmFyeQ' }).success).toBe(
      true,
    );
    expect(
      ReporterReportsResponseSchema.safeParse({ items: [], nextCursor: null, total: 3 }).success,
    ).toBe(false);
  });
});

describe('the problem codes', () => {
  it('carries the three 7-M adds and no more', () => {
    for (const code of [
      'REPORT_SUBJECT_NOT_REPORTABLE',
      'REPORT_SUBJECT_IS_THE_REPORTER',
      'REPORTS_CURSOR_INVALID',
    ]) {
      expect(PROBLEM_CODES, code).toContain(code);
    }
    // There is no forbidden on this surface: a hidden subject and one that does not exist are one NOT_FOUND.
    expect(PROBLEM_CODES).not.toContain('REPORT_SUBJECT_FORBIDDEN');
    expect(PROBLEM_CODES).not.toContain('REPORT_ALREADY_FILED');
  });
});
