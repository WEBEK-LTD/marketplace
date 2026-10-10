'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * The two per-row actions, and the only client code on the notification surface (Phase 7-C).
 *
 * Thin by design. It holds **one identifier and two labels** — nothing else about a notification crosses
 * into the browser through these props, because a client component's props travel in the RSC payload and
 * a row's category, subject and path are already rendered on the server.
 *
 * Both actions post to a BFF route on this origin and read **only the status** of the answer. There is no
 * Supabase client, no credential, no token and no account: the session is an `HttpOnly` cookie this code
 * cannot read, and the account the server acts on is resolved from it, never named here.
 *
 * **Both are idempotent, which is why a failure is safe to retry.** Marking a notification that is already
 * read, or archiving one that is already archived, changes nothing and still succeeds — so a button
 * pressed twice, or pressed again after a timeout, cannot do anything a person did not ask for.
 *
 * After a successful action the server is asked to re-render. The list, the badge and the archived view
 * then come from the database rather than from arithmetic this component did on a number it was given.
 */

export interface NotificationActionCopy {
  readonly markRead: string;
  readonly archive: string;
  readonly working: string;
  readonly failed: string;
}

const BUTTON_CLASS =
  'rounded-md border border-edge px-3 py-1 text-xs font-medium text-ink-strong disabled:opacity-60';

export function NotificationActions({
  id,
  isUnread,
  isArchived,
  copy,
}: {
  readonly id: string;
  readonly isUnread: boolean;
  readonly isArchived: boolean;
  readonly copy: NotificationActionCopy;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function act(action: 'read' | 'archive'): Promise<void> {
    if (pending) return;
    setFailed(false);
    setPending(true);
    try {
      const response = await fetch(`/api/notifications/${action}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [id] }),
      });
      if (response.status === 200) {
        // The server re-reads the list and the badge. Nothing here guesses at the new state.
        router.refresh();
        return;
      }
      setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      {isUnread && !isArchived && (
        <button type="button" onClick={() => act('read')} disabled={pending} className={BUTTON_CLASS}>
          {pending ? copy.working : copy.markRead}
        </button>
      )}
      {!isArchived && (
        <button type="button" onClick={() => act('archive')} disabled={pending} className={BUTTON_CLASS}>
          {pending ? copy.working : copy.archive}
        </button>
      )}
      {failed && (
        <span role="alert" className="text-xs text-ink-strong">
          {copy.failed}
        </span>
      )}
    </span>
  );
}

/**
 * The "mark everything read" action.
 *
 * Sends no identifiers at all, which is the contract's way of saying "all of the caller's unread ones" —
 * and which the database has accepted as its null form since migration 0029. It is scoped to the caller
 * there, so this button can only ever clear the badge of the person pressing it.
 */
export function MarkAllNotificationsRead({
  label,
  copy,
}: {
  readonly label: string;
  readonly copy: NotificationActionCopy;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function markAll(): Promise<void> {
    if (pending) return;
    setFailed(false);
    setPending(true);
    try {
      const response = await fetch('/api/notifications/read', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (response.status === 200) {
        router.refresh();
        return;
      }
      setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={markAll} disabled={pending} className={BUTTON_CLASS}>
        {pending ? copy.working : label}
      </button>
      {failed && (
        <span role="alert" className="text-xs text-ink-strong">
          {copy.failed}
        </span>
      )}
    </span>
  );
}
