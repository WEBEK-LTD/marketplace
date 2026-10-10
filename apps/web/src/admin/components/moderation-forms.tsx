'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { adminApiPath } from '../paths';

/**
 * The two moderation controls (Phase 7-N).
 *
 * Both are thin: each sends one identifier, one choice from a closed list, and the reason the database
 * requires. What they deliberately do **not** contain is as important:
 *
 * - **No moderator, and no way to name one.** The API resolves the caller from their session; there is no
 *   field here that could carry an account, and no colleague is named anywhere on these screens.
 * - **No status a caller could type.** The report control offers the four the existing writer accepts, as
 *   four options rather than a free field, so `open` — which that writer refuses — is not reachable. The
 *   listing control offers the five the writer defines and sends no status at all: the status a listing lands
 *   on is the writer's own mapping.
 * - **No priority, no assignee, no expiry and no reversal.** None of them is set by any writer in this
 *   repository, so none of them is collected.
 * - **No optimistic row.** A draft is cleared and the screen refreshed only after the server has confirmed;
 *   anything else leaves the text where it is and says what happened. A colleague who lost a written reason to
 *   a failed request has lost more than the request.
 * - **No identifiers on screen.** The words for a refusal are the ones the page passed in, never a sentence
 *   the server composed.
 *
 * Both ask twice, because both are irreversible in the sense that matters: a report cannot be reopened by any
 * path in this repository, and a listing's trail is append-only — a decision is corrected by another decision,
 * never by an edit.
 *
 * **Stale state is the server's answer, not a guess made here.** When a colleague has already acted, the API
 * answers with its own problem code and the sentence for it says so and asks for a reload. Nothing in this
 * file tracks what the database currently holds, because a second copy of that state is a second copy that can
 * disagree.
 */

const BUTTON_CLASS =
  'rounded-md bg-surface-ink px-4 py-2 text-sm font-medium text-on-ink disabled:opacity-60';
const SECONDARY_CLASS =
  'rounded-md border border-edge px-4 py-2 text-sm font-medium text-ink-strong disabled:opacity-60';
const FIELD_CLASS =
  'mt-1 w-full rounded-md border border-edge px-3 py-2 text-sm text-ink-strong';

/** `moderation_actions_reason_length` and `listing_moderation_actions_reason_length`. */
const REASON_MAX_LENGTH = 500;
/** `reports.resolution_note` is unbounded text; this is the bound the contract sets on the way in. */
const NOTE_MAX_LENGTH = 4000;

async function post(path: string, body: Record<string, unknown>): Promise<{ status: number | null; code: string | null }> {
  try {
    const response = await fetch(adminApiPath(path), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let code: string | null = null;
    try {
      const payload = JSON.parse(await response.text()) as { code?: unknown };
      if (typeof payload.code === 'string') code = payload.code;
    } catch {
      code = null;
    }
    return { status: response.status, code };
  } catch {
    return { status: null, code: null };
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* A decision on a report                                                                            */
/* ------------------------------------------------------------------------------------------------ */

export interface ReportResolutionCopy {
  readonly heading: string;
  readonly hint: string;
  readonly statusLabel: string;
  /** The four the existing writer accepts. There is no fifth, and no `open`. */
  readonly statuses: Readonly<Record<'triaged' | 'actioned' | 'dismissed' | 'duplicate', string>>;
  readonly noteLabel: string;
  readonly noteHint: string;
  readonly noteRequired: string;
  readonly duplicateLabel: string;
  readonly duplicateHint: string;
  readonly duplicateRequired: string;
  readonly submit: string;
  readonly working: string;
  readonly confirm: string;
  readonly cancel: string;
  readonly question: string;
  readonly notFound: string;
  readonly alreadyFinal: string;
  readonly ownReport: string;
  readonly invalid: string;
  readonly signedOut: string;
  readonly unavailable: string;
}

const RESOLUTIONS = ['triaged', 'actioned', 'dismissed', 'duplicate'] as const;
type Resolution = (typeof RESOLUTIONS)[number];

function resolutionFailure(
  result: { status: number | null; code: string | null },
  copy: ReportResolutionCopy,
): string {
  if (result.code === 'REPORT_ALREADY_FINAL') return copy.alreadyFinal;
  if (result.code === 'REPORT_IS_OWN') return copy.ownReport;
  if (result.status === 401) return copy.signedOut;
  if (result.status === 404) return copy.notFound;
  if (result.status === 400 || result.status === 403) return copy.invalid;
  return copy.unavailable;
}

export function ReportResolutionForm({
  reportId,
  copy,
}: {
  readonly reportId: string;
  readonly copy: ReportResolutionCopy;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<Resolution>('triaged');
  const [note, setNote] = useState('');
  const [duplicateOf, setDuplicateOf] = useState('');
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setMessage(null);

    // The pairings the database requires, checked here so a colleague is told before the round trip. The
    // database is still what enforces them.
    if (status !== 'triaged' && note.trim() === '') {
      setMessage(copy.noteRequired);
      return;
    }
    if (status === 'duplicate' && duplicateOf.trim() === '') {
      setMessage(copy.duplicateRequired);
      return;
    }
    setAsking(true);
  }

  async function confirm(): Promise<void> {
    if (pending) return;
    setPending(true);
    const result = await post('/api/moderation/reports/resolution', {
      reportId,
      status,
      ...(note.trim() === '' ? {} : { resolutionNote: note.trim() }),
      ...(status === 'duplicate' ? { duplicateOfReportId: duplicateOf.trim() } : {}),
    });
    setPending(false);

    if (result.status === 200) {
      setAsking(false);
      setNote('');
      setDuplicateOf('');
      router.refresh();
      return;
    }
    setAsking(false);
    setMessage(resolutionFailure(result, copy));
  }

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      aria-labelledby="report-decision"
      className="mt-8 max-w-prose rounded-lg border border-hairline p-4"
    >
      <h2 id="report-decision" className="text-sm font-medium text-ink-strong">
        {copy.heading}
      </h2>
      <p className="mt-1 text-xs text-ink-muted">{copy.hint}</p>

      <div className="mt-3">
        <label htmlFor="report-status" className="text-sm font-medium text-ink-strong">
          {copy.statusLabel}
        </label>
        <select
          id="report-status"
          name="status"
          disabled={pending}
          value={status}
          onChange={(event) => setStatus(event.target.value as Resolution)}
          className={FIELD_CLASS}
        >
          {RESOLUTIONS.map((value) => (
            <option key={value} value={value}>
              {copy.statuses[value]}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-3">
        <label htmlFor="report-note" className="text-sm font-medium text-ink-strong">
          {copy.noteLabel}
        </label>
        <p className="mt-1 text-xs text-ink-muted">{copy.noteHint}</p>
        <textarea
          id="report-note"
          name="resolutionNote"
          rows={3}
          maxLength={NOTE_MAX_LENGTH}
          disabled={pending}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          className={FIELD_CLASS}
        />
      </div>

      {status === 'duplicate' && (
        <div className="mt-3">
          <label htmlFor="report-duplicate" className="text-sm font-medium text-ink-strong">
            {copy.duplicateLabel}
          </label>
          <p className="mt-1 text-xs text-ink-muted">{copy.duplicateHint}</p>
          <input
            id="report-duplicate"
            name="duplicateOfReportId"
            type="text"
            inputMode="text"
            disabled={pending}
            value={duplicateOf}
            onChange={(event) => setDuplicateOf(event.target.value)}
            className={FIELD_CLASS}
          />
        </div>
      )}

      {message !== null && (
        <p role="alert" className="mt-3 text-sm font-medium text-ink-strong">
          {message}
        </p>
      )}

      {asking ? (
        <div className="mt-4">
          <p className="text-sm font-medium text-ink-strong">{copy.question}</p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button type="button" disabled={pending} onClick={() => void confirm()} className={BUTTON_CLASS}>
              {pending ? copy.working : copy.confirm}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setAsking(false)}
              className={SECONDARY_CLASS}
            >
              {copy.cancel}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4">
          <button type="submit" disabled={pending} className={BUTTON_CLASS}>
            {copy.submit}
          </button>
        </div>
      )}
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* A decision about a listing                                                                        */
/* ------------------------------------------------------------------------------------------------ */

export interface ListingModerationCopy {
  readonly heading: string;
  readonly hint: string;
  readonly actionLabel: string;
  /** The five the existing writer defines. There is no sixth. */
  readonly actions: Readonly<
    Record<'approve' | 'reject' | 'suspend' | 'reinstate' | 'request_changes', string>
  >;
  readonly reasonLabel: string;
  readonly reasonHint: string;
  readonly reasonRequired: string;
  readonly reasonTooLong: string;
  readonly submit: string;
  readonly working: string;
  readonly confirm: string;
  readonly cancel: string;
  readonly question: string;
  readonly notFound: string;
  readonly noChange: string;
  readonly notApplicable: string;
  readonly ownListing: string;
  readonly invalid: string;
  readonly signedOut: string;
  readonly unavailable: string;
}

const ACTIONS = ['approve', 'reject', 'suspend', 'reinstate', 'request_changes'] as const;
type Action = (typeof ACTIONS)[number];

function listingFailure(
  result: { status: number | null; code: string | null },
  copy: ListingModerationCopy,
): string {
  if (result.code === 'LISTING_MODERATION_NO_CHANGE') return copy.noChange;
  if (result.code === 'LISTING_MODERATION_NOT_APPLICABLE') return copy.notApplicable;
  if (result.code === 'LISTING_IS_OWN') return copy.ownListing;
  if (result.status === 401) return copy.signedOut;
  if (result.status === 404) return copy.notFound;
  if (result.status === 400 || result.status === 403) return copy.invalid;
  return copy.unavailable;
}

export function ListingModerationForm({
  listingId,
  copy,
}: {
  readonly listingId: string;
  readonly copy: ListingModerationCopy;
}) {
  const router = useRouter();
  const [action, setAction] = useState<Action>('approve');
  const [reason, setReason] = useState('');
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setMessage(null);
    if (reason.trim() === '') {
      setMessage(copy.reasonRequired);
      return;
    }
    if (reason.trim().length > REASON_MAX_LENGTH) {
      setMessage(copy.reasonTooLong);
      return;
    }
    setAsking(true);
  }

  async function confirm(): Promise<void> {
    if (pending) return;
    setPending(true);
    const result = await post('/api/moderation/listings/action', {
      listingId,
      action,
      reason: reason.trim(),
    });
    setPending(false);

    if (result.status === 200) {
      setAsking(false);
      setReason('');
      router.refresh();
      return;
    }
    setAsking(false);
    setMessage(listingFailure(result, copy));
  }

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      aria-labelledby="listing-decision"
      className="mt-8 max-w-prose rounded-lg border border-hairline p-4"
    >
      <h2 id="listing-decision" className="text-sm font-medium text-ink-strong">
        {copy.heading}
      </h2>
      <p className="mt-1 text-xs text-ink-muted">{copy.hint}</p>

      <div className="mt-3">
        <label htmlFor="listing-action" className="text-sm font-medium text-ink-strong">
          {copy.actionLabel}
        </label>
        <select
          id="listing-action"
          name="action"
          disabled={pending}
          value={action}
          onChange={(event) => setAction(event.target.value as Action)}
          className={FIELD_CLASS}
        >
          {ACTIONS.map((value) => (
            <option key={value} value={value}>
              {copy.actions[value]}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-3">
        <label htmlFor="listing-reason" className="text-sm font-medium text-ink-strong">
          {copy.reasonLabel}
        </label>
        <p className="mt-1 text-xs text-ink-muted">{copy.reasonHint}</p>
        <textarea
          id="listing-reason"
          name="reason"
          rows={3}
          maxLength={REASON_MAX_LENGTH}
          disabled={pending}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className={FIELD_CLASS}
        />
      </div>

      {message !== null && (
        <p role="alert" className="mt-3 text-sm font-medium text-ink-strong">
          {message}
        </p>
      )}

      {asking ? (
        <div className="mt-4">
          <p className="text-sm font-medium text-ink-strong">{copy.question}</p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button type="button" disabled={pending} onClick={() => void confirm()} className={BUTTON_CLASS}>
              {pending ? copy.working : copy.confirm}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setAsking(false)}
              className={SECONDARY_CLASS}
            >
              {copy.cancel}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4">
          <button type="submit" disabled={pending} className={BUTTON_CLASS}>
            {copy.submit}
          </button>
        </div>
      )}
    </form>
  );
}
