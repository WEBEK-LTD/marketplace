import { REPORT_REASON_CODES } from '@repo/contracts';
import type { ReportCopy } from './report-form';

/**
 * The report form's words, assembled once (Phase 7-M).
 *
 * The same form appears on three pages — a listing, a service and a seller profile — so its copy is built
 * here rather than three times. These become RSC payload, which is why only the words this one form needs are
 * assembled: nothing here builds the words for the history page, and nothing on the history page builds
 * these.
 *
 * **All eleven reasons are labelled.** A reason with no label would render as its own column value, which is
 * not a sentence in anybody's language. The labels name the platform's existing vocabulary and add nothing to
 * it: there is no twelfth option, no "something else" beside `other`, and no severity.
 */
export function reportCopy(t: (key: string) => string): ReportCopy {
  const reasons: Record<string, string> = {};
  for (const code of REPORT_REASON_CODES) reasons[code] = t(`reasons.${code}`);

  return {
    action: t('action'),
    heading: t('heading'),
    intro: t('intro'),
    reasonLabel: t('reasonLabel'),
    reasonPlaceholder: t('reasonPlaceholder'),
    reasonRequired: t('reasonRequired'),
    reasons,
    detailsLabel: t('detailsLabel'),
    detailsHint: t('detailsHint'),
    detailsTooLong: t('detailsTooLong'),
    submit: t('submit'),
    sending: t('sending'),
    cancel: t('cancel'),
    done: t('done'),
    doneHint: t('doneHint'),
    signIn: t('signIn'),
    // The refusals. Each is a sentence this page owns; none interpolates anything the server sent.
    notFound: t('failedNotFound'),
    notReportable: t('failedNotReportable'),
    ownSubject: t('failedOwnSubject'),
    throttled: t('failedThrottled'),
    invalid: t('failedInvalid'),
    signedOut: t('failedSignedOut'),
    unavailable: t('failedGeneric'),
  };
}
