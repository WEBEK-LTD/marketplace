import type { ProblemCode } from '@repo/contracts';

/**
 * Report failures, the reporter side (Phase 7-M).
 *
 * Each declares the problem it becomes, which is how every other error in this API reaches the
 * problem-details filter.
 *
 * **There is no "forbidden" here.** A listing still in draft, one whose seller is not publicly visible, a
 * withdrawn storefront and a slug that names nothing at all become one {@link ReportSubjectNotFoundError}
 * — identical in status, code and sentence — for 5-H's reason, which is 0056's: "there is no 'it exists but
 * you may not report it' outcome, because that sentence is the disclosure."
 *
 * The two refusals below are the cases where naming the reason discloses nothing. One is about a *kind* of
 * thing rather than a thing; the other is about the caller themselves.
 */

/** Nothing the public can see lives at that slug. One answer for hidden and for absent. */
export class ReportSubjectNotFoundError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'NOT_FOUND',
  };

  constructor() {
    super('The requested resource was not found.');
    this.name = 'ReportSubjectNotFoundError';
  }
}

/**
 * The subject type is not one this surface files.
 *
 * It names a kind of thing, not a thing, so answering plainly reveals nothing about any row: the caller has
 * reached the wrong operation and the remedy is a different surface — a message is reported from the
 * conversation it is in, which 5-H already does.
 */
export class ReportSubjectNotReportableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'REPORT_SUBJECT_NOT_REPORTABLE',
  };

  constructor() {
    super('That kind of subject is not reported here.');
    this.name = 'ReportSubjectNotReportableError';
  }
}

/**
 * Somebody is reporting their own storefront.
 *
 * 0027 refuses it — "a report cannot be about its own reporter" — and 0076 returns that as an outcome
 * rather than letting it become a database exception. It is the one refusal on this surface that a caller
 * can act on and that discloses nothing, because the only account it is about is theirs.
 */
export class ReportSubjectIsTheReporterError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'REPORT_SUBJECT_IS_THE_REPORTER',
  };

  constructor() {
    super('A report cannot be about its own reporter.');
    this.name = 'ReportSubjectIsTheReporterError';
  }
}

/** An unusable history cursor. One code for every way a cursor can fail to be one. */
export class ReportsCursorInvalidError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'REPORTS_CURSOR_INVALID',
  };

  constructor() {
    super('The cursor could not be read.');
    this.name = 'ReportsCursorInvalidError';
  }
}

/** The approved report filing limit rejected this attempt. */
export class ReportThrottledError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 429,
    code: 'THROTTLED',
  };

  /** The bucket that rejected it, for the log line. Never for the response body. */
  readonly bucket: string;

  constructor(bucket: string) {
    super('Too many requests.');
    this.name = 'ReportThrottledError';
    this.bucket = bucket;
  }
}
