'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { adminApiPath } from '../paths';

/**
 * The three recovery controls (Phase 7-O).
 *
 * One component with three steps, because the three are the same shape: one identifier, at most one closed
 * choice, and the reason or the flag the writer needs. What it deliberately does **not** contain is as
 * important:
 *
 * - **No reviewer and no approver, and no way to name one.** The API resolves the caller from their session;
 *   there is no field here that could carry an account, and no colleague is named anywhere on these screens.
 * - **No status a caller could type.** The decision step offers the writer's own two words as two options
 *   rather than a free field, and sends no status at all: the status a request lands on is the writer's own
 *   mapping, which is why an approval reaches `contact_verification` and never `approved`.
 * - **No hold, no session revocation and no MFA reset time.** The writer computes and records all three.
 *   The completion step collects one boolean recording what the colleague did out of band, and nothing that
 *   could shorten or skip the hold.
 * - **Nothing that grants a role or changes a seller's status.** There is no such control in this file
 *   because there is no writer for either in this repository.
 * - **No optimistic row.** A draft is cleared and the screen refreshed only after the server has confirmed;
 *   anything else leaves the text where it is and says what happened. A colleague who lost a written reason
 *   to a failed request has lost more than the request.
 * - **No identifiers on screen.** The words for a refusal are the ones the page passed in, never a sentence
 *   the server composed.
 *
 * All three ask twice, because all three are irreversible in the sense that matters: a review fixes who the
 * reviewer is for the rest of the request's life, a decision cannot be retaken, and a completion revokes
 * somebody's sessions and starts a hold on their withdrawals.
 *
 * **Stale state is the server's answer, not a guess made here.** When a colleague has already acted, the API
 * answers with its own problem code and the sentence for it says so and asks for a reload. The two-person
 * rule has a sentence of its own, because "somebody else has to decide this one" is a different thing to be
 * told than "this already happened". Nothing in this file tracks what the database currently holds, because
 * a second copy of that state is a second copy that can disagree.
 */

const BUTTON_CLASS =
  'rounded-md bg-surface-ink px-4 py-2 text-sm font-medium text-on-ink disabled:opacity-60';
const SECONDARY_CLASS =
  'rounded-md border border-edge px-4 py-2 text-sm font-medium text-ink-strong disabled:opacity-60';
const FIELD_CLASS =
  'mt-1 w-full rounded-md border border-edge px-3 py-2 text-sm text-ink-strong';

/** `account_recovery_approvals_note_length`, which is the tightest bound any of the three notes meets. */
const NOTE_MAX_LENGTH = 2000;

async function post(
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number | null; code: string | null }> {
  try {
    const response = await fetch(adminApiPath(path), {
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

/**
 * The words this control shows.
 *
 * Every field is optional except the ones every step needs, and a step is handed only its own: a prop is
 * serialized into the payload whether or not the branch reading it renders, so a `needsAnother` string
 * beside a review control would ship the words for a refusal that step cannot produce. Absent copy is an
 * absent sentence.
 */
export interface RecoveryCopy {
  readonly heading: string;
  readonly intro: string;
  readonly submit: string;
  readonly confirm: string;
  readonly cancel: string;
  readonly working: string;
  readonly failed: string;
  readonly conflict: string;
  readonly signedOut: string;
  readonly noteLabel?: string;
  readonly noteHint?: string;
  readonly approve?: string;
  readonly reject?: string;
  readonly needsAnother?: string;
  readonly mfaLabel?: string;
}

export type RecoveryStep = 'review' | 'decision' | 'completion';

const PATHS: Readonly<Record<RecoveryStep, string>> = {
  review: '/api/recovery/review',
  decision: '/api/recovery/decision',
  completion: '/api/recovery/completion',
};

export function RecoveryDecisionForm({
  requestId,
  step,
  copy,
}: {
  readonly requestId: string;
  readonly step: RecoveryStep;
  readonly copy: RecoveryCopy;
}) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [decision, setDecision] = useState<'approved' | 'rejected'>('approved');
  const [mfaWasReset, setMfaWasReset] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // A rejection is always recorded with its reason, which is the writer's rule; checking it here keeps the
  // colleague's typing rather than sending a request the database will refuse.
  const needsNote = step === 'decision' && decision === 'rejected';
  const blocked = needsNote && note.trim() === '';

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
      const body: Record<string, unknown> = { requestId };
      if (step === 'decision') body['decision'] = decision;
      if (step === 'completion') body['mfaWasReset'] = mfaWasReset;
      if (step !== 'completion' && note.trim() !== '') body['note'] = note.trim();

      const result = await post(PATHS[step], body);
      setBusy(false);
      setAsking(false);

      if (result.status === 200) {
        setNote('');
        setMfaWasReset(false);
        router.refresh();
        return;
      }
      if (result.status === 401) {
        setMessage(copy.signedOut);
        return;
      }
      if (result.code === 'RECOVERY_NEEDS_ANOTHER_PERSON' && copy.needsAnother !== undefined) {
        setMessage(copy.needsAnother);
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
    <form onSubmit={submit} className="mt-8 rounded-lg border border-hairline p-4">
      <h3 className="text-base font-medium text-ink-strong">{copy.heading}</h3>
      <p className="mt-2 max-w-prose text-sm text-ink-muted">{copy.intro}</p>

      {step === 'decision' && copy.approve !== undefined && copy.reject !== undefined && (
        <fieldset className="mt-4">
          <legend className="sr-only">{copy.heading}</legend>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="decision"
                value="approved"
                checked={decision === 'approved'}
                onChange={() => {
                  setDecision('approved');
                }}
                disabled={busy}
              />
              {copy.approve}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="decision"
                value="rejected"
                checked={decision === 'rejected'}
                onChange={() => {
                  setDecision('rejected');
                }}
                disabled={busy}
              />
              {copy.reject}
            </label>
          </div>
        </fieldset>
      )}

      {step !== 'completion' && copy.noteLabel !== undefined && (
        <label className="mt-4 block text-sm">
          <span className="text-ink-strong">{copy.noteLabel}</span>
          <textarea
            className={FIELD_CLASS}
            rows={3}
            maxLength={NOTE_MAX_LENGTH}
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
            disabled={busy}
          />
          {copy.noteHint !== undefined && (
            <span className="mt-1 block text-xs text-ink-muted">{copy.noteHint}</span>
          )}
        </label>
      )}

      {step === 'completion' && copy.mfaLabel !== undefined && (
        <label className="mt-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={mfaWasReset}
            onChange={(event) => {
              setMfaWasReset(event.target.checked);
            }}
            disabled={busy}
          />
          <span className="text-ink-strong">{copy.mfaLabel}</span>
        </label>
      )}

      {asking && (
        <p role="alert" className="mt-4 max-w-prose text-sm text-ink-strong">
          {copy.confirm}
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
        <p role="alert" className="mt-3 max-w-prose text-sm text-ink-strong">
          {message}
        </p>
      )}
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* One storefront's account status                                                                   */
/* ------------------------------------------------------------------------------------------------ */

/**
 * The words this control shows.
 *
 * `targets` is the list of statuses this storefront can legally reach, decided by the page from the status it
 * currently holds and its verification. A status that is not reachable is **not in the list**, so the words
 * for it are not in the payload either: a control that offered `active` to an unverified storefront would ship
 * the label for a move the database is going to refuse.
 */
export interface SellerStatusCopy {
  readonly heading: string;
  readonly intro: string;
  readonly statusLabel: string;
  readonly reasonLabel: string;
  readonly reasonHint: string;
  readonly submit: string;
  readonly confirmSuspend: string;
  readonly confirmClose: string;
  readonly confirmReinstate: string;
  readonly cancel: string;
  readonly working: string;
  readonly failed: string;
  readonly conflict: string;
  readonly notAllowed: string;
  readonly signedOut: string;
  readonly targets: ReadonlyArray<{ readonly value: string; readonly label: string }>;
}

/**
 * Changing one storefront's account status.
 *
 * Thin, like every other control in this console. What it deliberately does not contain:
 *
 * - **No timestamp.** The writer sets `suspended_at` and `closed_at` from its own constraints, and clears them
 *   on reinstatement. There is no field here that could carry either.
 * - **No verification value.** 7-G owns `verification_status` and `verified_at`. This control cannot name
 *   them, which is why activating an unverified storefront is refused rather than achieved.
 * - **No transition rule.** The reachable statuses come from the page as a list; the database decides which
 *   pairs are legal and this control cannot express one. A list that disagreed with the database would lose.
 * - **No cascade.** Nothing here mentions a listing, an offer, an order, a balance or a payout, because the
 *   status change touches none of them.
 * - **No optimistic row.** A written reason survives a failed request, because a colleague who lost one has
 *   lost more than the request.
 *
 * It asks twice, and the question it asks depends on where the storefront is going: closing one is terminal in
 * this workflow and the confirmation says so.
 */
export function SellerStatusForm({
  slug,
  copy,
}: {
  readonly slug: string;
  readonly copy: SellerStatusCopy;
}) {
  const router = useRouter();
  const first = copy.targets[0];
  const [status, setStatus] = useState(first === undefined ? '' : first.value);
  const [reason, setReason] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (first === undefined) return null;

  // The writer's own rule, checked here so a colleague keeps their typing rather than sending a request the
  // database will refuse.
  const needsReason = status === 'suspended';
  const blocked = needsReason && reason.trim() === '';

  const question =
    status === 'suspended'
      ? copy.confirmSuspend
      : status === 'closed'
        ? copy.confirmClose
        : copy.confirmReinstate;

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
      const result = await post('/api/sellers/status', {
        slug,
        status,
        ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
      });
      setBusy(false);
      setAsking(false);

      if (result.status === 200) {
        setReason('');
        router.refresh();
        return;
      }
      if (result.status === 401) {
        setMessage(copy.signedOut);
        return;
      }
      if (
        result.code === 'SELLER_STATUS_NOT_ALLOWED' ||
        result.code === 'SELLER_STATUS_NOT_VERIFIED' ||
        result.code === 'SELLER_STATUS_ALREADY_VERIFIED'
      ) {
        setMessage(copy.notAllowed);
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
    <form onSubmit={submit} className="mt-8 rounded-lg border border-hairline p-4">
      <h3 className="text-base font-medium text-ink-strong">{copy.heading}</h3>
      <p className="mt-2 max-w-prose text-sm text-ink-muted">{copy.intro}</p>

      <label className="mt-4 block text-sm">
        <span className="text-ink-strong">{copy.statusLabel}</span>
        <select
          className={FIELD_CLASS}
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setAsking(false);
          }}
          disabled={busy}
        >
          {copy.targets.map((target) => (
            <option key={target.value} value={target.value}>
              {target.label}
            </option>
          ))}
        </select>
      </label>

      {needsReason && (
        <label className="mt-4 block text-sm">
          <span className="text-ink-strong">{copy.reasonLabel}</span>
          <textarea
            className={FIELD_CLASS}
            rows={3}
            maxLength={NOTE_MAX_LENGTH}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            disabled={busy}
          />
          <span className="mt-1 block text-xs text-ink-muted">{copy.reasonHint}</span>
        </label>
      )}

      {asking && (
        <p role="alert" className="mt-4 max-w-prose text-sm text-ink-strong">
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
        <p role="alert" className="mt-3 max-w-prose text-sm text-ink-strong">
          {message}
        </p>
      )}
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Role assignment and revocation (0100)                                                             */
/* ------------------------------------------------------------------------------------------------ */

export interface StaffRoleCopy {
  readonly heading: string;
  readonly intro: string;
  /** Owner decision 6, said out loud: this operation does not end a session. */
  readonly sessionNote: string;
  readonly reasonLabel: string;
  readonly reasonHint: string;
  /**
   * The grant words, present only when there is something to grant, and the withdrawal words only when there
   * is something to withdraw.
   *
   * A client component's whole props object is serialised into the RSC payload whether or not the branch
   * reading it renders, so copy for a control nobody can use would ship on every page view. The server
   * decides, and absent copy is an absent control.
   */
  readonly roleLabel?: string;
  readonly expiresLabel?: string;
  readonly expiresHint?: string;
  readonly grantSubmit?: string;
  readonly grantConfirm?: string;
  readonly revokeSubmit?: string;
  readonly revokeConfirm?: string;
  readonly heldHeading?: string;
  readonly cancel: string;
  readonly working: string;
  readonly failed: string;
  readonly signedOut: string;
  readonly isSelf: string;
  readonly aboveCeiling: string;
  readonly notGrantable: string;
  readonly notAssignable: string;
  readonly alreadyRevoked: string;
  readonly expiryInvalid: string;
  readonly reasonRequired: string;
  readonly conflict: string;
}

/** One role, as the server said this caller may act on it. Never a catalogue this component filtered. */
export interface StaffRoleOption {
  readonly roleKey: string;
  readonly label: string;
}

/** One sentence per refusal code. Every one of these is a boundary the database decided. */
function roleMessageFor(
  result: { readonly status: number | null; readonly code: string | null },
  copy: StaffRoleCopy,
): string {
  if (result.status === 401) return copy.signedOut;
  if (result.code === 'STAFF_ROLE_IS_SELF') return copy.isSelf;
  if (result.code === 'STAFF_ROLE_ABOVE_CEILING') return copy.aboveCeiling;
  if (result.code === 'STAFF_ROLE_NOT_GRANTABLE' || result.code === 'STAFF_ROLE_NOT_REVOCABLE') {
    return copy.notGrantable;
  }
  if (result.code === 'STAFF_ROLE_NOT_ASSIGNABLE') return copy.notAssignable;
  if (result.code === 'STAFF_ROLE_ALREADY_REVOKED') return copy.alreadyRevoked;
  if (result.code === 'STAFF_ROLE_EXPIRY_INVALID') return copy.expiryInvalid;
  if (result.code === 'STAFF_ROLE_REASON_REQUIRED') return copy.reasonRequired;
  if (result.status === 409) return copy.conflict;
  return copy.failed;
}

/**
 * Granting and withdrawing one account's roles.
 *
 * **`grantable` and `revocable` are the server's answers, not this component's.** The grantable list comes
 * from the database, which computed it from the signed-in colleague's own effective roles; the revocable list
 * is the account's live grants intersected with that same set on the server. Nothing here filters a catalogue,
 * so there is no client-side rule that could disagree with the writer — and a refused operation is still
 * refused in the database if one ever did.
 *
 * Both operations ask for confirmation first, and both require a reason, which is the only field a colleague
 * must type. The reason is not pre-filled and not remembered between operations.
 */
export function StaffRoleForm({
  userId,
  grantable,
  revocable,
  copy,
}: {
  readonly userId: string;
  readonly grantable: readonly StaffRoleOption[];
  readonly revocable: readonly StaffRoleOption[];
  readonly copy: StaffRoleCopy;
}) {
  const router = useRouter();
  const first = grantable[0];
  const [roleKey, setRoleKey] = useState(first === undefined ? '' : first.roleKey);
  const [reason, setReason] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState('');

  // The contract's own rule, checked here so a colleague keeps their typing rather than sending a request
  // that is refused. The database applies it again, which is what decides.
  const grantBlocked = roleKey === '' || reason.trim() === '';

  function submitGrant(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!asking) {
      setMessage(null);
      setAsking(true);
      return;
    }
    if (grantBlocked || busy) return;

    setBusy(true);
    setMessage(null);
    void (async () => {
      const result = await post('/api/users/roles/grant', {
        userId,
        roleKey,
        reason: reason.trim(),
        ...(expiresAt.trim() === '' ? {} : { expiresAt: new Date(expiresAt).toISOString() }),
      });
      setBusy(false);
      setAsking(false);
      if (result.status === 200) {
        setReason('');
        setExpiresAt('');
        router.refresh();
        return;
      }
      setMessage(roleMessageFor(result, copy));
    })();
  }

  function submitRevoke(event: FormEvent<HTMLFormElement>, target: string): void {
    event.preventDefault();
    if (revoking !== target) {
      setMessage(null);
      setRevoking(target);
      setRevokeReason('');
      return;
    }
    if (revokeReason.trim() === '' || busy) return;

    setBusy(true);
    setMessage(null);
    void (async () => {
      const result = await post('/api/users/roles/revoke', {
        userId,
        roleKey: target,
        reason: revokeReason.trim(),
      });
      setBusy(false);
      setRevoking(null);
      if (result.status === 200) {
        setRevokeReason('');
        router.refresh();
        return;
      }
      setMessage(roleMessageFor(result, copy));
    })();
  }

  return (
    <section className="mt-8 rounded-lg border border-hairline p-4">
      <h3 className="text-base font-medium text-ink-strong">{copy.heading}</h3>
      <p className="mt-2 max-w-prose text-sm text-ink-muted">{copy.intro}</p>
      {/* Owner decision 6. An operator must not believe this signs anybody out. */}
      <p className="mt-2 max-w-prose rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-ink-strong">
        {copy.sessionNote}
      </p>

      {first === undefined || copy.grantSubmit === undefined ? null : (
        <form onSubmit={submitGrant} className="mt-4">
          <label className="block text-sm">
            <span className="text-ink-strong">{copy.roleLabel}</span>
            <select
              className={FIELD_CLASS}
              value={roleKey}
              onChange={(event) => {
                setRoleKey(event.target.value);
                setAsking(false);
              }}
              disabled={busy}
            >
              {grantable.map((option) => (
                <option key={option.roleKey} value={option.roleKey}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="mt-4 block text-sm">
            <span className="text-ink-strong">{copy.reasonLabel}</span>
            <input
              className={FIELD_CLASS}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
              disabled={busy}
              required
            />
            <span className="mt-1 block text-xs text-ink-muted">{copy.reasonHint}</span>
          </label>

          <label className="mt-4 block text-sm">
            <span className="text-ink-strong">{copy.expiresLabel}</span>
            <input
              className={FIELD_CLASS}
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
              disabled={busy}
            />
            <span className="mt-1 block text-xs text-ink-muted">{copy.expiresHint}</span>
          </label>

          {asking ? (
            <p className="mt-4 max-w-prose text-sm text-ink-strong">{copy.grantConfirm}</p>
          ) : null}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button className={BUTTON_CLASS} type="submit" disabled={busy || grantBlocked}>
              {busy ? copy.working : copy.grantSubmit}
            </button>
            {asking ? (
              <button
                className={SECONDARY_CLASS}
                type="button"
                onClick={() => setAsking(false)}
                disabled={busy}
              >
                {copy.cancel}
              </button>
            ) : null}
          </div>
        </form>
      )}

      {revocable.length === 0 || copy.revokeSubmit === undefined ? null : (
        <div className="mt-6 border-t border-hairline pt-4">
          <p className="text-sm font-medium text-ink-strong">{copy.heldHeading}</p>
          <ul className="mt-3 space-y-3">
            {revocable.map((option) => (
              <li key={option.roleKey}>
                <form onSubmit={(event) => submitRevoke(event, option.roleKey)}>
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-sm text-ink-strong">{option.label}</span>
                    <button className={SECONDARY_CLASS} type="submit" disabled={busy}>
                      {copy.revokeSubmit}
                    </button>
                  </div>
                  {revoking === option.roleKey ? (
                    <div className="mt-3">
                      <p className="max-w-prose text-sm text-ink-strong">{copy.revokeConfirm}</p>
                      <label className="mt-2 block text-sm">
                        <span className="text-ink-strong">{copy.reasonLabel}</span>
                        <input
                          className={FIELD_CLASS}
                          value={revokeReason}
                          onChange={(event) => setRevokeReason(event.target.value)}
                          maxLength={500}
                          disabled={busy}
                          required
                        />
                      </label>
                      <button
                        className={SECONDARY_CLASS}
                        type="button"
                        onClick={() => setRevoking(null)}
                        disabled={busy}
                      >
                        {copy.cancel}
                      </button>
                    </div>
                  ) : null}
                </form>
              </li>
            ))}
          </ul>
        </div>
      )}

      {message === null ? null : (
        <p role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {message}
        </p>
      )}
    </section>
  );
}
