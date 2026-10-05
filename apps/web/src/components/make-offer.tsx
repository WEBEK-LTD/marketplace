'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * The "make an offer" action on a listing detail page (Phase 7-H).
 *
 * **Why it carries no session state**, exactly as the contact action of 5-E does not: the listing page is
 * public and cacheable, and reading the session on it would change what that frozen surface is. So this
 * button does not know whether the visitor is signed in and does not ask — it offers the action, and a 401
 * from the BFF, the only authority on that question, turns it into a link to sign in. The markup is
 * identical for everybody and stays cacheable.
 *
 * **It cannot know whether the visitor is the seller either**, for the same reason. The database does, and
 * says so with its own code; that answer becomes a sentence here rather than a hidden button.
 *
 * **What crosses.** A listing identifier, an amount in minor units, a quantity and an optional note. There
 * is no seller field, no currency field and no expiry field: all three are derived from the listing inside
 * the database. The currency is *shown* here because a person typing an amount needs to know what they are
 * typing it in, and it is the listing's own — but it is never sent.
 *
 * On success the visitor is taken to their offers, which is where the negotiation continues.
 */

export interface MakeOfferCopy {
  readonly action: string;
  readonly heading: string;
  readonly amountLabel: string;
  readonly amountHint: string;
  readonly quantityLabel: string;
  readonly noteLabel: string;
  readonly send: string;
  readonly cancel: string;
  readonly working: string;
  readonly amountRequired: string;
  readonly signIn: string;
  readonly failedAlreadyOpen: string;
  readonly failedOwnListing: string;
  readonly failedNotAvailable: string;
  readonly failedBlocked: string;
  readonly failedGeneric: string;
}

export function MakeOfferButton({
  listingId,
  currencyCode,
  offersPath,
  loginPath,
  copy,
}: {
  readonly listingId: string;
  /** The listing's own currency, shown so a person knows what unit they are typing. Never sent. */
  readonly currencyCode: string;
  readonly offersPath: string;
  readonly loginPath: string;
  readonly copy: MakeOfferCopy;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);

  const digits = amount.trim();
  const amountInvalid = !/^[1-9][0-9]{0,18}$/.test(digits);

  async function submit(): Promise<void> {
    if (pending || amountInvalid) return;
    setError(null);
    setPending(true);
    try {
      const response = await fetch('/api/offers', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          listingId,
          amountMinor: digits,
          quantity: Number(quantity) || 1,
          ...(note.trim() === '' ? {} : { message: note.trim() }),
        }),
      });
      if (response.status === 201) {
        router.push(offersPath);
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
    if (code === 'OFFER_ALREADY_OPEN') return copy.failedAlreadyOpen;
    if (code === 'OFFER_OWN_LISTING') return copy.failedOwnListing;
    if (code === 'OFFER_NOT_AVAILABLE') return copy.failedNotAvailable;
    if (code === 'OFFER_BLOCKED') return copy.failedBlocked;
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

      <label htmlFor="offer-amount" className="mt-3 block text-sm font-medium text-neutral-900">
        {copy.amountLabel} ({currencyCode})
      </label>
      <p id="offer-amount-hint" className="mt-1 text-xs text-neutral-600">
        {copy.amountHint}
      </p>
      <input
        id="offer-amount"
        name="amountMinor"
        inputMode="numeric"
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        aria-describedby="offer-amount-hint"
        {...(amount !== '' && amountInvalid ? { 'aria-invalid': true } : {})}
        className="mt-1 w-full rounded-md border border-neutral-300 p-2 text-sm"
      />
      {amount !== '' && amountInvalid && (
        <p role="alert" className="mt-1 text-sm font-medium text-neutral-900">
          {copy.amountRequired}
        </p>
      )}

      <label htmlFor="offer-quantity" className="mt-3 block text-sm font-medium text-neutral-900">
        {copy.quantityLabel}
      </label>
      <input
        id="offer-quantity"
        name="quantity"
        type="number"
        min={1}
        step={1}
        value={quantity}
        onChange={(event) => setQuantity(event.target.value)}
        className="mt-1 w-24 rounded-md border border-neutral-300 p-2 text-sm"
      />

      <label htmlFor="offer-note" className="mt-3 block text-sm font-medium text-neutral-900">
        {copy.noteLabel}
      </label>
      <textarea
        id="offer-note"
        name="message"
        rows={3}
        maxLength={2000}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        className="mt-1 w-full rounded-md border border-neutral-300 p-2 text-sm"
      />

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={pending || amountInvalid}
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
