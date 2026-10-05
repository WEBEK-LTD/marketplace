'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * The "request a quote" action on a service detail page (Phase 7-I).
 *
 * **Why it carries no session state**, exactly as the offer action of 7-H and the contact action of 5-E do
 * not: the service page is public and cacheable, and reading the session on it would change what that frozen
 * surface is. So this button does not know whether the visitor is signed in and does not ask — it offers the
 * action, and a 401 from the BFF, the only authority on that question, turns it into a link to sign in. The
 * markup is identical for everybody and stays cacheable.
 *
 * **It cannot know whether the visitor is the seller either**, for the same reason. The database does, and says
 * so with its own code; that answer becomes a sentence here rather than a hidden button.
 *
 * **What crosses.** A listing identifier, a title, a brief, and optionally a budget and a date. There is no
 * seller field and no currency field: both are derived from the listing inside the database. The currency is
 * *shown* here because a person typing a budget needs to know the unit — it is the service's own — but it is
 * never sent. There is no status, no acceptance time and no payment deadline: a brief has none of those yet.
 *
 * On success the visitor is taken to their own service requests, which is where the exchange continues.
 */

export interface RequestQuoteCopy {
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

export function RequestQuoteButton({
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
  readonly copy: RequestQuoteCopy;
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
          className="inline-block rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-900"
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
          className="rounded-md border border-neutral-900 px-4 py-2 text-sm font-medium text-neutral-900"
        >
          {copy.action}
        </button>
        {error !== null && (
          <p role="alert" className="mt-2 max-w-prose text-sm font-medium text-neutral-900">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <form
      className="max-w-prose rounded-lg border border-neutral-300 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="text-base font-medium text-neutral-900">{copy.heading}</p>

      <label htmlFor="request-title" className="mt-3 block text-sm font-medium text-neutral-900">
        {copy.titleLabel}
      </label>
      <input
        id="request-title"
        name="title"
        value={title}
        maxLength={140}
        onChange={(event) => setTitle(event.target.value)}
        {...(title !== '' && titleInvalid ? { 'aria-invalid': true } : {})}
        className="mt-1 w-full rounded-md border border-neutral-300 p-2 text-sm"
      />
      {title !== '' && titleInvalid && (
        <p role="alert" className="mt-1 text-sm font-medium text-neutral-900">
          {copy.titleRequired}
        </p>
      )}

      <label htmlFor="request-brief" className="mt-3 block text-sm font-medium text-neutral-900">
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
        className="mt-1 w-full rounded-md border border-neutral-300 p-2 text-sm"
      />
      {brief !== '' && briefInvalid && (
        <p role="alert" className="mt-1 text-sm font-medium text-neutral-900">
          {copy.briefRequired}
        </p>
      )}

      <label htmlFor="request-budget" className="mt-3 block text-sm font-medium text-neutral-900">
        {copy.budgetLabel} ({currencyCode})
      </label>
      <p id="request-budget-hint" className="mt-1 text-xs text-neutral-600">
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
        className="mt-1 w-full rounded-md border border-neutral-300 p-2 text-sm"
      />
      {budgetInvalid && (
        <p role="alert" className="mt-1 text-sm font-medium text-neutral-900">
          {copy.budgetInvalid}
        </p>
      )}

      <label htmlFor="request-needed-by" className="mt-3 block text-sm font-medium text-neutral-900">
        {copy.neededByLabel}
      </label>
      <input
        id="request-needed-by"
        name="neededBy"
        type="date"
        value={neededBy}
        onChange={(event) => setNeededBy(event.target.value)}
        className="mt-1 rounded-md border border-neutral-300 p-2 text-sm"
      />

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={pending || titleInvalid || briefInvalid || budgetInvalid}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
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
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm text-neutral-900 disabled:opacity-60"
        >
          {copy.cancel}
        </button>
      </div>

      {error !== null && (
        <p role="alert" className="mt-3 text-sm font-medium text-neutral-900">
          {error}
        </p>
      )}
    </form>
  );
}
