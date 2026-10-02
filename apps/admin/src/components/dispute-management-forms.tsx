'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

/**
 * The two dispute controls (Phase 7-R).
 *
 * ---------------------------------------------------------------------------------------------------
 * **NEITHER OF THESE MOVES MONEY, AND THE RESOLUTION CONTROL SAYS SO ON THE SCREEN.**
 *
 * Choosing `refund_buyer` or `partial_refund` records that a colleague decided a refund is owed. It creates no
 * refund, reverses no payment, touches no ledger, balance or payout, and calls no provider — and the control
 * displays that in the copy the page passes in, next to the amount field, before the confirmation. A colleague
 * who thought they had just refunded somebody would be wrong in a way that matters, so the screen does not let
 * them think it.
 * ---------------------------------------------------------------------------------------------------
 *
 * What these controls deliberately do not contain:
 *
 * - **No resolver and no author, and no way to name one.** The API resolves the caller from their session;
 *   there is no field here that could carry an account, and no colleague is named anywhere on these screens.
 * - **No timestamp and no status.** The writer records when it ruled, sets the dispute to resolved, and
 *   restores the order to the status the dispute snapshotted. There is no field for any of those.
 * - **Nothing naming a refund, a payment, a ledger entry or a payout.** Not a field, not a code path.
 * - **No amount arithmetic.** The amount is a **string of minor units** from first keystroke to database
 *   column: it is never put through `Number`, never added to anything, and never reformatted. A large decision
 *   on a large order keeps every digit.
 * - **No optimistic row.** A written reason or message survives a failed request, because a colleague who lost
 *   one has lost more than the request.
 *
 * Both ask twice. A resolution cannot be retaken — the writer refuses an already-resolved dispute — and a
 * message cannot be unsent, because the thread is append-only.
 *
 * **Stale state is the server's answer, not a guess made here.** When a colleague has already ruled, or the
 * caller turns out to be a party, the API answers with its own code and the sentence for it says so. Nothing
 * in this file tracks what the database currently holds.
 */

const BUTTON_CLASS =
  'rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60';
const SECONDARY_CLASS =
  'rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-60';
const FIELD_CLASS =
  'mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900';

/** `dispute_messages_body_length` and `disputes_resolved_has_note` share this bound. */
const TEXT_MAX_LENGTH = 4000;

/** Minor units, as digits and nothing else. The same shape the contract accepts. */
const AMOUNT_PATTERN = /^[1-9][0-9]{0,18}$/;

async function post(
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number | null; code: string | null }> {
  try {
    const response = await fetch(path, {
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
/* A staff message or an internal note                                                               */
/* ------------------------------------------------------------------------------------------------ */

export interface DisputeMessageCopy {
  readonly heading: string;
  readonly intro: string;
  readonly bodyLabel: string;
  readonly internalLabel: string;
  readonly internalHint: string;
  readonly submit: string;
  readonly confirmVisible: string;
  readonly confirmInternal: string;
  readonly cancel: string;
  readonly working: string;
  readonly failed: string;
  readonly conflict: string;
  readonly closed: string;
  readonly isParty: string;
  readonly signedOut: string;
}

/**
 * Adding one message to a dispute.
 *
 * The internal flag defaults to off, because the safe default for a note on a record two other people can read
 * is that they can read it too — and the confirmation says which of the two it is about to be, since that is
 * the one thing about a message that cannot be taken back.
 */
export function DisputeMessageForm({
  disputeId,
  copy,
}: {
  readonly disputeId: string;
  readonly copy: DisputeMessageCopy;
}) {
  const router = useRouter();
  const [body, setBody] = useState('');
  const [isInternal, setIsInternal] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const blocked = body.trim() === '';

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!asking) {
      setMessage(null);
      setAsking(true);
      return;
    }
    if (blocked || busy) return;

    setBusy(true);
    setMessage(null);
    void (async () => {
      const result = await post('/api/disputes/messages', {
        disputeId,
        body: body.trim(),
        isInternal,
      });
      setBusy(false);
      setAsking(false);

      if (result.status === 200) {
        setBody('');
        setIsInternal(false);
        router.refresh();
        return;
      }
      if (result.status === 401) {
        setMessage(copy.signedOut);
        return;
      }
      if (result.code === 'DISPUTE_THREAD_CLOSED') {
        setMessage(copy.closed);
        return;
      }
      if (result.code === 'DISPUTE_IS_PARTY') {
        setMessage(copy.isParty);
        return;
      }
      if (result.status === 409) {
        setMessage(copy.conflict);
        return;
      }
      setMessage(copy.failed);
    })();
  }

  return (
    <form onSubmit={submit} className="mt-8 rounded-lg border border-neutral-200 p-4">
      <h3 className="text-base font-medium text-neutral-900">{copy.heading}</h3>
      <p className="mt-2 max-w-prose text-sm text-neutral-600">{copy.intro}</p>

      <label className="mt-4 block text-sm">
        <span className="text-neutral-900">{copy.bodyLabel}</span>
        <textarea
          className={FIELD_CLASS}
          rows={4}
          maxLength={TEXT_MAX_LENGTH}
          value={body}
          onChange={(event) => {
            setBody(event.target.value);
          }}
          disabled={busy}
        />
      </label>

      <label className="mt-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isInternal}
          onChange={(event) => {
            setIsInternal(event.target.checked);
            setAsking(false);
          }}
          disabled={busy}
        />
        <span className="text-neutral-900">{copy.internalLabel}</span>
      </label>
      <p className="mt-1 max-w-prose text-xs text-neutral-600">{copy.internalHint}</p>

      {asking && (
        <p role="alert" className="mt-4 max-w-prose text-sm text-neutral-900">
          {isInternal ? copy.confirmInternal : copy.confirmVisible}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-3">
        <button type="submit" className={BUTTON_CLASS} disabled={busy || blocked}>
          {busy ? copy.working : copy.submit}
        </button>
        {asking && (
          <button
            type="button"
            className={SECONDARY_CLASS}
            disabled={busy}
            onClick={() => {
              setAsking(false);
            }}
          >
            {copy.cancel}
          </button>
        )}
      </div>

      {message !== null && (
        <p role="alert" className="mt-3 max-w-prose text-sm text-neutral-900">
          {message}
        </p>
      )}
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* The resolution                                                                                    */
/* ------------------------------------------------------------------------------------------------ */

export interface DisputeResolutionCopy {
  readonly heading: string;
  readonly intro: string;
  /** The Phase 8 boundary, stated on the screen. Shown whenever a refund resolution is selected. */
  readonly noMoneyNotice: string;
  readonly resolutionLabel: string;
  readonly reasonLabel: string;
  readonly reasonHint: string;
  readonly amountLabel: string;
  readonly amountHint: string;
  readonly amountInvalid: string;
  readonly submit: string;
  readonly confirmRefund: string;
  readonly confirmRelease: string;
  readonly confirmNoAction: string;
  readonly cancel: string;
  readonly working: string;
  readonly failed: string;
  readonly conflict: string;
  readonly alreadyResolved: string;
  readonly isParty: string;
  readonly amountNotAllowed: string;
  readonly signedOut: string;
  readonly currencyCode: string;
  readonly resolutions: ReadonlyArray<{ readonly value: string; readonly label: string }>;
}

/**
 * Recording a decision on one dispute.
 *
 * The amount field appears only for the two refund resolutions, which is the schema's own rule, and it carries
 * the standing notice that recording one moves no money. Its value is a **string of minor units** throughout:
 * validated against the same digits-only shape the contract uses, and sent as typed.
 */
export function DisputeResolutionForm({
  disputeId,
  copy,
}: {
  readonly disputeId: string;
  readonly copy: DisputeResolutionCopy;
}) {
  const router = useRouter();
  const first = copy.resolutions[0];
  const [resolution, setResolution] = useState(first === undefined ? '' : first.value);
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (first === undefined) return null;

  const isRefund = resolution === 'refund_buyer' || resolution === 'partial_refund';
  // Every decision carries its reason — the schema's rule, not a rule of this control's own.
  const amountUnusable = isRefund && amount.trim() !== '' && !AMOUNT_PATTERN.test(amount.trim());
  const blocked = reason.trim() === '' || amountUnusable;

  const question = isRefund
    ? copy.confirmRefund
    : resolution === 'release_seller'
      ? copy.confirmRelease
      : copy.confirmNoAction;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!asking) {
      setMessage(null);
      setAsking(true);
      return;
    }
    if (blocked || busy) return;

    setBusy(true);
    setMessage(null);
    void (async () => {
      const result = await post('/api/disputes/resolution', {
        disputeId,
        resolution,
        resolutionNote: reason.trim(),
        // Sent only for a refund resolution, and only when given — as the string it was typed as.
        ...(isRefund && amount.trim() !== '' ? { resolutionAmountMinor: amount.trim() } : {}),
      });
      setBusy(false);
      setAsking(false);

      if (result.status === 200) {
        setReason('');
        setAmount('');
        router.refresh();
        return;
      }
      if (result.status === 401) {
        setMessage(copy.signedOut);
        return;
      }
      if (result.code === 'DISPUTE_IS_PARTY') {
        setMessage(copy.isParty);
        return;
      }
      if (result.code === 'DISPUTE_ALREADY_RESOLVED') {
        setMessage(copy.alreadyResolved);
        return;
      }
      if (result.code === 'DISPUTE_AMOUNT_NOT_ALLOWED') {
        setMessage(copy.amountNotAllowed);
        return;
      }
      if (result.status === 409) {
        setMessage(copy.conflict);
        return;
      }
      setMessage(copy.failed);
    })();
  }

  return (
    <form onSubmit={submit} className="mt-8 rounded-lg border border-neutral-200 p-4">
      <h3 className="text-base font-medium text-neutral-900">{copy.heading}</h3>
      <p className="mt-2 max-w-prose text-sm text-neutral-600">{copy.intro}</p>

      <label className="mt-4 block text-sm">
        <span className="text-neutral-900">{copy.resolutionLabel}</span>
        <select
          className={FIELD_CLASS}
          value={resolution}
          onChange={(event) => {
            setResolution(event.target.value);
            setAsking(false);
          }}
          disabled={busy}
        >
          {copy.resolutions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {/*
        The Phase 8 boundary, on the screen and before the amount field rather than after it. A colleague who
        believed this paid the buyer would be wrong in a way that matters.
      */}
      {isRefund && (
        <>
          <p role="status" className="mt-4 max-w-prose text-sm text-neutral-900">
            {copy.noMoneyNotice}
          </p>
          <label className="mt-4 block text-sm">
            <span className="text-neutral-900">
              {copy.amountLabel} ({copy.currencyCode})
            </span>
            <input
              type="text"
              inputMode="numeric"
              className={FIELD_CLASS}
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
              }}
              disabled={busy}
            />
            <span className="mt-1 block text-xs text-neutral-600">{copy.amountHint}</span>
          </label>
          {amountUnusable && (
            <p role="alert" className="mt-2 max-w-prose text-sm text-neutral-900">
              {copy.amountInvalid}
            </p>
          )}
        </>
      )}

      <label className="mt-4 block text-sm">
        <span className="text-neutral-900">{copy.reasonLabel}</span>
        <textarea
          className={FIELD_CLASS}
          rows={3}
          maxLength={TEXT_MAX_LENGTH}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
          disabled={busy}
        />
        <span className="mt-1 block text-xs text-neutral-600">{copy.reasonHint}</span>
      </label>

      {asking && (
        <p role="alert" className="mt-4 max-w-prose text-sm text-neutral-900">
          {question}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-3">
        <button type="submit" className={BUTTON_CLASS} disabled={busy || blocked}>
          {busy ? copy.working : copy.submit}
        </button>
        {asking && (
          <button
            type="button"
            className={SECONDARY_CLASS}
            disabled={busy}
            onClick={() => {
              setAsking(false);
            }}
          >
            {copy.cancel}
          </button>
        )}
      </div>

      {message !== null && (
        <p role="alert" className="mt-3 max-w-prose text-sm text-neutral-900">
          {message}
        </p>
      )}
    </form>
  );
}
