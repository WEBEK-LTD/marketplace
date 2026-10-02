'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Close one Admin Only service request — the approved staff closure (Phase 7-J).
 *
 * **It sends one identifier and reads a status back.** There is no account here, no role, no permission and no
 * assurance level: the session is an `HttpOnly` cookie this code cannot read, and everything about who is asking
 * is resolved on the server from it. A request identifier is not an authorization — the API refuses the write
 * for anybody without `service_requests.request.manage` in a strong enough session, and so does the database.
 *
 * **There is no status field and no reason field.** The transition is named by the operation
 * (`open → declined`), so a caller cannot ask for another one; and the approved decision records no reason, so
 * this form asks for none rather than collecting something nothing stores.
 *
 * **Closing takes two steps on purpose.** It is final for the buyer who sent the brief, and nothing on this
 * surface reopens it, so the button opens a confirmation and the second press is the one that sends.
 *
 * **It creates no obligation.** Closing a brief charges nothing, orders nothing and produces no quote; there is
 * no payment control anywhere in this file, and the one it sends to writes none.
 *
 * On success the route is refreshed rather than the screen being patched, so what a colleague ends up looking at
 * is the state the database holds.
 */

export interface DeclineCopy {
  readonly action: string;
  readonly question: string;
  readonly confirm: string;
  readonly cancel: string;
  readonly working: string;
  readonly failedDecided: string;
  readonly failedNotFound: string;
  readonly failedSignedOut: string;
  readonly failedGeneric: string;
}

export function AdminServiceRequestDeclineForm({
  requestId,
  copy,
}: {
  readonly requestId: string;
  readonly copy: DeclineCopy;
}) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function messageFor(response: Response): Promise<string> {
    if (response.status === 401) return copy.failedSignedOut;
    if (response.status === 404) return copy.failedNotFound;
    if (response.status === 409) return copy.failedDecided;
    return copy.failedGeneric;
  }

  async function submit(): Promise<void> {
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      const response = await fetch('/api/service-requests/decline', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId }),
      });
      if (response.status === 200) {
        setAsking(false);
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

  if (!asking) {
    return (
      <div>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setAsking(true);
          }}
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm text-neutral-900"
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
    <div className="max-w-prose rounded-lg border border-neutral-300 p-4">
      <p className="text-sm font-medium text-neutral-900">{copy.question}</p>
      <div className="mt-3 flex flex-wrap gap-3">
        <button
          type="button"
          disabled={pending}
          onClick={() => void submit()}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {pending ? copy.working : copy.confirm}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setAsking(false);
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
    </div>
  );
}
