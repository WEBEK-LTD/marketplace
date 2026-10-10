'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { adminApiPath } from '../paths';

/**
 * The review moderation control (Phase 7-P).
 *
 * One control, because there is one decision: where the review should end up, and why. What it deliberately
 * does **not** contain is as important:
 *
 * - **No moderator, and no way to name one.** The API resolves the caller from their own session; there is no
 *   field here that could carry an account, and no colleague is named anywhere on these screens.
 * - **No timestamp.** `moderate_review` records when it ruled and moves `published_at` itself.
 * - **No automatic hiding reason.** The writer clears `auto_hidden_reason`; a control that could set it would
 *   be able to make a human decision look like an automatic one.
 * - **Nothing that reaches the reply, the order or the rating.** A moderator judges what was written; they do
 *   not edit it, and they cannot re-score it.
 * - **No control that moderates the reply.** There is no writer for a reply's status in this repository, so
 *   there is no field, no path and no branch for one here.
 * - **No transition rule.** All four statuses are offered from all four, because `moderate_review` imposes no
 *   matrix; re-recording the status a review already holds is how a decision is re-affirmed with a fresh
 *   reason. A reduced list here would refuse a legal decision the database allows.
 * - **No optimistic row.** A written reason survives a failed request, because a colleague who lost one has
 *   lost more than the request.
 *
 * **The reason is required for every decision**, not only for the ones that hide something — that is
 * `reviews_moderated_has_reason`'s rule, and checking it here keeps the colleague's typing rather than sending
 * a request the database will refuse.
 *
 * It asks twice, and the question depends on where the review is going: publishing something automation hid,
 * hiding something a buyer wrote, and removing it outright are three different things to be sure about.
 *
 * **Stale state is the server's answer, not a guess made here.** When the caller turns out to be the review's
 * buyer or seller, the API answers with its own code and the sentence for it says a colleague who is not a
 * party has to take it. Nothing in this file tracks what the database currently holds.
 */

const BUTTON_CLASS =
  'rounded-md bg-surface-ink px-4 py-2 text-sm font-medium text-on-ink disabled:opacity-60';
const SECONDARY_CLASS =
  'rounded-md border border-edge px-4 py-2 text-sm font-medium text-ink-strong disabled:opacity-60';
const FIELD_CLASS =
  'mt-1 w-full rounded-md border border-edge px-3 py-2 text-sm text-ink-strong';

/** `ReviewModerationReasonSchema`'s bound, which is the column's own. */
const REASON_MAX_LENGTH = 4000;

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
 * `targets` is 0026's four statuses with their labels, assembled by the page. It is a list rather than four
 * named fields so that a status the page chose not to offer contributes no words to the payload.
 */
export interface ReviewModerationCopy {
  readonly heading: string;
  readonly intro: string;
  readonly statusLabel: string;
  readonly reasonLabel: string;
  readonly reasonHint: string;
  readonly submit: string;
  readonly confirmPublish: string;
  readonly confirmHide: string;
  readonly confirmRemove: string;
  readonly confirmPending: string;
  readonly cancel: string;
  readonly working: string;
  readonly failed: string;
  readonly conflict: string;
  readonly isParty: string;
  readonly signedOut: string;
  readonly targets: ReadonlyArray<{ readonly value: string; readonly label: string }>;
}

export function ReviewModerationForm({
  reviewId,
  currentStatus,
  copy,
}: {
  readonly reviewId: string;
  /** Where the review is now, used only to preselect something other than where it already is. */
  readonly currentStatus: string;
  readonly copy: ReviewModerationCopy;
}) {
  const router = useRouter();
  const first = copy.targets.find((target) => target.value !== currentStatus) ?? copy.targets[0];
  const [status, setStatus] = useState(first === undefined ? '' : first.value);
  const [reason, setReason] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (first === undefined) return null;

  // Every decision carries its reason — the schema's rule, not a rule of this control's own.
  const blocked = reason.trim() === '';

  const question =
    status === 'published'
      ? copy.confirmPublish
      : status === 'hidden'
        ? copy.confirmHide
        : status === 'removed'
          ? copy.confirmRemove
          : copy.confirmPending;

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
      const result = await post('/api/reviews/moderation', {
        reviewId,
        status,
        reason: reason.trim(),
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
      if (result.code === 'REVIEW_IS_PARTY') {
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

      <label className="mt-4 block text-sm">
        <span className="text-ink-strong">{copy.reasonLabel}</span>
        <textarea
          className={FIELD_CLASS}
          rows={3}
          maxLength={REASON_MAX_LENGTH}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
          disabled={busy}
        />
        <span className="mt-1 block text-xs text-ink-muted">{copy.reasonHint}</span>
      </label>

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
