'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Sending a brief for the platform to handle — Option 2 (Phase 7-J).
 *
 * **The buyer does not choose a routing mode, and this form has no field for one.** It sends a title, a brief,
 * how they would prefer to pay, and optionally a budget and a date. The server decides that this is the
 * platform's to answer, by which operation was called; there is no seller, no listing and no currency here,
 * and adding one would change nothing because the BFF rebuilds the body from the contract.
 *
 * **The payment fields are descriptive, and the form says so.** They are two sentences a person types about
 * how they would like to pay. Nothing here asks for a card, an account, a password, a code or anything a
 * provider could use, no such value could be stored if it were typed, and neither field is sent anywhere but
 * to this platform's own database — where both are cleared ninety days after the request closes.
 *
 * Validated here **and** in the contract **and** in the database. The bounds below are the schema's own, stated
 * so somebody learns what is wrong before they send; the database is the authority and would refuse the same
 * things.
 *
 * **No currency is named in this form**, because the platform's own default currency is what an Admin Only
 * brief is recorded in and the server reads it: a currency shown here would be a second copy of that setting,
 * and a wrong one would be a lie about somebody's budget. The hint says which unit the number is in.
 *
 * On success the reader is taken back to their service requests, which is where the answer will appear.
 */

export interface RequestPlatformHelpCopy {
  readonly action: string;
  readonly heading: string;
  readonly intro: string;
  readonly titleLabel: string;
  readonly briefLabel: string;
  readonly methodLabel: string;
  readonly methodHint: string;
  readonly notesLabel: string;
  readonly budgetLabel: string;
  readonly budgetHint: string;
  readonly neededByLabel: string;
  readonly send: string;
  readonly cancel: string;
  readonly working: string;
  readonly titleRequired: string;
  readonly briefRequired: string;
  readonly methodRequired: string;
  readonly notesTooLong: string;
  readonly budgetInvalid: string;
  readonly noSellerNote: string;
  readonly failedSignedOut: string;
  readonly failedGeneric: string;
}

const FIELD = 'mt-1 w-full rounded-md border border-edge p-2 text-sm';

export function RequestPlatformHelpButton({ copy }: { readonly copy: RequestPlatformHelpCopy }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [method, setMethod] = useState('');
  const [notes, setNotes] = useState('');
  const [budget, setBudget] = useState('');
  const [neededBy, setNeededBy] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The schema's own bounds, restated so the form can say what is wrong before it sends.
  const titleText = title.trim();
  const titleInvalid = titleText.length < 3 || titleText.length > 140;
  const briefText = brief.trim();
  const briefInvalid = briefText.length < 10 || briefText.length > 10_000;
  const methodText = method.trim();
  const methodInvalid = methodText.length < 1 || methodText.length > 120;
  const notesText = notes.trim();
  const notesInvalid = notesText.length > 2000;
  const budgetText = budget.trim();
  const budgetInvalid = budgetText !== '' && !/^[1-9][0-9]{0,18}$/.test(budgetText);
  const blocked = titleInvalid || briefInvalid || methodInvalid || notesInvalid || budgetInvalid;

  async function submit(): Promise<void> {
    if (pending || blocked) return;
    setError(null);
    setPending(true);
    try {
      const response = await fetch('/api/service-requests/admin-only', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: titleText,
          brief: briefText,
          preferredPaymentMethod: methodText,
          ...(notesText === '' ? {} : { paymentNotes: notesText }),
          ...(budgetText === '' ? {} : { budgetMinor: budgetText }),
          ...(neededBy === '' ? {} : { neededBy }),
        }),
      });
      if (response.status === 201) {
        setOpen(false);
        setTitle('');
        setBrief('');
        setMethod('');
        setNotes('');
        setBudget('');
        setNeededBy('');
        router.refresh();
        return;
      }
      setError(response.status === 401 ? copy.failedSignedOut : copy.failedGeneric);
    } catch {
      setError(copy.failedGeneric);
    } finally {
      setPending(false);
    }
  }

  if (!open) {
    return (
      <div>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
          className="rounded-md border border-edge-strong px-4 py-2 text-sm font-medium text-ink-strong"
        >
          {copy.action}
        </button>
        {error !== null && (
          <p role="alert" className="mt-2 max-w-prose text-sm font-medium text-ink-strong">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <form
      className="max-w-prose rounded-lg border border-edge p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="text-base font-medium text-ink-strong">{copy.heading}</p>
      <p className="mt-1 max-w-prose text-sm text-ink-muted">{copy.intro}</p>

      <label htmlFor="platform-title" className="mt-3 block text-sm font-medium text-ink-strong">
        {copy.titleLabel}
      </label>
      <input
        id="platform-title"
        name="title"
        value={title}
        maxLength={140}
        onChange={(event) => setTitle(event.target.value)}
        {...(title !== '' && titleInvalid ? { 'aria-invalid': true } : {})}
        className={FIELD}
      />
      {title !== '' && titleInvalid && (
        <p role="alert" className="mt-1 text-sm font-medium text-ink-strong">
          {copy.titleRequired}
        </p>
      )}

      <label htmlFor="platform-brief" className="mt-3 block text-sm font-medium text-ink-strong">
        {copy.briefLabel}
      </label>
      <textarea
        id="platform-brief"
        name="brief"
        rows={5}
        maxLength={10_000}
        value={brief}
        onChange={(event) => setBrief(event.target.value)}
        {...(brief !== '' && briefInvalid ? { 'aria-invalid': true } : {})}
        className={FIELD}
      />
      {brief !== '' && briefInvalid && (
        <p role="alert" className="mt-1 text-sm font-medium text-ink-strong">
          {copy.briefRequired}
        </p>
      )}

      <label htmlFor="platform-method" className="mt-3 block text-sm font-medium text-ink-strong">
        {copy.methodLabel}
      </label>
      <p id="platform-method-hint" className="mt-1 max-w-prose text-xs text-ink-muted">
        {copy.methodHint}
      </p>
      <input
        id="platform-method"
        name="preferredPaymentMethod"
        value={method}
        maxLength={120}
        autoComplete="off"
        onChange={(event) => setMethod(event.target.value)}
        aria-describedby="platform-method-hint"
        {...(method !== '' && methodInvalid ? { 'aria-invalid': true } : {})}
        className={FIELD}
      />
      {method !== '' && methodInvalid && (
        <p role="alert" className="mt-1 text-sm font-medium text-ink-strong">
          {copy.methodRequired}
        </p>
      )}

      <label htmlFor="platform-notes" className="mt-3 block text-sm font-medium text-ink-strong">
        {copy.notesLabel}
      </label>
      <textarea
        id="platform-notes"
        name="paymentNotes"
        rows={3}
        maxLength={2000}
        autoComplete="off"
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
        {...(notesInvalid ? { 'aria-invalid': true } : {})}
        className={FIELD}
      />
      {notesInvalid && (
        <p role="alert" className="mt-1 text-sm font-medium text-ink-strong">
          {copy.notesTooLong}
        </p>
      )}

      <label htmlFor="platform-budget" className="mt-3 block text-sm font-medium text-ink-strong">
        {copy.budgetLabel}
      </label>
      <p id="platform-budget-hint" className="mt-1 text-xs text-ink-muted">
        {copy.budgetHint}
      </p>
      <input
        id="platform-budget"
        name="budgetMinor"
        inputMode="numeric"
        value={budget}
        onChange={(event) => setBudget(event.target.value)}
        aria-describedby="platform-budget-hint"
        {...(budgetInvalid ? { 'aria-invalid': true } : {})}
        className={FIELD}
      />
      {budgetInvalid && (
        <p role="alert" className="mt-1 text-sm font-medium text-ink-strong">
          {copy.budgetInvalid}
        </p>
      )}

      <label htmlFor="platform-needed-by" className="mt-3 block text-sm font-medium text-ink-strong">
        {copy.neededByLabel}
      </label>
      <input
        id="platform-needed-by"
        name="neededBy"
        type="date"
        value={neededBy}
        onChange={(event) => setNeededBy(event.target.value)}
        className="mt-1 rounded-md border border-edge p-2 text-sm"
      />

      <p className="mt-4 max-w-prose rounded-md border border-edge p-3 text-sm text-ink-body" role="note">
        {copy.noSellerNote}
      </p>

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={pending || blocked}
          className="rounded-md bg-surface-ink px-4 py-2 text-sm font-medium text-on-ink disabled:opacity-60"
        >
          {pending ? copy.working : copy.send}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="rounded-md border border-edge px-4 py-2 text-sm text-ink-strong disabled:opacity-60"
        >
          {copy.cancel}
        </button>
      </div>

      {error !== null && (
        <p role="alert" className="mt-3 text-sm font-medium text-ink-strong">
          {error}
        </p>
      )}
    </form>
  );
}
