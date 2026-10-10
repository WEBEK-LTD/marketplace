'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * The enquiry action on a listing detail page (OD-A4).
 *
 * **This was 7-I's "request a quote" button and it is the same form**, repointed. OD-A4 removed the seller as
 * a counterparty, and `POST /api/service-requests` now creates an office-routed enquiry instead of a brief
 * for a seller to quote on — so the body it sends, the refusals it renders and the page it lands on are all
 * unchanged, while who answers is not. The form was kept rather than rewritten because a buyer's side of the
 * exchange did not change: they still name a listing, a title, a brief and optionally a budget and a date.
 *
 * **Why it carries no session state**, exactly as the contact action of 5-E does not: a detail page is public
 * and cacheable, and reading the session on it would change what that frozen surface is. So this button does
 * not know whether the visitor is signed in and does not ask — it offers the action, and a 401 from the BFF,
 * the only authority on that question, turns it into a link to sign in. The markup is identical for everybody
 * and stays cacheable.
 *
 * **It cannot know whether the visitor owns the listing either**, for the same reason. The database does, and
 * answers 404 for a visitor's own listing — deliberately the same answer an absent listing gets, so asking
 * cannot reveal who owns one. That answer becomes a sentence here rather than a hidden button.
 *
 * **What crosses.** A listing identifier, a title, a brief, and optionally a budget and a date. There is no
 * seller field, no currency field and no routing field: all three are derived inside the database, and the
 * routing is a literal there, so nothing a caller sends can reach a seller. The currency is *shown* here
 * because a person typing a budget needs to know the unit — it is the listing's own — but it is never sent.
 *
 * On success the visitor is taken to their own enquiries, which is where the exchange continues.
 */

export interface EnquiryCopy {
  readonly action: string;
  readonly heading: string;
  readonly titleLabel: string;
  readonly briefLabel: string;
  readonly budgetLabel: string;
  readonly budgetHint: string;
  readonly neededByLabel: string;
  readonly send: string;
  readonly cancel: string;
  readonly working: string;
  readonly titleRequired: string;
  readonly briefRequired: string;
  readonly budgetInvalid: string;
  readonly signIn: string;
  readonly failedNotCustom: string;
  readonly failedOwnListing: string;
  readonly failedNotAvailable: string;
  readonly failedBlocked: string;
  readonly failedGeneric: string;
}

export function EnquireButton({
  listingId,
  currencyCode,
  requestsPath,
  loginPath,
  copy,
}: {
  readonly listingId: string;
  /** The service's own currency, shown so a person knows what unit they are typing. Never sent. */
  readonly currencyCode: string;
  readonly requestsPath: string;
  readonly loginPath: string;
  readonly copy: EnquiryCopy;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [budget, setBudget] = useState('');
  const [neededBy, setNeededBy] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);

  // The schema's own bounds, restated so a form can say what is wrong before it sends. The database holds
  // the same three checks, and they are the authority.
  const titleText = title.trim();
  const titleInvalid = titleText.length < 3 || titleText.length > 140;
  const briefText = brief.trim();
  const briefInvalid = briefText.length < 10 || briefText.length > 10_000;
  const budgetText = budget.trim();
  const budgetInvalid = budgetText !== '' && !/^[1-9][0-9]{0,18}$/.test(budgetText);

  async function submit(): Promise<void> {
    if (pending || titleInvalid || briefInvalid || budgetInvalid) return;
    setError(null);
    setPending(true);
    try {
      const response = await fetch('/api/service-requests', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          listingId,
          title: titleText,
          brief: briefText,
          ...(budgetText === '' ? {} : { budgetMinor: budgetText }),
          ...(neededBy === '' ? {} : { neededBy }),
        }),
      });
      if (response.status === 201) {
        router.push(requestsPath);
        return;
      }
      if (response.status === 401) {
        // The BFF is the only thing that knows; now that it has said so, offer the way in.
        setSignedOut(true);
        return;
      }
      setError(await messageFor(response));
    } catch {
      setError(copy.failedGeneric);
    } finally {
      setPending(false);
    }
  }

  async function messageFor(response: Response): Promise<string> {
    let code: unknown = null;
    try {
      const body: unknown = await response.json();
      code = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['code'] : null;
    } catch {
      code = null;
    }
    if (code === 'SERVICE_REQUEST_NOT_CUSTOM') return copy.failedNotCustom;
    if (code === 'SERVICE_REQUEST_OWN_LISTING') return copy.failedOwnListing;
    if (code === 'SERVICE_REQUEST_NOT_AVAILABLE') return copy.failedNotAvailable;
    if (code === 'SERVICE_REQUEST_BLOCKED') return copy.failedBlocked;
    return copy.failedGeneric;
  }

  if (signedOut) {
    return (
      <div>
        <Link
          href={loginPath}
          className="inline-block rounded-md border border-edge px-4 py-2 text-sm font-medium text-ink-strong"
        >
          {copy.signIn}
        </Link>
      </div>
    );
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

      <label htmlFor="request-title" className="mt-3 block text-sm font-medium text-ink-strong">
        {copy.titleLabel}
      </label>
      <input
        id="request-title"
        name="title"
        value={title}
        maxLength={140}
        onChange={(event) => setTitle(event.target.value)}
        {...(title !== '' && titleInvalid ? { 'aria-invalid': true } : {})}
        className="mt-1 w-full rounded-md border border-edge p-2 text-sm"
      />
      {title !== '' && titleInvalid && (
        <p role="alert" className="mt-1 text-sm font-medium text-ink-strong">
          {copy.titleRequired}
        </p>
      )}

      <label htmlFor="request-brief" className="mt-3 block text-sm font-medium text-ink-strong">
        {copy.briefLabel}
      </label>
      <textarea
        id="request-brief"
        name="brief"
        rows={5}
        maxLength={10_000}
        value={brief}
        onChange={(event) => setBrief(event.target.value)}
        {...(brief !== '' && briefInvalid ? { 'aria-invalid': true } : {})}
        className="mt-1 w-full rounded-md border border-edge p-2 text-sm"
      />
      {brief !== '' && briefInvalid && (
        <p role="alert" className="mt-1 text-sm font-medium text-ink-strong">
          {copy.briefRequired}
        </p>
      )}

      <label htmlFor="request-budget" className="mt-3 block text-sm font-medium text-ink-strong">
        {copy.budgetLabel} ({currencyCode})
      </label>
      <p id="request-budget-hint" className="mt-1 text-xs text-ink-muted">
        {copy.budgetHint}
      </p>
      <input
        id="request-budget"
        name="budgetMinor"
        inputMode="numeric"
        value={budget}
        onChange={(event) => setBudget(event.target.value)}
        aria-describedby="request-budget-hint"
        {...(budgetInvalid ? { 'aria-invalid': true } : {})}
        className="mt-1 w-full rounded-md border border-edge p-2 text-sm"
      />
      {budgetInvalid && (
        <p role="alert" className="mt-1 text-sm font-medium text-ink-strong">
          {copy.budgetInvalid}
        </p>
      )}

      <label htmlFor="request-needed-by" className="mt-3 block text-sm font-medium text-ink-strong">
        {copy.neededByLabel}
      </label>
      <input
        id="request-needed-by"
        name="neededBy"
        type="date"
        value={neededBy}
        onChange={(event) => setNeededBy(event.target.value)}
        className="mt-1 rounded-md border border-edge p-2 text-sm"
      />

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={pending || titleInvalid || briefInvalid || budgetInvalid}
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
