'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Approve or reject one application (Phase 7-G).
 *
 * **It sends two fields and an identifier, and reads a status back.** There is no reviewer here, no
 * permission, no assurance level and no seller: the session is an `HttpOnly` cookie this code cannot
 * read, and everything about who is asking is resolved on the server from it. A verification identifier
 * is not an authorization — the API refuses the write for anybody who may not make it, and so does the
 * database.
 *
 * **Deciding takes two steps on purpose.** A verification decision changes somebody's storefront and is
 * not reversible from this surface, so the button opens a confirmation that names the decision, and the
 * second press is the one that sends. A rejection cannot be confirmed without a reason, which is 0009's
 * own rule stated where a person can act on it rather than only where a statement would fail.
 *
 * **Approval is offered only when the schema would accept it.** `seller_verifications_approval_needs_contacts`
 * makes an approval impossible before both contact verifications, so the button is disabled with the
 * reason said out loud — and the server refuses it anyway if this component is wrong, which is what the
 * conflict message is for.
 *
 * On success the route is refreshed rather than the screen being updated locally, so what a reviewer
 * ends up looking at is the state the database holds and not the one this component hoped for.
 */

export interface DecisionLabels {
  readonly approve: string;
  readonly reject: string;
  readonly reasonLabel: string;
  readonly reasonHelpApprove: string;
  readonly reasonHelpReject: string;
  readonly reasonRequired: string;
  readonly confirmApprove: string;
  readonly confirmReject: string;
  readonly confirm: string;
  readonly cancel: string;
  readonly working: string;
  readonly contactsBlocked: string;
  readonly failedConflict: string;
  readonly failedContacts: string;
  readonly failedGeneric: string;
}

type Decision = 'approved' | 'rejected';

export function VerificationDecisionForm({
  verificationId,
  canApprove,
  labels,
}: {
  readonly verificationId: string;
  readonly canApprove: boolean;
  readonly labels: DecisionLabels;
}) {
  const router = useRouter();
  const [choice, setChoice] = useState<Decision | null>(null);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = reason.trim();
  const reasonMissing = choice === 'rejected' && trimmed === '';

  async function submit(): Promise<void> {
    if (pending || choice === null || reasonMissing) return;
    setError(null);
    setPending(true);
    try {
      const response = await fetch('/api/sellers/verification/decision', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          trimmed === ''
            ? { verificationId, decision: choice }
            : { verificationId, decision: choice, reason: trimmed },
        ),
      });
      if (response.status === 200) {
        setChoice(null);
        setReason('');
        router.refresh();
        return;
      }
      setError(await messageFor(response));
    } catch {
      setError(labels.failedGeneric);
    } finally {
      setPending(false);
    }
  }

  async function messageFor(response: Response): Promise<string> {
    if (response.status !== 409) return labels.failedGeneric;
    try {
      const body: unknown = await response.json();
      const code =
        typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>)['code']
          : null;
      if (code === 'VERIFICATION_CONTACTS_UNVERIFIED') return labels.failedContacts;
      return labels.failedConflict;
    } catch {
      return labels.failedConflict;
    }
  }

  if (choice === null) {
    return (
      <div className="mt-3">
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => {
              setError(null);
              setChoice('approved');
            }}
            disabled={!canApprove}
            className="rounded-md border border-neutral-900 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-50"
          >
            {labels.approve}
          </button>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setChoice('rejected');
            }}
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-900"
          >
            {labels.reject}
          </button>
        </div>
        {!canApprove && (
          <p className="mt-2 max-w-prose text-sm text-neutral-600">{labels.contactsBlocked}</p>
        )}
        {error !== null && (
          <p role="alert" className="mt-3 max-w-prose text-sm font-medium text-neutral-900">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <form
      className="mt-3 max-w-prose rounded-lg border border-neutral-300 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="text-sm font-medium text-neutral-900">
        {choice === 'approved' ? labels.confirmApprove : labels.confirmReject}
      </p>

      <label htmlFor="decision-reason" className="mt-4 block text-sm font-medium text-neutral-900">
        {labels.reasonLabel}
      </label>
      <p id="decision-reason-help" className="mt-1 text-xs text-neutral-600">
        {choice === 'approved' ? labels.reasonHelpApprove : labels.reasonHelpReject}
      </p>
      <textarea
        id="decision-reason"
        name="reason"
        rows={3}
        value={reason}
        maxLength={2000}
        onChange={(event) => setReason(event.target.value)}
        aria-describedby="decision-reason-help"
        {...(reasonMissing ? { 'aria-invalid': true } : {})}
        className="mt-2 w-full rounded-md border border-neutral-300 p-2 text-sm text-neutral-900"
      />
      {reasonMissing && (
        <p role="alert" className="mt-2 text-sm font-medium text-neutral-900">
          {labels.reasonRequired}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={pending || reasonMissing}
          className="rounded-md border border-neutral-900 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-50"
        >
          {pending ? labels.working : labels.confirm}
        </button>
        <button
          type="button"
          onClick={() => {
            setChoice(null);
            setError(null);
          }}
          disabled={pending}
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm text-neutral-900 disabled:opacity-50"
        >
          {labels.cancel}
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
