'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Ending the session on this device (Phase 7-E).
 *
 * The first surface in this project to offer sign-out as a control. The endpoint behind it is 5-A's
 * `POST /api/auth/logout`, which clears the session cookies on this origin and revokes the session
 * upstream; nothing about it is new here.
 *
 * **This device only, and the page says so.** There is no "sign out everywhere": no approved mechanism
 * for revoking a person's other sessions exists in this repository, and a button that claimed to would
 * be a button that lies.
 *
 * It holds no token and no account. The session is an `HttpOnly` cookie this code cannot read, and the
 * server decides whose session ends. On success the person is sent to the sign-in page rather than
 * shown a signed-in shell that is no longer true.
 */
export function SignOutButton({
  label,
  working,
  failed,
}: {
  readonly label: string;
  readonly working: string;
  readonly failed: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);

  async function signOut(): Promise<void> {
    if (pending) return;
    setError(false);
    setPending(true);
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      if (response.ok) {
        router.replace('/login');
        router.refresh();
        return;
      }
      setError(true);
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="mt-3 flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={() => void signOut()}
        disabled={pending}
        className="rounded-md border border-edge px-4 py-2 text-sm font-medium text-ink-strong disabled:opacity-60"
      >
        {pending ? working : label}
      </button>
      {error && (
        <span role="alert" className="text-sm text-ink-strong">
          {failed}
        </span>
      )}
    </span>
  );
}
