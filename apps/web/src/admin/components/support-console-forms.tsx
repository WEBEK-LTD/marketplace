'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { adminApiPath } from '../paths';

/**
 * The four controls of the support agent console (Phase 7-L).
 *
 * All four are thin: each sends one identifier and, where it has one, one field. What they deliberately do
 * **not** contain is as important:
 *
 * - **No agent, and no way to name one.** Claiming assigns the session's own account; there is no picker, no
 *   list of colleagues and no field that could carry an account. Releasing gives a ticket back to everybody
 *   rather than to somebody.
 * - **No status except the two outcomes.** The decision control sends `resolved` or `closed` — the two the
 *   existing writer defines — and nothing here can send another, nor reopen anything.
 * - **No priority, no reason, no assignee, no author.** None of them is stored by the write behind these
 *   forms, so none of them is collected.
 * - **No optimistic row.** A draft is cleared and the screen refreshed only after the server has confirmed;
 *   anything else leaves the text where it is and says what happened. A colleague who lost a paragraph to a
 *   failed request has lost more than the request.
 * - **No identifiers on screen.** The words for a refusal are the ones the page passed in, never a sentence
 *   the server composed.
 *
 * The two irreversible steps — resolving and closing — ask twice, because nothing on this surface reopens a
 * ticket.
 */

const BUTTON_CLASS =
  'rounded-md bg-surface-ink px-4 py-2 text-sm font-medium text-on-ink disabled:opacity-60';
const SECONDARY_CLASS =
  'rounded-md border border-edge px-4 py-2 text-sm font-medium text-ink-strong disabled:opacity-60';
const FIELD_CLASS =
  'mt-1 w-full rounded-md border border-edge px-3 py-2 text-sm text-ink-strong';

/** `support_messages_body_length` and `support_internal_notes_body_length`, which are the same bound. */
const BODY_MAX_LENGTH = 8000;

export interface ConsoleFailureCopy {
  readonly notFound: string;
  readonly conflict: string;
  readonly invalid: string;
  readonly signedOut: string;
  readonly unavailable: string;
}

/** The one place a refusal becomes a sentence. Nothing here interpolates a value from the server. */
function failureMessage(status: number, copy: ConsoleFailureCopy): string {
  if (status === 401) return copy.signedOut;
  if (status === 404) return copy.notFound;
  if (status === 409) return copy.conflict;
  if (status === 400 || status === 403) return copy.invalid;
  return copy.unavailable;
}

async function post(path: string, body: Record<string, unknown>): Promise<number | null> {
  try {
    const response = await fetch(adminApiPath(path), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    await response.text().catch(() => '');
    return response.status;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* Claiming and releasing                                                                            */
/* ------------------------------------------------------------------------------------------------ */

export interface AssignmentCopy extends ConsoleFailureCopy {
  readonly action: string;
  readonly working: string;
}

/**
 * One button, either taking a ticket or giving it back.
 *
 * The step is the route, not a field: there is no operation here that could be pointed at a different one, and
 * neither sends anything about who should hold the ticket.
 */
export function SupportAssignmentForm({
  ticketId,
  step,
  copy,
}: {
  readonly ticketId: string;
  readonly step: 'claim' | 'release';
  readonly copy: AssignmentCopy;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (pending) return;
    setError(null);
    setPending(true);
    const status = await post(`/api/support/${step}`, { ticketId });
    setPending(false);

    if (status === 200) {
      router.refresh();
      return;
    }
    setError(status === null ? copy.unavailable : failureMessage(status, copy));
  }

  return (
    <div className="mt-4">
      <button type="button" disabled={pending} onClick={() => void submit()} className={SECONDARY_CLASS}>
        {pending ? copy.working : copy.action}
      </button>
      {error !== null && (
        <p role="alert" className="mt-2 max-w-prose text-sm font-medium text-ink-strong">
          {error}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Replying and noting                                                                               */
/* ------------------------------------------------------------------------------------------------ */

export interface ComposerCopy extends ConsoleFailureCopy {
  readonly label: string;
  readonly hint: string;
  readonly send: string;
  readonly sending: string;
  readonly required: string;
  readonly tooLong: string;
}

function Composer({
  ticketId,
  path,
  expected,
  fieldId,
  copy,
  dashed,
}: {
  readonly ticketId: string;
  readonly path: string;
  readonly expected: number;
  readonly fieldId: string;
  readonly copy: ComposerCopy;
  readonly dashed: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setMessage(null);

    const trimmed = draft.trim();
    if (trimmed === '') {
      setMessage(copy.required);
      return;
    }
    if (trimmed.length > BODY_MAX_LENGTH) {
      setMessage(copy.tooLong);
      return;
    }

    setPending(true);
    const status = await post(path, { ticketId, body: trimmed });
    setPending(false);

    if (status === expected) {
      setDraft('');
      router.refresh();
      return;
    }
    setMessage(status === null ? copy.unavailable : failureMessage(status, copy));
  }

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className={
        dashed
          ? 'mt-8 max-w-prose rounded-lg border border-dashed border-edge-strong p-4'
          : 'mt-8 max-w-prose rounded-lg border border-hairline p-4'
      }
    >
      <label htmlFor={fieldId} className="text-sm font-medium text-ink-strong">
        {copy.label}
      </label>
      <p className="mt-1 text-xs text-ink-muted">{copy.hint}</p>
      <textarea
        id={fieldId}
        name="body"
        rows={4}
        maxLength={BODY_MAX_LENGTH}
        disabled={pending}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className={FIELD_CLASS}
      />
      {message !== null && (
        <p role="alert" className="mt-2 text-sm font-medium text-ink-strong">
          {message}
        </p>
      )}
      <div className="mt-3">
        <button type="submit" disabled={pending} className={BUTTON_CLASS}>
          {pending ? copy.sending : copy.send}
        </button>
      </div>
    </form>
  );
}

/** A message to the requester. It will be visible to them; the note form below will not. */
export function SupportReplyForm({
  ticketId,
  copy,
}: {
  readonly ticketId: string;
  readonly copy: ComposerCopy;
}) {
  return (
    <Composer
      ticketId={ticketId}
      path="/api/support/reply"
      expected={201}
      fieldId="support-reply"
      copy={copy}
      dashed={false}
    />
  );
}

/** A note for colleagues. A different route, a different table, and no requester can read it. */
export function SupportNoteForm({
  ticketId,
  copy,
}: {
  readonly ticketId: string;
  readonly copy: ComposerCopy;
}) {
  return (
    <Composer
      ticketId={ticketId}
      path="/api/support/note"
      expected={201}
      fieldId="support-note"
      copy={copy}
      dashed
    />
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* The decision                                                                                      */
/* ------------------------------------------------------------------------------------------------ */

export interface DecisionCopy extends ConsoleFailureCopy {
  readonly heading: string;
  readonly hint: string;
  /**
   * The resolve control's words, or `null` when resolving is not on offer — an already resolved ticket.
   *
   * Nullable rather than paired with a boolean on purpose: a prop is serialized into the payload whether or not
   * the branch reading it renders, so a `canResolve={false}` beside a `resolve` string would still ship the
   * words for a control that is not there. Absent copy is an absent control.
   */
  readonly resolve: string | null;
  readonly close: string;
  readonly resolveQuestion: string | null;
  readonly closeQuestion: string;
  readonly confirm: string;
  readonly cancel: string;
  readonly working: string;
}

/**
 * The two outcomes, each behind a confirmation.
 *
 * `resolved` and `closed` are the only values this component can send, as two separate buttons rather than a
 * free field — so there is no state in the schema a colleague could type their way into. Both are final in the
 * sense that matters: nothing in this application reopens a ticket, and the confirmation says so.
 */
export function SupportDecisionForm({
  ticketId,
  copy,
}: {
  readonly ticketId: string;
  readonly copy: DecisionCopy;
}) {
  const router = useRouter();
  const [asking, setAsking] = useState<'resolved' | 'closed' | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(status: 'resolved' | 'closed'): Promise<void> {
    if (pending) return;
    setError(null);
    setPending(true);
    const result = await post('/api/support/decision', { ticketId, status });
    setPending(false);

    if (result === 200) {
      setAsking(null);
      router.refresh();
      return;
    }
    setError(result === null ? copy.unavailable : failureMessage(result, copy));
  }

  return (
    <section aria-labelledby="ticket-decision" className="mt-8 max-w-prose rounded-lg border border-hairline p-4">
      <h2 id="ticket-decision" className="text-sm font-medium text-ink-strong">
        {copy.heading}
      </h2>
      <p className="mt-1 text-xs text-ink-muted">{copy.hint}</p>

      {asking === null ? (
        <div className="mt-3 flex flex-wrap gap-3">
          {copy.resolve !== null && (
            <button
              type="button"
              onClick={() => {
                setError(null);
                setAsking('resolved');
              }}
              className={SECONDARY_CLASS}
            >
              {copy.resolve}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setError(null);
              setAsking('closed');
            }}
            className={SECONDARY_CLASS}
          >
            {copy.close}
          </button>
        </div>
      ) : (
        <div className="mt-3">
          <p className="text-sm font-medium text-ink-strong">
            {asking === 'resolved' ? (copy.resolveQuestion ?? copy.heading) : copy.closeQuestion}
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              disabled={pending}
              onClick={() => void submit(asking)}
              className={BUTTON_CLASS}
            >
              {pending ? copy.working : copy.confirm}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setAsking(null);
                setError(null);
              }}
              className={SECONDARY_CLASS}
            >
              {copy.cancel}
            </button>
          </div>
        </div>
      )}

      {error !== null && (
        <p role="alert" className="mt-3 text-sm font-medium text-ink-strong">
          {error}
        </p>
      )}
    </section>
  );
}
