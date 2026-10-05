'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * What either party may do to a live offer (Phase 7-H).
 *
 * **Which buttons appear is decided on the server, from which list this is.** A buyer's page renders the
 * buyer's moves and a seller's page the seller's, and neither knows the other's. That is presentation, not
 * protection: the database refuses the wrong side whatever a browser sends, and the one thing that would
 * be unsafe — deciding *here* who somebody is — this component has no way to do. There is no role in its
 * props, and the session is an `HttpOnly` cookie it cannot read.
 *
 * **Accepting takes two steps.** An acceptance puts a payable obligation on a buyer and cannot be undone
 * from this surface, so the button opens a confirmation and the second press is the one that sends.
 *
 * **Nothing here computes a deadline.** The payment deadline is derived in the database from the moment of
 * acceptance and the platform's configured window; this component sends no date and receives one only to
 * stop showing its own form. On success the route is refreshed rather than the card being patched, so what
 * the reader ends up looking at is the state the database holds.
 *
 * **There is no payment here.** An acceptance records what is owed; paying it is Phase 8's, and this file
 * has no button that charges, reserves or orders anything.
 */

/** The words both sides need. */
interface SharedActionCopy {
  readonly confirm: string;
  readonly cancel: string;
  readonly working: string;
  readonly failedDecided: string;
  readonly failedLapsed: string;
  readonly failedGeneric: string;
  readonly failedSignedOut: string;
}

/**
 * The copy for one side, and only that side.
 *
 * A discriminated union rather than one object with everything in it, because these props are serialized
 * into the RSC payload: a seller's page that carried the buyer's words would put "change my offer" into a
 * document where that move does not exist. The side also comes from here rather than from a second prop,
 * so a page cannot pass one side's words with the other side's flag.
 */
export type OfferActionCopy =
  | ({
      readonly side: 'seller';
      readonly accept: string;
      readonly reject: string;
      readonly confirmAccept: string;
    } & SharedActionCopy)
  | ({
      readonly side: 'buyer';
      readonly counter: string;
      readonly withdraw: string;
      readonly amountLabel: string;
      readonly quantityLabel: string;
      readonly noteLabel: string;
      readonly send: string;
      readonly amountRequired: string;
    } & SharedActionCopy);

type Form = 'none' | 'accept' | 'counter';

export function OfferActions({
  offerId,
  currencyCode,
  copy,
}: {
  readonly offerId: string;
  readonly currencyCode: string;
  readonly copy: OfferActionCopy;
}) {
  const router = useRouter();
  const [form, setForm] = useState<Form>('none');
  const [amount, setAmount] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(path: string, body: unknown): Promise<void> {
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      if (response.status === 200 || response.status === 201) {
        setForm('none');
        setAmount('');
        setNote('');
        router.refresh();
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
    if (response.status === 401) return copy.failedSignedOut;
    let code: unknown = null;
    try {
      const body: unknown = await response.json();
      code = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['code'] : null;
    } catch {
      code = null;
    }
    if (code === 'OFFER_LAPSED') return copy.failedLapsed;
    if (code === 'OFFER_NOT_ACTIONABLE') return copy.failedDecided;
    return copy.failedGeneric;
  }

  const digits = amount.trim();
  const amountInvalid = !/^[1-9][0-9]{0,18}$/.test(digits);

  if (form === 'accept' && copy.side === 'seller') {
    return (
      <Panel error={error}>
        <p className="text-sm font-medium text-neutral-900">{copy.confirmAccept}</p>
        <div className="mt-3 flex flex-wrap gap-3">
          <button
            type="button"
            disabled={pending}
            onClick={() => void post(`/api/offers/${offerId}/accept`, undefined)}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {pending ? copy.working : copy.confirm}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setForm('none');
              setError(null);
            }}
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm text-neutral-900 disabled:opacity-60"
          >
            {copy.cancel}
          </button>
        </div>
      </Panel>
    );
  }

  if (form === 'counter' && copy.side === 'buyer') {
    return (
      <Panel error={error}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (amountInvalid) return;
            void post(`/api/offers/${offerId}/counter`, {
              amountMinor: digits,
              quantity: Number(quantity) || 1,
              ...(note.trim() === '' ? {} : { message: note.trim() }),
            });
          }}
        >
          <label htmlFor={`counter-amount-${offerId}`} className="block text-sm font-medium text-neutral-900">
            {copy.amountLabel} ({currencyCode})
          </label>
          <input
            id={`counter-amount-${offerId}`}
            name="amountMinor"
            inputMode="numeric"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            {...(amount !== '' && amountInvalid ? { 'aria-invalid': true } : {})}
            className="mt-1 w-full rounded-md border border-neutral-300 p-2 text-sm"
          />
          {amount !== '' && amountInvalid && (
            <p role="alert" className="mt-1 text-sm font-medium text-neutral-900">
              {copy.amountRequired}
            </p>
          )}

          <label
            htmlFor={`counter-quantity-${offerId}`}
            className="mt-3 block text-sm font-medium text-neutral-900"
          >
            {copy.quantityLabel}
          </label>
          <input
            id={`counter-quantity-${offerId}`}
            name="quantity"
            type="number"
            min={1}
            step={1}
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            className="mt-1 w-24 rounded-md border border-neutral-300 p-2 text-sm"
          />

          <label htmlFor={`counter-note-${offerId}`} className="mt-3 block text-sm font-medium text-neutral-900">
            {copy.noteLabel}
          </label>
          <textarea
            id={`counter-note-${offerId}`}
            name="message"
            rows={2}
            maxLength={2000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="mt-1 w-full rounded-md border border-neutral-300 p-2 text-sm"
          />

          <div className="mt-3 flex flex-wrap gap-3">
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
                setForm('none');
                setError(null);
              }}
              className="rounded-md border border-neutral-300 px-4 py-2 text-sm text-neutral-900 disabled:opacity-60"
            >
              {copy.cancel}
            </button>
          </div>
        </form>
      </Panel>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-3">
      {copy.side === 'seller' ? (
        <>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setForm('accept');
            }}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white"
          >
            {copy.accept}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => void post(`/api/offers/${offerId}/reject`, undefined)}
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm text-neutral-900 disabled:opacity-60"
          >
            {pending ? copy.working : copy.reject}
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setForm('counter');
            }}
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-900"
          >
            {copy.counter}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => void post(`/api/offers/${offerId}/withdraw`, undefined)}
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm text-neutral-900 disabled:opacity-60"
          >
            {pending ? copy.working : copy.withdraw}
          </button>
        </>
      )}
      {error !== null && (
        <span role="alert" className="text-sm font-medium text-neutral-900">
          {error}
        </span>
      )}
    </span>
  );
}

function Panel({
  children,
  error,
}: {
  readonly children: React.ReactNode;
  readonly error: string | null;
}) {
  return (
    <div className="mt-2 w-full max-w-prose rounded-lg border border-neutral-300 p-4">
      {children}
      {error !== null && (
        <p role="alert" className="mt-3 text-sm font-medium text-neutral-900">
          {error}
        </p>
      )}
    </div>
  );
}
