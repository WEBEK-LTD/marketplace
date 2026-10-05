/**
 * The mechanics of silent access-token renewal, with nothing React in them (Phase 5-A).
 *
 * Separated from the component on purpose. The behaviour worth pinning here is about *restraint* — how
 * often a browser asks, that it asks again when a tab wakes, that one in flight blocks another, that a
 * refusal is not retried — and none of that needs a DOM to be true. Kept in the component it would need
 * a rendering library to test; kept here it is exercised with fake timers and an injected clock.
 *
 * Nothing in this module holds a token. Both live in `__Host-` cookies the browser will not show to
 * JavaScript, so the request is a bare `POST` and the server decides everything about it.
 */

/** Ten minutes: comfortably inside the fifteen-minute access cookie of C-8, and not a busy loop. */
export const DEFAULT_RENEWAL_INTERVAL_MS = 10 * 60 * 1000;

export const REFRESH_PATH = '/api/auth/refresh';

export interface RenewalRequest {
  readonly fetchImpl?: typeof fetch;
  readonly path?: string;
}

/**
 * Asks the BFF to renew the session.
 *
 * Returns whether it worked and never raises: a failed renewal is not an error a page should show. If
 * the session really has ended the BFF has already cleared the cookies, so the next navigation renders
 * the signed-out view — which is a better way to say it than an alert over a page somebody is reading.
 */
export async function requestRenewal({ fetchImpl, path = REFRESH_PATH }: RenewalRequest = {}): Promise<boolean> {
  try {
    const call = fetchImpl ?? fetch;
    const response = await call(path, {
      method: 'POST',
      // Same-origin credentials are what carry the cookies; there is deliberately no body.
      credentials: 'same-origin',
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** The slice of the document the loop needs, so a test can supply one without a DOM. */
export interface VisibilityTarget {
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
  readonly visibilityState: 'visible' | 'hidden';
}

export interface RenewalLoopOptions extends RenewalRequest {
  readonly intervalMs?: number;
  readonly target?: VisibilityTarget;
  readonly setIntervalImpl?: typeof setInterval;
  readonly clearIntervalImpl?: typeof clearInterval;
}

/**
 * Starts renewing on a schedule, and again whenever the page becomes visible.
 *
 * The visibility half is not an optimisation. A laptop that slept for an hour wakes with an expired
 * access cookie and a perfectly good refresh cookie, and the interval that should have fired during the
 * sleep did not: renewing on wake is what makes the session survive the nap.
 *
 * One renewal at a time. A visibility change during a scheduled renewal must not double up, so the flag
 * below is checked before each attempt rather than after.
 *
 * @returns the function that stops it. Callers must call it; the loop holds a timer and a listener.
 */
export function startRenewalLoop(options: RenewalLoopOptions = {}): () => void {
  const {
    intervalMs = DEFAULT_RENEWAL_INTERVAL_MS,
    target,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    ...request
  } = options;

  let running = false;
  const renew = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await requestRenewal(request);
    } finally {
      running = false;
    }
  };

  const timer = setIntervalImpl(() => void renew(), intervalMs);
  const onVisible = (): void => {
    if (target !== undefined && target.visibilityState === 'visible') void renew();
  };
  target?.addEventListener('visibilitychange', onVisible);

  return () => {
    clearIntervalImpl(timer);
    target?.removeEventListener('visibilitychange', onVisible);
  };
}
