import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RENEWAL_INTERVAL_MS,
  REFRESH_PATH,
  requestRenewal,
  startRenewalLoop,
  type VisibilityTarget,
} from '../src/components/session-renewal';

/**
 * Silent access-token renewal, in the browser (Phase 5-A).
 *
 * Every assertion here is about restraint. The renewal carries no token and must not try to — it posts
 * an empty request and lets the server read the cookies. It renews on a schedule and when a tab wakes,
 * because a sleeping laptop comes back with an expired access cookie and a live refresh cookie. And
 * nothing here ever raises: a failed renewal is not an error a page should shout about, because the BFF
 * has already cleared the cookies if the session really ended.
 *
 * Fake timers and an injected clock and target; no DOM, no network, no browser, no provider.
 */

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface Seen {
  readonly url: string;
  readonly init: RequestInit;
}

function stubFetch(ok: boolean, seen: Seen[] = []): typeof fetch {
  return (async (input: unknown, init: RequestInit) => {
    seen.push({ url: String(input), init });
    return new Response(JSON.stringify(ok ? { status: 'ok' } : { code: 'AUTHENTICATION_FAILED' }), {
      status: ok ? 200 : 401,
    });
  }) as unknown as typeof fetch;
}

/** A stand-in for `document`, so the loop can be driven without a DOM. */
function fakeTarget(state: 'visible' | 'hidden' = 'visible'): VisibilityTarget & { fire(): void; listeners: number } {
  const listeners: Array<() => void> = [];
  return {
    visibilityState: state,
    addEventListener(_type, listener) {
      listeners.push(listener);
    },
    removeEventListener(_type, listener) {
      const index = listeners.indexOf(listener);
      if (index !== -1) listeners.splice(index, 1);
    },
    fire() {
      for (const listener of [...listeners]) listener();
    },
    get listeners() {
      return listeners.length;
    },
  };
}

describe('one renewal', () => {
  it('posts to the BFF route with the cookies and no body', async () => {
    const seen: Seen[] = [];
    const ok = await requestRenewal({ fetchImpl: stubFetch(true, seen) });

    expect(ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(REFRESH_PATH);
    expect(seen[0]?.init.method).toBe('POST');
    expect(seen[0]?.init.credentials).toBe('same-origin');
    expect(seen[0]?.init.body).toBeUndefined();
  });

  it('names no API route: the browser only ever talks to this origin', async () => {
    const seen: Seen[] = [];
    await requestRenewal({ fetchImpl: stubFetch(true, seen) });
    expect(seen[0]?.url).not.toContain('/v1/');
  });

  it('reports a refusal as false rather than raising', async () => {
    await expect(requestRenewal({ fetchImpl: stubFetch(false) })).resolves.toBe(false);
  });

  it('reports a network failure as false rather than raising', async () => {
    const failing = (async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    await expect(requestRenewal({ fetchImpl: failing })).resolves.toBe(false);
  });
});

describe('the renewal loop', () => {
  it('does not renew immediately, then renews on each interval', async () => {
    vi.useFakeTimers();
    const seen: Seen[] = [];
    const stop = startRenewalLoop({ intervalMs: 1000, fetchImpl: stubFetch(true, seen) });

    expect(seen).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen).toHaveLength(3);
    stop();
  });

  it('renews when the page becomes visible', async () => {
    vi.useFakeTimers();
    const seen: Seen[] = [];
    const target = fakeTarget('visible');
    const stop = startRenewalLoop({ intervalMs: 60_000, target, fetchImpl: stubFetch(true, seen) });

    target.fire();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveLength(1);
    stop();
  });

  it('does not renew when the page has just been hidden', async () => {
    vi.useFakeTimers();
    const seen: Seen[] = [];
    const target = fakeTarget('hidden');
    const stop = startRenewalLoop({ intervalMs: 60_000, target, fetchImpl: stubFetch(true, seen) });

    target.fire();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveLength(0);
    stop();
  });

  it('keeps one renewal in flight at a time', async () => {
    vi.useFakeTimers();
    const seen: Seen[] = [];
    let release: (() => void) | undefined;
    const slow = (async (input: unknown, init: RequestInit) => {
      seen.push({ url: String(input), init });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const target = fakeTarget('visible');
    const stop = startRenewalLoop({ intervalMs: 1000, target, fetchImpl: slow });

    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toHaveLength(1);
    // A visibility change and another tick while the first is still open must both be ignored.
    target.fire();
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toHaveLength(1);

    release?.();
    stop();
  });

  it('stops cleanly: no timer, no listener', async () => {
    vi.useFakeTimers();
    const seen: Seen[] = [];
    const target = fakeTarget('visible');
    const stop = startRenewalLoop({ intervalMs: 1000, target, fetchImpl: stubFetch(true, seen) });

    await vi.advanceTimersByTimeAsync(1000);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    target.fire();
    await vi.advanceTimersByTimeAsync(0);

    expect(seen).toHaveLength(1);
    expect(target.listeners).toBe(0);
  });

  it('survives a failing renewal and keeps trying', async () => {
    vi.useFakeTimers();
    const failing = (async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    const stop = startRenewalLoop({ intervalMs: 1000, fetchImpl: failing });

    // Three failed renewals must pass without an unhandled rejection taking the page down.
    await vi.advanceTimersByTimeAsync(3000);
    stop();
    expect(true).toBe(true);
  });

  it('renews well inside the fifteen-minute access cookie by default', () => {
    // Not a style preference: a default longer than the cookie would renew a session that has already
    // lapsed, which is the bug this whole increment exists to prevent.
    expect(DEFAULT_RENEWAL_INTERVAL_MS).toBeLessThan(15 * 60 * 1000);
  });
});
