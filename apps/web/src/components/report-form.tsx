'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import {
  REPORT_DETAILS_MAX_LENGTH,
  REPORT_REASON_CODES,
  detailsTooLong,
  fileReport,
  isReportReasonCode,
  prepareDetails,
  reportFailureMessage,
  type ReportFailureLabels,
  type ReportSubject,
} from './report';

/**
 * Reporting a listing or a seller from the page it is on (Phase 7-M).
 *
 * A link that expands in place into a form — no modal, no overlay, no focus trap, no new framework, which is
 * 5-H's own shape for the same job on a conversation.
 *
 * What it deliberately does not do:
 *
 * - **It changes nothing about the subject.** The listing stays listed and the storefront stays open. The
 *   only request it can make is the report, because it imports nothing else.
 * - **It hides nothing.** After a successful report the page is exactly as it was. Hiding the thing would be
 *   a moderation decision, and a report is a request for one.
 * - **It shows no identifier.** The subject travels as the slug the page is addressed by; nothing here
 *   renders an account, and nothing here carries one in an attribute.
 * - **It offers no status, no priority and no outcome.** There is no control for any of them and no field in
 *   what it sends. What happens next is 7-N's, and this form makes no promise about it.
 * - **It does not tell somebody they have already reported this.** A repeat is the same success, which is the
 *   platform's own behaviour, and reporting it as "already filed" would disclose their own past submission on
 *   a page anybody can open.
 *
 * **Why it carries no session state.** All three pages it appears on are public and cacheable, and reading
 * the session on them would change what those surfaces are — which is 5-E's own reasoning for the contact
 * button beside it. So this form does not know whether the visitor is signed in and does not ask: it offers
 * the action, and a 401 from the BFF, the only authority on that question, turns it into a link to sign in.
 * Nothing about the visitor is rendered either way, so the markup is identical for everybody.
 *
 * The reason is a required choice from the eleven the platform already has, because a report with no reason
 * is one a moderator cannot act on; the details box is optional, because a reason is often the whole of it.
 */

const LINK_CLASS =
  'text-xs underline decoration-neutral-300 underline-offset-4 hover:decoration-neutral-900 disabled:opacity-60';
const BUTTON_CLASS =
  'rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60';
const SECONDARY_CLASS =
  'rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-60';
const FIELD_CLASS =
  'mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900';

export interface ReportCopy extends ReportFailureLabels {
  /** The link, before anything is opened. */
  readonly action: string;
  /** The form's own heading, and what it is for. */
  readonly heading: string;
  readonly intro: string;
  readonly reasonLabel: string;
  readonly reasonPlaceholder: string;
  readonly reasonRequired: string;
  /** The eleven reasons, in the platform's own vocabulary, named for a reader. */
  readonly reasons: Readonly<Record<string, string>>;
  readonly detailsLabel: string;
  readonly detailsHint: string;
  readonly detailsTooLong: string;
  readonly submit: string;
  readonly sending: string;
  readonly cancel: string;
  /** What is said once it is filed. It promises nothing about an outcome. */
  readonly done: string;
  readonly doneHint: string;
  /** Offered when the BFF says the visitor has no session. */
  readonly signIn: string;
}

export function ReportForm({
  subject,
  loginPath,
  copy,
}: {
  readonly subject: ReportSubject;
  /** Where to send a visitor who turns out not to be signed in. */
  readonly loginPath: string;
  readonly copy: ReportCopy;
}) {
  const [state, setState] = useState<'idle' | 'open' | 'sending' | 'done'>('idle');
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (state === 'sending') return;
    setMessage(null);

    if (!isReportReasonCode(reason)) {
      setMessage(copy.reasonRequired);
      return;
    }
    if (detailsTooLong(details)) {
      setMessage(copy.detailsTooLong);
      return;
    }

    setState('sending');
    const result = await fileReport(
      { subject, reasonCode: reason, details: prepareDetails(details) },
      (input, init) => fetch(input, init),
    );

    if (result.kind === 'ok') {
      // A first report and a repeat arrive here identically, which is the point.
      setState('done');
      setDetails('');
      return;
    }
    setState('open');
    if (result.status === 401) {
      // The BFF is the only thing that knows; now that it has said so, offer the way in. The draft stays
      // where it is, so signing in and coming back costs the reporter nothing they typed.
      setSignedOut(true);
      setMessage(copy.signedOut);
      return;
    }
    setMessage(reportFailureMessage(result, copy));
  }

  if (state === 'done') {
    return (
      <div role="status" className="mt-4 max-w-prose rounded-lg border border-neutral-200 p-4">
        <p className="text-sm font-medium text-neutral-900">{copy.done}</p>
        <p className="mt-1 text-xs text-neutral-600">{copy.doneHint}</p>
      </div>
    );
  }

  if (state === 'idle') {
    return (
      <p className="mt-4">
        <button type="button" onClick={() => setState('open')} className={LINK_CLASS}>
          {copy.action}
        </button>
      </p>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      aria-labelledby="report-heading"
      className="mt-4 max-w-prose rounded-lg border border-neutral-200 p-4"
    >
      <h2 id="report-heading" className="text-sm font-medium text-neutral-900">
        {copy.heading}
      </h2>
      <p className="mt-1 text-xs text-neutral-600">{copy.intro}</p>

      <div className="mt-3">
        <label htmlFor="report-reason" className="text-sm font-medium text-neutral-900">
          {copy.reasonLabel}
        </label>
        <select
          id="report-reason"
          name="reasonCode"
          disabled={state === 'sending'}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className={FIELD_CLASS}
        >
          <option value="">{copy.reasonPlaceholder}</option>
          {REPORT_REASON_CODES.map((code) => (
            <option key={code} value={code}>
              {copy.reasons[code] ?? code}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-3">
        <label htmlFor="report-details" className="text-sm font-medium text-neutral-900">
          {copy.detailsLabel}
        </label>
        <p className="mt-1 text-xs text-neutral-600">{copy.detailsHint}</p>
        <textarea
          id="report-details"
          name="details"
          rows={4}
          maxLength={REPORT_DETAILS_MAX_LENGTH}
          disabled={state === 'sending'}
          value={details}
          onChange={(event) => setDetails(event.target.value)}
          className={FIELD_CLASS}
        />
      </div>

      {message !== null && (
        <p role="alert" className="mt-3 max-w-prose text-sm font-medium text-neutral-900">
          {message}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-3">
        {signedOut ? (
          <Link href={loginPath} className={BUTTON_CLASS}>
            {copy.signIn}
          </Link>
        ) : (
          <button type="submit" disabled={state === 'sending'} className={BUTTON_CLASS}>
            {state === 'sending' ? copy.sending : copy.submit}
          </button>
        )}
        <button
          type="button"
          disabled={state === 'sending'}
          onClick={() => {
            setState('idle');
            setMessage(null);
          }}
          className={SECONDARY_CLASS}
        >
          {copy.cancel}
        </button>
      </div>
    </form>
  );
}
