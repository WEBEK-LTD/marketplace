'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import {
  DEFAULT_RENEWAL_INTERVAL_MS,
  requestRenewal,
  startRenewalLoop,
} from './session-renewal';

/**
 * Silent access-token renewal (Phase 5-A).
 *
 * The access cookie lives fifteen minutes (C-8). This component asks the BFF to renew it well before
 * that, so a signed-in surface stays usable without anybody retyping a password. It carries no token and
 * cannot: both live in `__Host-` cookies the browser will not show to JavaScript.
 *
 * Two modes, because there are two situations.
 *
 * **`keep`** runs on a signed-in page: renew on a schedule, and again whenever the tab becomes visible.
 *
 * **`restore`** runs on the signed-out view a protected page renders when the API says the session is
 * over. One attempt: on success it re-renders the route, which now has a live access cookie; on failure
 * it stops and leaves the sign-in link the page already shows. Never a loop — a refused renewal means
 * the session is genuinely gone, and retrying would be a browser hammering an endpoint that has already
 * given its answer.
 *
 * The mechanics live in `./session-renewal`, which is where they are tested. This file is the React
 * wiring and nothing else.
 */

export { DEFAULT_RENEWAL_INTERVAL_MS };

export interface SessionKeeperProps {
  /** `keep` renews on a schedule; `restore` makes one attempt and re-renders on success. */
  readonly mode: 'keep' | 'restore';
  /** Milliseconds between renewals in `keep` mode. */
  readonly intervalMs?: number;
}

export function SessionKeeper({ mode, intervalMs = DEFAULT_RENEWAL_INTERVAL_MS }: SessionKeeperProps): null {
  const router = useRouter();
  const attempted = useRef(false);

  useEffect(() => {
    if (mode !== 'restore' || attempted.current) return;
    attempted.current = true;
    void requestRenewal().then((ok) => {
      if (ok) router.refresh();
    });
  }, [mode, router]);

  useEffect(() => {
    if (mode !== 'keep') return undefined;
    return startRenewalLoop({ intervalMs, target: document });
  }, [intervalMs, mode]);

  return null;
}
