'use client';

import { useEffect, useRef } from 'react';
import { createPoller, type PollCycle } from './message-polling';

/**
 * Binds the catch-up engine to this browser (Phase 5-F).
 *
 * The whole of the hook is the binding: the cadence, the visibility rules, the no-overlap guard and the
 * staleness check all live in `message-polling.ts`, where a test drives them with a fake clock. What is
 * here is `window.setTimeout` and `document.visibilityState`, and one careful piece of bookkeeping.
 *
 * That bookkeeping is the ref. The effect that owns the poller depends on the interval alone, so it runs
 * once per mount rather than on every render — one timer, one `visibilitychange` listener, both undone on
 * unmount. The callback it runs is read through a ref, so a re-rendered component polls with its current
 * state instead of a closure captured at mount. Putting `run` in the dependency list instead would tear
 * the poller down and build a new one on every render, which is how duplicate timers happen.
 */
export function useMessagePolling(intervalMs: number, run: (cycle: PollCycle) => Promise<void>): void {
  const latest = useRef(run);

  useEffect(() => {
    latest.current = run;
  }, [run]);

  useEffect(() => {
    const poller = createPoller({
      intervalMs,
      clock: {
        setTimeout: (handler, ms) => window.setTimeout(handler, ms),
        clearTimeout: (handle) => {
          window.clearTimeout(handle as number);
        },
      },
      visibility: {
        isVisible: () => document.visibilityState === 'visible',
        onChange: (listener) => {
          document.addEventListener('visibilitychange', listener);
          return () => {
            document.removeEventListener('visibilitychange', listener);
          };
        },
      },
      run: (cycle) => latest.current(cycle),
    });

    poller.start();
    return () => {
      poller.stop();
    };
  }, [intervalMs]);
}
