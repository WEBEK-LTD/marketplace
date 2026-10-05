import { REPORT_REASON_CODES, REPORT_SUBJECT_TYPES } from '@repo/contracts';

/**
 * Filing a report from a public page — the logic half (Phase 7-M).
 *
 * Separated from the component for the reason 7-K's `support.ts` is: every rule lives here, where a suite can
 * exercise it without a browser, and the component keeps only state and markup.
 *
 * **What this module will not send.** A reporter, an account, a subject id, a status, a priority, an
 * assignee, a resolution. Not because it filters them out — because the body below is built from four named
 * fields and there is nowhere for a fifth to come from.
 *
 * **A subject is a slug.** `subjectSlug` is the address the page is at. There is no id on the page to send:
 * the public seller projection never publishes one, which is exactly why the slug is the handle.
 *
 * **A repeat is a success.** The platform's reporting lands a second submission on the report already open
 * and answers with the same id, so this surface says the same thing either way and never tells somebody they
 * have already reported something — which would itself be a disclosure about their own past behaviour that
 * the page has no other reason to hold.
 */

export const REPORT_ROUTE = '/api/reports';

/** `reports_details_length`, measured the way the column measures it: after trimming. */
export const REPORT_DETAILS_MAX_LENGTH = 4000;

/** The two kinds of thing a public page can report. Re-exported so the component imports one module. */
export { REPORT_REASON_CODES, REPORT_SUBJECT_TYPES };

export type ReportSubjectType = (typeof REPORT_SUBJECT_TYPES)[number];
export type ReportReasonCode = (typeof REPORT_REASON_CODES)[number];

export function isReportReasonCode(value: string): value is ReportReasonCode {
  return (REPORT_REASON_CODES as readonly string[]).includes(value);
}

export function isReportSubjectType(value: string): value is ReportSubjectType {
  return (REPORT_SUBJECT_TYPES as readonly string[]).includes(value);
}

/** What the page knows about what is being reported. Both values come from the address it is at. */
export interface ReportSubject {
  readonly subjectType: ReportSubjectType;
  readonly subjectSlug: string;
}

export interface ReportFailureLabels {
  readonly notFound: string;
  readonly notReportable: string;
  readonly ownSubject: string;
  readonly throttled: string;
  readonly invalid: string;
  readonly signedOut: string;
  readonly unavailable: string;
}

export type ReportResult =
  | { readonly kind: 'ok'; readonly reportId: string }
  | { readonly kind: 'failed'; readonly status: number | null; readonly code: string | null };

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Trims and drops an empty box.
 *
 * An untouched details field is *absent*, not empty: the column is nullable and its length rule measures a
 * trimmed value, so sending `""` would be sending a value the database refuses rather than sending nothing.
 */
export function prepareDetails(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Whether the details, as typed, are within the column's own bound. */
export function detailsTooLong(value: string): boolean {
  return value.trim().length > REPORT_DETAILS_MAX_LENGTH;
}

/**
 * Files one report.
 *
 * The body is four fields, and the fourth is omitted rather than nulled when there is nothing in it. The
 * problem code is read off a refusal so the component can say which of the three refusals happened without
 * rendering a sentence the server composed.
 */
export async function fileReport(
  input: { subject: ReportSubject; reasonCode: ReportReasonCode; details: string | null },
  fetcher: Fetcher,
): Promise<ReportResult> {
  let response: Response;
  try {
    response = await fetcher(REPORT_ROUTE, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subjectType: input.subject.subjectType,
        subjectSlug: input.subject.subjectSlug,
        reasonCode: input.reasonCode,
        ...(input.details === null ? {} : { details: input.details }),
      }),
    });
  } catch {
    return { kind: 'failed', status: null, code: null };
  }

  let payload: unknown = null;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    payload = null;
  }

  if (response.status === 201) {
    const reportId =
      typeof payload === 'object' && payload !== null && typeof (payload as { reportId?: unknown }).reportId === 'string'
        ? (payload as { reportId: string }).reportId
        : null;
    return reportId === null
      ? { kind: 'failed', status: response.status, code: null }
      : { kind: 'ok', reportId };
  }

  const code =
    typeof payload === 'object' && payload !== null && typeof (payload as { code?: unknown }).code === 'string'
      ? (payload as { code: string }).code
      : null;
  return { kind: 'failed', status: response.status, code };
}

/**
 * The one place a refusal becomes a sentence.
 *
 * Keyed on the problem code where there is one, because the code is the platform's own vocabulary and the
 * sentence is the page's. Nothing here interpolates a value from the server: a refusal about a listing must
 * not be able to put a listing's title, a slug or an account on screen.
 */
export function reportFailureMessage(
  result: { status: number | null; code: string | null },
  labels: ReportFailureLabels,
): string {
  if (result.code === 'REPORT_SUBJECT_NOT_REPORTABLE') return labels.notReportable;
  if (result.code === 'REPORT_SUBJECT_IS_THE_REPORTER') return labels.ownSubject;
  if (result.status === 401) return labels.signedOut;
  if (result.status === 404) return labels.notFound;
  if (result.status === 429) return labels.throttled;
  if (result.status === 400 || result.status === 403) return labels.invalid;
  return labels.unavailable;
}
