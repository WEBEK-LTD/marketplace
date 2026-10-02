import { describe, expect, it } from 'vitest';
import {
  REPORT_DETAILS_MAX_LENGTH,
  REPORT_REASON_CODES,
  REPORT_ROUTE,
  REPORT_SUBJECT_TYPES,
  detailsTooLong,
  fileReport,
  isReportReasonCode,
  isReportSubjectType,
  prepareDetails,
  reportFailureMessage,
} from '../src/components/report';

/**
 * The report form's logic (Phase 7-M).
 *
 * The component is state and markup; every rule it follows is here, which is what this suite exercises. The
 * properties that matter: the body is four fields and never five, an untouched details box is absent rather
 * than empty, and a refusal becomes a sentence this page owns without a single value from the server reaching
 * it.
 */

const SUBJECT = { subjectType: 'listing', subjectSlug: 'a-real-listing-slug' } as const;

const LABELS = {
  notFound: 'nothing-here',
  notReportable: 'not-from-here',
  ownSubject: 'your-own',
  throttled: 'too-many',
  invalid: 'check-it',
  signedOut: 'sign-in',
  unavailable: 'try-again',
};

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly body: string;
  readonly credentials: RequestCredentials | undefined;
}

function fetcher(status: number, payload: unknown, seen: Seen[] = []) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    seen.push({
      url,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? init.body : '',
      credentials: init.credentials,
    });
    return new Response(JSON.stringify(payload), { status });
  };
}

describe('the vocabularies it knows', () => {
  it('knows the two subject types and the eleven reasons, and nothing else', () => {
    expect(REPORT_SUBJECT_TYPES).toEqual(['listing', 'seller']);
    expect(REPORT_REASON_CODES).toHaveLength(11);
    expect(isReportSubjectType('listing')).toBe(true);
    expect(isReportSubjectType('seller')).toBe(true);
    for (const value of ['message', 'conversation', 'review', 'review_reply', 'user', 'promotion', '']) {
      expect(isReportSubjectType(value), value).toBe(false);
    }
    expect(isReportReasonCode('other')).toBe(true);
    expect(isReportReasonCode('because_i_said')).toBe(false);
    expect(isReportReasonCode('')).toBe(false);
  });

  it('measures details the way the column does', () => {
    expect(REPORT_DETAILS_MAX_LENGTH).toBe(4000);
    expect(detailsTooLong('x'.repeat(4000))).toBe(false);
    expect(detailsTooLong('x'.repeat(4001))).toBe(true);
    // Trimmed first, so trailing whitespace does not push a valid note over the bound.
    expect(detailsTooLong(`${'x'.repeat(4000)}    `)).toBe(false);
  });

  it('treats an untouched box as no details at all', () => {
    expect(prepareDetails('')).toBeNull();
    expect(prepareDetails('   ')).toBeNull();
    expect(prepareDetails('\n\t ')).toBeNull();
    expect(prepareDetails('  what they said  ')).toBe('what they said');
  });
});

describe('what it sends', () => {
  it('posts the three required fields to this origin’s own route', async () => {
    const seen: Seen[] = [];
    const result = await fileReport(
      { subject: SUBJECT, reasonCode: 'counterfeit', details: null },
      fetcher(201, { outcome: 'filed', reportId: 'c0000000-0000-4000-8000-00000000000a' }, seen),
    );

    expect(result.kind).toBe('ok');
    expect(seen[0]!.url).toBe(REPORT_ROUTE);
    expect(REPORT_ROUTE).toBe('/api/reports');
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.credentials).toBe('same-origin');
    expect(JSON.parse(seen[0]!.body)).toEqual({
      subjectType: 'listing',
      subjectSlug: 'a-real-listing-slug',
      reasonCode: 'counterfeit',
    });
  });

  it('omits details rather than sending null', async () => {
    const seen: Seen[] = [];
    await fileReport(
      { subject: SUBJECT, reasonCode: 'spam', details: null },
      fetcher(201, { outcome: 'filed', reportId: 'c0000000-0000-4000-8000-00000000000a' }, seen),
    );
    expect(Object.keys(JSON.parse(seen[0]!.body) as object)).toEqual([
      'subjectType',
      'subjectSlug',
      'reasonCode',
    ]);
  });

  it('includes details when there are some', async () => {
    const seen: Seen[] = [];
    await fileReport(
      { subject: SUBJECT, reasonCode: 'spam', details: 'what they said' },
      fetcher(201, { outcome: 'filed', reportId: 'c0000000-0000-4000-8000-00000000000a' }, seen),
    );
    expect(JSON.parse(seen[0]!.body)).toHaveProperty('details', 'what they said');
  });

  it('sends no identity, no id and no moderation field, because the body is built rather than copied', async () => {
    const seen: Seen[] = [];
    await fileReport(
      { subject: SUBJECT, reasonCode: 'spam', details: null },
      fetcher(201, { outcome: 'filed', reportId: 'c0000000-0000-4000-8000-00000000000a' }, seen),
    );
    for (const field of [
      'reporterUserId',
      'userId',
      'subjectId',
      'listingId',
      'status',
      'priority',
      'assignedTo',
      'resolution',
    ]) {
      expect(seen[0]!.body, field).not.toContain(field);
    }
  });

  it('names the seller by slug, never by an account', async () => {
    const seen: Seen[] = [];
    await fileReport(
      { subject: { subjectType: 'seller', subjectSlug: 'good-shop' }, reasonCode: 'spam', details: null },
      fetcher(201, { outcome: 'filed', reportId: 'c0000000-0000-4000-8000-00000000000a' }, seen),
    );
    expect(JSON.parse(seen[0]!.body)).toEqual({
      subjectType: 'seller',
      subjectSlug: 'good-shop',
      reasonCode: 'spam',
    });
  });
});

describe('what it makes of an answer', () => {
  it('reads the report id out of a 201', async () => {
    const result = await fileReport(
      { subject: SUBJECT, reasonCode: 'spam', details: null },
      fetcher(201, { outcome: 'filed', reportId: 'c0000000-0000-4000-8000-00000000000a' }),
    );
    expect(result).toEqual({ kind: 'ok', reportId: 'c0000000-0000-4000-8000-00000000000a' });
  });

  it('treats a 201 with no id as a failure rather than a success', async () => {
    const result = await fileReport(
      { subject: SUBJECT, reasonCode: 'spam', details: null },
      fetcher(201, { outcome: 'filed' }),
    );
    expect(result.kind).toBe('failed');
  });

  it('keeps the problem code, which is how a refusal becomes the right sentence', async () => {
    const result = await fileReport(
      { subject: SUBJECT, reasonCode: 'spam', details: null },
      fetcher(409, { code: 'REPORT_SUBJECT_IS_THE_REPORTER' }),
    );
    expect(result).toEqual({ kind: 'failed', status: 409, code: 'REPORT_SUBJECT_IS_THE_REPORTER' });
  });

  it('survives a body that is not JSON', async () => {
    const result = await fileReport({ subject: SUBJECT, reasonCode: 'spam', details: null }, async () => {
      return new Response('<html>a proxy page</html>', { status: 502 });
    });
    expect(result).toEqual({ kind: 'failed', status: 502, code: null });
  });

  it('survives a request that never arrived', async () => {
    const result = await fileReport({ subject: SUBJECT, reasonCode: 'spam', details: null }, async () => {
      throw new Error('offline');
    });
    expect(result).toEqual({ kind: 'failed', status: null, code: null });
  });
});

describe('the sentences', () => {
  it('picks the sentence by code first, because a code is the platform’s own word', () => {
    expect(reportFailureMessage({ status: 409, code: 'REPORT_SUBJECT_NOT_REPORTABLE' }, LABELS)).toBe(
      'not-from-here',
    );
    expect(reportFailureMessage({ status: 409, code: 'REPORT_SUBJECT_IS_THE_REPORTER' }, LABELS)).toBe(
      'your-own',
    );
  });

  it('falls back to the status, and to one sentence for everything unexpected', () => {
    expect(reportFailureMessage({ status: 401, code: null }, LABELS)).toBe('sign-in');
    expect(reportFailureMessage({ status: 404, code: null }, LABELS)).toBe('nothing-here');
    expect(reportFailureMessage({ status: 429, code: null }, LABELS)).toBe('too-many');
    expect(reportFailureMessage({ status: 400, code: null }, LABELS)).toBe('check-it');
    expect(reportFailureMessage({ status: 403, code: null }, LABELS)).toBe('check-it');
    for (const status of [500, 502, 503, 418, null]) {
      expect(reportFailureMessage({ status, code: null }, LABELS), String(status)).toBe('try-again');
    }
  });

  it('never returns anything the server sent', () => {
    const sentence = reportFailureMessage(
      { status: 404, code: 'NOT_FOUND' },
      LABELS,
    );
    expect(Object.values(LABELS)).toContain(sentence);
  });
});
