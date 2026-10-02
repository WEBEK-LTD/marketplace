'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { accountRequest } from './account-request';

/**
 * Creating and editing a saved search (Phase 7-E).
 *
 * **Three fields, because three are what a person owns**: what it is called, what it searches for, and
 * whether it notifies. `lastMatchedAt` and `lastNotifiedAt` are not inputs here and are not in the
 * payload — they are a matching engine's bookkeeping, no matching engine exists, and a form that offered
 * them would be offering to claim something happened that did not.
 *
 * **`notify` is a stored preference.** Turning it on saves a boolean. It schedules nothing, sends
 * nothing and creates no notification, and the label beside it says so rather than implying a service
 * that is not there.
 *
 * **The server is authoritative.** The checks here are the shared contract's own, applied so a mistyped
 * name is caught before a round trip; every one is applied again upstream, and a value this form
 * accepted can still be refused — a name already taken comes back as its own answer, which is why the
 * conflict has a sentence of its own.
 *
 * **A failure never clears the form.** The values live in one state object that no failure path touches.
 */

export interface SavedSearchFormLabels {
  readonly name: string;
  readonly nameHint: string;
  readonly terms: string;
  readonly termsHint: string;
  readonly notify: string;
  readonly notifyHint: string;
  readonly save: string;
  readonly saving: string;
  readonly saved: string;
  readonly cancel: string;
  readonly required: string;
  readonly nameTaken: string;
  readonly invalid: string;
  readonly missing: string;
  readonly signedOut: string;
  readonly failed: string;
}

const FIELD_CLASS =
  'mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-base text-neutral-900 focus:border-neutral-900 focus:outline-none';
const LABEL_CLASS = 'block text-sm font-medium text-neutral-900';

export interface SavedSearchInitial {
  readonly id: string | null;
  readonly name: string;
  readonly terms: string;
  readonly notify: boolean;
}

/** The query object a person typed, as one free-text term. The schema accepts any object of parameters. */
function queryFrom(terms: string): Record<string, string> {
  const trimmed = terms.trim();
  return trimmed === '' ? {} : { q: trimmed };
}

export function SavedSearchForm({
  labels,
  initial,
  onDone,
}: {
  readonly labels: SavedSearchFormLabels;
  readonly initial: SavedSearchInitial;
  readonly onDone?: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [terms, setTerms] = useState(initial.terms);
  const [notify, setNotify] = useState(initial.notify);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    setSaved(false);

    if (name.trim() === '') {
      setMessage(labels.required);
      return;
    }

    setPending(true);
    try {
      const outcome = await accountRequest(
        initial.id === null ? '/api/account/saved-searches' : `/api/account/saved-searches/${initial.id}`,
        {
          method: initial.id === null ? 'POST' : 'PATCH',
          body: { name: name.trim(), query: queryFrom(terms), notify },
        },
      );

      if (outcome.status === 'ok') {
        setSaved(true);
        if (initial.id === null) {
          setName('');
          setTerms('');
          setNotify(false);
        }
        onDone?.();
        router.refresh();
        return;
      }
      if (outcome.status === 'conflict') setMessage(labels.nameTaken);
      else if (outcome.status === 'invalid') setMessage(labels.invalid);
      else if (outcome.status === 'missing') setMessage(labels.missing);
      else if (outcome.status === 'signed-out') setMessage(labels.signedOut);
      else setMessage(labels.failed);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="mt-4 max-w-lg space-y-4" noValidate>
      <div>
        <label className={LABEL_CLASS} htmlFor="saved-search-name">
          {labels.name}
        </label>
        <input
          id="saved-search-name"
          name="name"
          value={name}
          maxLength={120}
          required
          onChange={(event) => {
            setName(event.target.value);
            setSaved(false);
          }}
          className={FIELD_CLASS}
          aria-describedby="saved-search-name-hint"
        />
        <p id="saved-search-name-hint" className="mt-1 text-xs text-neutral-600">
          {labels.nameHint}
        </p>
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor="saved-search-terms">
          {labels.terms}
        </label>
        <input
          id="saved-search-terms"
          name="terms"
          value={terms}
          onChange={(event) => {
            setTerms(event.target.value);
            setSaved(false);
          }}
          className={FIELD_CLASS}
          aria-describedby="saved-search-terms-hint"
        />
        <p id="saved-search-terms-hint" className="mt-1 text-xs text-neutral-600">
          {labels.termsHint}
        </p>
      </div>

      <div>
        <label className="flex items-start gap-2 text-sm text-neutral-900">
          <input
            type="checkbox"
            name="notify"
            checked={notify}
            onChange={(event) => {
              setNotify(event.target.checked);
              setSaved(false);
            }}
            className="mt-1"
          />
          <span>
            {labels.notify}
            <span className="mt-1 block text-xs font-normal text-neutral-600">{labels.notifyHint}</span>
          </span>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {pending ? labels.saving : labels.save}
        </button>
        {onDone !== undefined && (
          <button type="button" onClick={onDone} className="text-sm underline underline-offset-4">
            {labels.cancel}
          </button>
        )}
        {saved && (
          <span role="status" className="text-sm text-neutral-700">
            {labels.saved}
          </span>
        )}
        {message !== null && (
          <span role="alert" className="text-sm text-neutral-900">
            {message}
          </span>
        )}
      </div>
    </form>
  );
}

/** The create form, revealed by a button so the list is what a person sees first. */
export function NewSavedSearch({
  labels,
  addLabel,
}: {
  readonly labels: SavedSearchFormLabels;
  readonly addLabel: string;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-4 rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-900"
      >
        {addLabel}
      </button>
    );
  }
  return (
    <SavedSearchForm
      labels={labels}
      initial={{ id: null, name: '', terms: '', notify: false }}
      onDone={() => setOpen(false)}
    />
  );
}

/** The edit form for one existing saved search, revealed in place. */
export function EditSavedSearch({
  labels,
  editLabel,
  initial,
}: {
  readonly labels: SavedSearchFormLabels;
  readonly editLabel: string;
  readonly initial: SavedSearchInitial;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-900"
      >
        {editLabel}
      </button>
    );
  }
  return <SavedSearchForm labels={labels} initial={initial} onDone={() => setOpen(false)} />;
}
