'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * What either party may do to a live service request or quote (Phase 7-I).
 *
 * **Which controls appear is decided on the server, from which page this is.** A buyer's page renders the
 * buyer's steps and a seller's page the seller's, and neither knows the other's. That is presentation, not
 * protection: the database refuses the wrong side whatever a browser sends, and the one thing that would be
 * unsafe — deciding *here* who somebody is — these components have no way to do. There is no role in their
 * props, and the session is an `HttpOnly` cookie they cannot read.
 *
 * **Each component takes only its own words.** The copy is three separate groups rather than one object with
 * everything in it, because these props are serialized into the RSC payload: one shared object would put
 * "accept this quote" into a document that renders only a cancel button, and the words a page ships are a
 * fair description of what that page offers. So a page that draws one control ships one control's copy.
 *
 * **Accepting a quote takes two steps.** An acceptance puts a payable obligation on a buyer, closes the brief,
 * and cannot be undone from this surface, so the button opens a confirmation and the second press is the one
 * that sends. Cancelling and declining a brief are confirmed for the same reason: both are final.
 *
 * **Nothing here computes a deadline.** `validForDays` is how long a seller's quote stands and is the only
 * duration this file sends. The payment deadline is derived in the database from the moment of acceptance and
 * the platform's configured window; no component here sends a date, and none receives one except to stop
 * showing its own form. On success the route is refreshed rather than a card being patched, so what the reader
 * ends up looking at is the state the database holds.
 *
 * **There is no payment here.** An acceptance records what is owed; paying it is Phase 8's, and this file has
 * no control that charges, reserves or orders anything.
 */

/** The words every control needs: the confirmation pair, the busy label, and what a refusal means. */
interface SharedCopy {
  readonly confirm: string;
  readonly cancel: string;
  readonly working: string;
  readonly failedDecided: string;
  readonly failedLapsed: string;
  readonly failedPaymentPolicy: string;
  readonly failedBlocked: string;
  readonly failedGeneric: string;
  readonly failedSignedOut: string;
}

/**
 * Closing a brief.
 *
 * `step` is the segment, and it is the server's to choose: a buyer's page builds `cancel` and a seller's
 * `decline`. Neither page can build the other, because neither is given the other's words.
 */
export interface ServiceClosureCopy extends SharedCopy {
  readonly step: 'cancel' | 'decline';
  readonly label: string;
  readonly question: string;
}

/** Deciding one quote. A union, so a page carries one side's decisions and not both. */
export type ServiceQuoteDecisionCopy =
  | ({
      readonly side: 'buyer';
      readonly accept: string;
      readonly reject: string;
      readonly confirmAccept: string;
    } & SharedCopy)
  | ({ readonly side: 'seller'; readonly withdraw: string } & SharedCopy);

/** The quote form. Only a seller's page is given one; a buyer's page carries none of these words. */
export interface ServiceQuoteFormCopy extends SharedCopy {
  readonly heading: string;
  readonly send: string;
  readonly amountLabel: string;
  readonly amountHint: string;
  readonly deliveryLabel: string;
  readonly revisionsLabel: string;
  readonly scopeLabel: string;
  readonly validForLabel: string;
  readonly validForHint: string;
  readonly amountRequired: string;
  readonly scopeRequired: string;
}

/**
 * One side's controls, kept in three groups.
 *
 * The server component hands each control its own group, so nothing a page does not draw is serialized. `form`
 * is `null` on the buyer's side because a buyer never quotes — an absence rather than an unused object.
 */
export interface ServiceRequestActionCopy {
  readonly side: 'buyer' | 'seller';
  readonly closure: ServiceClosureCopy;
  readonly decision: ServiceQuoteDecisionCopy;
  readonly form: ServiceQuoteFormCopy | null;
}

const BUTTON = 'rounded-md bg-surface-ink px-4 py-2 text-sm font-medium text-on-ink disabled:opacity-60';
const QUIET = 'rounded-md border border-edge px-4 py-2 text-sm text-ink-strong disabled:opacity-60';
const FIELD = 'mt-1 w-full rounded-md border border-edge p-2 text-sm';
const NUMBER = 'mt-1 w-24 rounded-md border border-edge p-2 text-sm';
const PANEL = 'max-w-prose rounded-lg border border-edge p-4';

/**
 * One write, and what its refusal means in words.
 *
 * The problem code is the only thing read out of a failure body: each of the four that can reach a browser
 * here has its own remedy, and a single generic sentence would leave somebody guessing which. Everything else
 * becomes the generic sentence, so an unexpected code can never be rendered as a success.
 */
function useWrite(copy: SharedCopy): {
  pending: boolean;
  error: string | null;
  reset: () => void;
  post: (path: string, body?: unknown) => Promise<boolean>;
} {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function messageFor(response: Response): Promise<string> {
    if (response.status === 401) return copy.failedSignedOut;
    let code: unknown = null;
    try {
      const body: unknown = await response.json();
      code = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['code'] : null;
    } catch {
      code = null;
    }
    if (code === 'SERVICE_QUOTE_LAPSED') return copy.failedLapsed;
    if (code === 'SERVICE_REQUEST_NOT_ACTIONABLE') return copy.failedDecided;
    if (code === 'SERVICE_QUOTE_PAYMENT_POLICY_MISSING') return copy.failedPaymentPolicy;
    if (code === 'SERVICE_REQUEST_BLOCKED') return copy.failedBlocked;
    return copy.failedGeneric;
  }

  async function post(path: string, body?: unknown): Promise<boolean> {
    if (pending) return false;
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
        router.refresh();
        return true;
      }
      setError(await messageFor(response));
      return false;
    } catch {
      setError(copy.failedGeneric);
      return false;
    } finally {
      setPending(false);
    }
  }

  return { pending, error, reset: () => setError(null), post };
}

function Alert({ error }: { readonly error: string | null }) {
  if (error === null) return null;
  return (
    <p role="alert" className="mt-2 max-w-prose text-sm font-medium text-ink-strong">
      {error}
    </p>
  );
}

/**
 * Closing a brief: the buyer cancels their own, or the seller declines to quote.
 *
 * One component, because the two differ only in the segment they address and in whom the database will let
 * through — and neither of those is this component's to decide.
 */
export function ServiceRequestClosure({
  requestId,
  copy,
}: {
  readonly requestId: string;
  readonly copy: ServiceClosureCopy;
}) {
  const write = useWrite(copy);
  const [asking, setAsking] = useState(false);

  if (!asking) {
    return (
      <div>
        <button
          type="button"
          onClick={() => {
            write.reset();
            setAsking(true);
          }}
          className={QUIET}
        >
          {copy.label}
        </button>
        <Alert error={write.error} />
      </div>
    );
  }

  return (
    <div className={PANEL}>
      <p className="text-sm font-medium text-ink-strong">{copy.question}</p>
      <div className="mt-3 flex flex-wrap gap-3">
        <button
          type="button"
          disabled={write.pending}
          onClick={() => {
            void write.post(`/api/service-requests/${requestId}/${copy.step}`).then((done) => {
              if (done) setAsking(false);
            });
          }}
          className={BUTTON}
        >
          {write.pending ? copy.working : copy.confirm}
        </button>
        <button
          type="button"
          disabled={write.pending}
          onClick={() => {
            setAsking(false);
            write.reset();
          }}
          className={QUIET}
        >
          {copy.cancel}
        </button>
      </div>
      <Alert error={write.error} />
    </div>
  );
}

/**
 * Deciding one quote.
 *
 * The brief is in the path beside the quote, so the API can refuse a quote that belongs to a different brief.
 * The buyer may accept or decline; the seller may take their own back. Nothing here decides which.
 */
export function ServiceQuoteDecision({
  requestId,
  quoteId,
  copy,
}: {
  readonly requestId: string;
  readonly quoteId: string;
  readonly copy: ServiceQuoteDecisionCopy;
}) {
  const write = useWrite(copy);
  const [asking, setAsking] = useState(false);
  const base = `/api/service-requests/${requestId}/quotes/${quoteId}`;

  if (copy.side === 'seller') {
    return (
      <div>
        <button
          type="button"
          disabled={write.pending}
          onClick={() => void write.post(`${base}/withdraw`)}
          className={QUIET}
        >
          {write.pending ? copy.working : copy.withdraw}
        </button>
        <Alert error={write.error} />
      </div>
    );
  }

  if (asking) {
    return (
      <div className={PANEL}>
        <p className="text-sm font-medium text-ink-strong">{copy.confirmAccept}</p>
        <div className="mt-3 flex flex-wrap gap-3">
          <button
            type="button"
            disabled={write.pending}
            onClick={() => {
              void write.post(`${base}/accept`).then((done) => {
                if (done) setAsking(false);
              });
            }}
            className={BUTTON}
          >
            {write.pending ? copy.working : copy.confirm}
          </button>
          <button
            type="button"
            disabled={write.pending}
            onClick={() => {
              setAsking(false);
              write.reset();
            }}
            className={QUIET}
          >
            {copy.cancel}
          </button>
        </div>
        <Alert error={write.error} />
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={() => {
          write.reset();
          setAsking(true);
        }}
        className={BUTTON}
      >
        {copy.accept}
      </button>
      <button
        type="button"
        disabled={write.pending}
        onClick={() => void write.post(`${base}/reject`)}
        className={QUIET}
      >
        {write.pending ? copy.working : copy.reject}
      </button>
      <Alert error={write.error} />
    </div>
  );
}

/**
 * The seller's quote form.
 *
 * Five fields, and not one of them is a currency, a status or a deadline. The currency is *shown* because
 * somebody typing an amount needs to know the unit — it is the brief's own, copied from the listing — but it is
 * never sent: the database copies it from the request row. `validForDays` is how long this quote stands and is
 * bounded by the schema's own 1–365, the same bound delivery uses. Its hint says in words that it is not the
 * payment deadline, because the two being confused is how somebody misses a payment.
 */
export function ServiceQuoteForm({
  requestId,
  currencyCode,
  copy,
}: {
  readonly requestId: string;
  readonly currencyCode: string;
  readonly copy: ServiceQuoteFormCopy;
}) {
  const write = useWrite(copy);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [delivery, setDelivery] = useState('7');
  const [revisions, setRevisions] = useState('0');
  const [scope, setScope] = useState('');
  const [validFor, setValidFor] = useState('14');

  // The schema's own bounds, restated so a form can say what is wrong before it sends. The database holds the
  // same checks, and they are the authority.
  const digits = amount.trim();
  const amountInvalid = !/^[1-9][0-9]{0,18}$/.test(digits);
  const scopeText = scope.trim();
  const scopeInvalid = scopeText.length < 10 || scopeText.length > 10_000;

  if (!open) {
    return (
      <div>
        <button
          type="button"
          onClick={() => {
            write.reset();
            setOpen(true);
          }}
          className={BUTTON}
        >
          {copy.send}
        </button>
        <Alert error={write.error} />
      </div>
    );
  }

  return (
    <form
      className={PANEL}
      onSubmit={(event) => {
        event.preventDefault();
        if (amountInvalid || scopeInvalid) return;
        void write
          .post(`/api/service-requests/${requestId}/quotes`, {
            amountMinor: digits,
            deliveryDays: Number(delivery) || 1,
            revisionsIncluded: Number(revisions) || 0,
            scope: scopeText,
            validForDays: Number(validFor) || 1,
          })
          .then((done) => {
            if (done) {
              setOpen(false);
              setAmount('');
              setScope('');
            }
          });
      }}
    >
      <p className="text-base font-medium text-ink-strong">{copy.heading}</p>

      <label htmlFor="quote-amount" className="mt-3 block text-sm font-medium text-ink-strong">
        {copy.amountLabel} ({currencyCode})
      </label>
      <p id="quote-amount-hint" className="mt-1 text-xs text-ink-muted">
        {copy.amountHint}
      </p>
      <input
        id="quote-amount"
        name="amountMinor"
        inputMode="numeric"
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        aria-describedby="quote-amount-hint"
        {...(amount !== '' && amountInvalid ? { 'aria-invalid': true } : {})}
        className={FIELD}
      />
      {amount !== '' && amountInvalid && (
        <p role="alert" className="mt-1 text-sm font-medium text-ink-strong">
          {copy.amountRequired}
        </p>
      )}

      <label htmlFor="quote-scope" className="mt-3 block text-sm font-medium text-ink-strong">
        {copy.scopeLabel}
      </label>
      <textarea
        id="quote-scope"
        name="scope"
        rows={4}
        maxLength={10_000}
        value={scope}
        onChange={(event) => setScope(event.target.value)}
        {...(scope !== '' && scopeInvalid ? { 'aria-invalid': true } : {})}
        className={FIELD}
      />
      {scope !== '' && scopeInvalid && (
        <p role="alert" className="mt-1 text-sm font-medium text-ink-strong">
          {copy.scopeRequired}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-4">
        <div>
          <label htmlFor="quote-delivery" className="block text-sm font-medium text-ink-strong">
            {copy.deliveryLabel}
          </label>
          <input
            id="quote-delivery"
            name="deliveryDays"
            type="number"
            min={1}
            max={365}
            step={1}
            value={delivery}
            onChange={(event) => setDelivery(event.target.value)}
            className={NUMBER}
          />
        </div>
        <div>
          <label htmlFor="quote-revisions" className="block text-sm font-medium text-ink-strong">
            {copy.revisionsLabel}
          </label>
          <input
            id="quote-revisions"
            name="revisionsIncluded"
            type="number"
            min={0}
            step={1}
            value={revisions}
            onChange={(event) => setRevisions(event.target.value)}
            className={NUMBER}
          />
        </div>
        <div>
          {/* How long the quote stands. Not a payment deadline: that one is the database's to set. */}
          <label htmlFor="quote-valid-for" className="block text-sm font-medium text-ink-strong">
            {copy.validForLabel}
          </label>
          <input
            id="quote-valid-for"
            name="validForDays"
            type="number"
            min={1}
            max={365}
            step={1}
            value={validFor}
            onChange={(event) => setValidFor(event.target.value)}
            aria-describedby="quote-valid-for-hint"
            className={NUMBER}
          />
          <p id="quote-valid-for-hint" className="mt-1 max-w-xs text-xs text-ink-muted">
            {copy.validForHint}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        <button type="submit" disabled={write.pending || amountInvalid || scopeInvalid} className={BUTTON}>
          {write.pending ? copy.working : copy.send}
        </button>
        <button
          type="button"
          disabled={write.pending}
          onClick={() => {
            setOpen(false);
            write.reset();
          }}
          className={QUIET}
        >
          {copy.cancel}
        </button>
      </div>
      <Alert error={write.error} />
    </form>
  );
}
