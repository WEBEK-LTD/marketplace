import { describe, expect, it, vi } from 'vitest';
import {
  compareSeq,
  createPoller,
  mergeConversations,
  mergeMessages,
  mergeUnreadCount,
  type PollCycle,
  type PollClock,
  type VisibilitySource,
} from '../src/components/message-polling';
import type { RenderableConversation, RenderableMessage } from '../src/components/messaging-views';

/**
 * The messaging catch-up engine (Phase 5-F).
 *
 * Every rule the owner set for polling is here, driven by a fake clock and a fake visibility source:
 *
 *   * an exact cadence while visible, with no jitter, no backoff and no adaptation;
 *   * not one request while hidden, and one immediate catch-up on returning to visible;
 *   * never two overlapping requests, and the cadence unaffected by a slow one;
 *   * a stale or post-unmount answer that cannot reach state;
 *   * every timer and listener released on stop;
 *   * merges that deduplicate strictly by id, keep what was already loaded, and invent nothing.
 *
 * No browser, no component, no network: the engine takes its clock and its visibility as parameters,
 * which is exactly why these can be asserted rather than hoped for.
 */

/**
 * A deterministic clock: nothing runs until the test advances it.
 *
 * `advance` is asynchronous on purpose. Real elapsed time lets the microtask queue drain, so a cycle that
 * resolves is finished by the time the next tick arrives; a synchronous fake would leave every cycle
 * permanently "in flight" and make the no-overlap guard swallow the whole cadence. Awaiting after each
 * timer models the passage of time rather than defeating it — and a cycle that genuinely never settles
 * still blocks the next tick, which is what the overlap test relies on.
 */
function fakeClock(): PollClock & {
  advance: (ms: number) => Promise<void>;
  pending: () => number;
  now: () => number;
} {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; handler: () => void }>();

  return {
    setTimeout(handler, ms) {
      const handle = nextHandle++;
      timers.set(handle, { at: now + ms, handler });
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    async advance(ms) {
      // Time passing first lets whatever is already settled actually settle, before any timer fires.
      await Promise.resolve();
      await Promise.resolve();
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        const [handle, timer] = due;
        timers.delete(handle);
        now = timer.at;
        timer.handler();
        await Promise.resolve();
        await Promise.resolve();
      }
      now = until;
    },
    pending: () => timers.size,
    now: () => now,
  };
}

function fakeVisibility(initial = true): VisibilitySource & {
  set: (visible: boolean) => void;
  listeners: () => number;
} {
  let visible = initial;
  const listeners = new Set<() => void>();
  return {
    isVisible: () => visible,
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next) {
      visible = next;
      for (const listener of [...listeners]) listener();
    },
    listeners: () => listeners.size,
  };
}

describe('the cadence', () => {
  it('runs one catch-up immediately and then exactly one per interval', async () => {
    const clock = fakeClock();
    const visibility = fakeVisibility();
    const run = vi.fn(async () => undefined);
    const poller = createPoller({ intervalMs: 5000, clock, visibility, run });

    poller.start();
    expect(run).toHaveBeenCalledTimes(1);

    await clock.advance(4999);
    expect(run).toHaveBeenCalledTimes(1);
    await clock.advance(1);
    expect(run).toHaveBeenCalledTimes(2);
    await clock.advance(15_000);
    expect(run).toHaveBeenCalledTimes(5);

    poller.stop();
  });

  it('uses the interval it was given and nothing else — no jitter, no backoff', async () => {
    for (const intervalMs of [5000, 15_000]) {
      const clock = fakeClock();
      const visibility = fakeVisibility();
      const run = vi.fn(async () => undefined);
      const poller = createPoller({ intervalMs, clock, visibility, run });

      poller.start();
      await clock.advance(intervalMs * 10);
      // Ten ticks after the immediate one, at exactly this interval, every time.
      expect(run, String(intervalMs)).toHaveBeenCalledTimes(11);
      poller.stop();
    }
  });

  it('keeps the cadence tick-to-tick even when a cycle is slow', async () => {
    const clock = fakeClock();
    const visibility = fakeVisibility();
    // A holder rather than a bare `let`: TypeScript narrows a variable only assigned inside a
    // callback to `null`, and `next build` type-checks these files.
    const gate: { release: () => void } = { release: () => undefined };
    const run = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        }),
    );
    const poller = createPoller({ intervalMs: 5000, clock, visibility, run });

    poller.start();
    expect(run).toHaveBeenCalledTimes(1);

    // The first cycle is still in flight across two ticks: both are skipped, neither is queued.
    await clock.advance(10_000);
    expect(run).toHaveBeenCalledTimes(1);

    gate.release();
    await Promise.resolve();
    await Promise.resolve();

    // And the cadence was never lost: the next tick is on time rather than an interval after the finish.
    await clock.advance(5000);
    expect(run).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it('is idempotent: starting twice does not create a second timer', async () => {
    const clock = fakeClock();
    const visibility = fakeVisibility();
    const run = vi.fn(async () => undefined);
    const poller = createPoller({ intervalMs: 5000, clock, visibility, run });

    poller.start();
    poller.start();
    expect(run).toHaveBeenCalledTimes(1);
    expect(clock.pending()).toBe(1);
    expect(visibility.listeners()).toBe(1);

    await clock.advance(5000);
    expect(run).toHaveBeenCalledTimes(2);
    poller.stop();
  });
});

describe('visibility', () => {
  it('makes no request at all while hidden', async () => {
    const clock = fakeClock();
    const visibility = fakeVisibility(false);
    const run = vi.fn(async () => undefined);
    const poller = createPoller({ intervalMs: 5000, clock, visibility, run });

    poller.start();
    await clock.advance(60_000);

    expect(run).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
    poller.stop();
  });

  it('stops polling the moment the page is hidden, and leaves no timer behind', async () => {
    const clock = fakeClock();
    const visibility = fakeVisibility();
    const run = vi.fn(async () => undefined);
    const poller = createPoller({ intervalMs: 5000, clock, visibility, run });

    poller.start();
    await clock.advance(5000);
    expect(run).toHaveBeenCalledTimes(2);

    visibility.set(false);
    expect(clock.pending()).toBe(0);
    await clock.advance(60_000);
    expect(run).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it('runs exactly one immediate catch-up when the page becomes visible again', async () => {
    const clock = fakeClock();
    const visibility = fakeVisibility();
    const run = vi.fn(async () => undefined);
    const poller = createPoller({ intervalMs: 5000, clock, visibility, run });

    poller.start();
    visibility.set(false);
    await clock.advance(60_000);
    expect(run).toHaveBeenCalledTimes(1);

    visibility.set(true);
    expect(run).toHaveBeenCalledTimes(2);
    // And the cadence restarts from that moment rather than firing a backlog.
    await clock.advance(4999);
    expect(run).toHaveBeenCalledTimes(2);
    await clock.advance(1);
    expect(run).toHaveBeenCalledTimes(3);
    poller.stop();
  });

  it('catches up on start when the page was hidden at mount and becomes visible later', async () => {
    const clock = fakeClock();
    const visibility = fakeVisibility(false);
    const run = vi.fn(async () => undefined);
    const poller = createPoller({ intervalMs: 15_000, clock, visibility, run });

    poller.start();
    expect(run).not.toHaveBeenCalled();

    visibility.set(true);
    expect(run).toHaveBeenCalledTimes(1);
    await clock.advance(15_000);
    expect(run).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it('does not start a second request when it becomes visible mid-flight', async () => {
    const clock = fakeClock();
    const visibility = fakeVisibility();
    // A holder rather than a bare `let`: TypeScript narrows a variable only assigned inside a
    // callback to `null`, and `next build` type-checks these files.
    const gate: { release: () => void } = { release: () => undefined };
    const run = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        }),
    );
    const poller = createPoller({ intervalMs: 5000, clock, visibility, run });

    poller.start();
    visibility.set(false);
    visibility.set(true);
    expect(run).toHaveBeenCalledTimes(1);

    gate.release();
    await Promise.resolve();
    poller.stop();
  });
});

describe('cleanup and staleness', () => {
  it('releases the timer and the listener on stop', async () => {
    const clock = fakeClock();
    const visibility = fakeVisibility();
    const run = vi.fn(async () => undefined);
    const poller = createPoller({ intervalMs: 5000, clock, visibility, run });

    poller.start();
    poller.stop();

    expect(clock.pending()).toBe(0);
    expect(visibility.listeners()).toBe(0);

    await clock.advance(60_000);
    visibility.set(false);
    visibility.set(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('is idempotent on stop, and a stopped poller never fires again', async () => {
    const clock = fakeClock();
    const visibility = fakeVisibility();
    const run = vi.fn(async () => undefined);
    const poller = createPoller({ intervalMs: 5000, clock, visibility, run });

    poller.start();
    poller.stop();
    poller.stop();
    await clock.advance(60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('marks an in-flight cycle stale once the poller has stopped', async () => {
    const clock = fakeClock();
    const visibility = fakeVisibility();
    const cycles: PollCycle[] = [];
    // A holder rather than a bare `let`: TypeScript narrows a variable only assigned inside a
    // callback to `null`, and `next build` type-checks these files.
    const gate: { release: () => void } = { release: () => undefined };
    const poller = createPoller({
      intervalMs: 5000,
      clock,
      visibility,
      run: async (cycle) => {
        cycles.push(cycle);
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
      },
    });

    poller.start();
    expect(cycles[0]?.isCurrent()).toBe(true);

    poller.stop();
    // The answer arrives after unmount: the consumer is told not to write it anywhere.
    expect(cycles[0]?.isCurrent()).toBe(false);
    gate.release();
    await Promise.resolve();
  });

  it('numbers cycles in order, so an older answer can always be recognised as older', async () => {
    const clock = fakeClock();
    const visibility = fakeVisibility();
    const seen: number[] = [];
    const poller = createPoller({
      intervalMs: 5000,
      clock,
      visibility,
      run: async (cycle) => {
        seen.push(cycle.generation);
      },
    });

    poller.start();
    await clock.advance(10_000);
    expect(seen).toEqual([1, 2, 3]);
    expect(poller.startedCycles()).toBe(3);
    poller.stop();
  });

  it('keeps polling after a cycle rejects', async () => {
    const clock = fakeClock();
    const visibility = fakeVisibility();
    const run = vi.fn(async () => {
      throw new Error('the network is gone');
    });
    const poller = createPoller({ intervalMs: 5000, clock, visibility, run });

    poller.start();
    await Promise.resolve();
    await Promise.resolve();
    await clock.advance(5000);
    await Promise.resolve();
    await Promise.resolve();
    await clock.advance(5000);

    expect(run).toHaveBeenCalledTimes(3);
    poller.stop();
  });
});

describe('comparing sequences', () => {
  it('orders digit strings numerically, at any size', async () => {
    expect(compareSeq('2', '10')).toBeLessThan(0);
    expect(compareSeq('10', '2')).toBeGreaterThan(0);
    expect(compareSeq('7', '7')).toBe(0);
    // Beyond the safe integer range, where Number() would compare two different sequences as equal.
    expect(compareSeq('9007199254740993', '9007199254740992')).toBeGreaterThan(0);
    expect(compareSeq('9007199254740992', '9007199254740993')).toBeLessThan(0);
  });
});

function message(seq: number, overrides: Partial<RenderableMessage> = {}): RenderableMessage {
  return {
    id: `a1000000-0000-4000-8000-00000000000${seq}`,
    seq: String(seq),
    isOwnMessage: false,
    messageType: 'text',
    body: `Message ${seq}`,
    createdAt: `2026-09-24T18:0${seq}:00.000Z`,
    // 0104. Always present, usually empty: a message with no files is not the same as a response that lost
    // the field, and the projection keeps the two apart by never making this optional.
    attachments: [],
    ...overrides,
  };
}

describe('merging messages', () => {
  it('appends new messages after the ones already loaded', async () => {
    const merged = mergeMessages([message(1), message(2)], [message(3), message(4)]);
    expect(merged.map((m) => m.seq)).toEqual(['1', '2', '3', '4']);
  });

  it('keeps every already-loaded message when the latest page overlaps', async () => {
    // The reader had paged back to 1..4; the latest page returns 3..6.
    const merged = mergeMessages(
      [message(1), message(2), message(3), message(4)],
      [message(3), message(4), message(5), message(6)],
    );
    expect(merged.map((m) => m.seq)).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('never replaces the thread with only the latest page', async () => {
    const loaded = [message(1), message(2), message(3)];
    const merged = mergeMessages(loaded, [message(9)]);
    for (const older of loaded) {
      expect(merged.some((m) => m.id === older.id), older.id).toBe(true);
    }
    expect(merged).toHaveLength(4);
  });

  it('deduplicates strictly by id, and by nothing else', async () => {
    // Same id, different body: one row, and the server's copy is the one kept.
    const merged = mergeMessages([message(1)], [message(1, { body: 'Edited upstream' })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.body).toBe('Edited upstream');

    // Identical body, timestamp and sender but different ids: two rows, because they are two messages.
    const twins = mergeMessages(
      [],
      [
        { ...message(1), id: 'a', seq: '1' },
        { ...message(1), id: 'b', seq: '2' },
      ],
    );
    expect(twins).toHaveLength(2);
  });

  it('is idempotent: polling the same page again changes nothing', async () => {
    const page = [message(1), message(2), message(3)];
    const once = mergeMessages(page, page);
    const twice = mergeMessages(once, page);
    expect(twice).toEqual(once);
    expect(twice).toHaveLength(3);
  });

  it('orders by sequence rather than by arrival, so an out-of-order answer cannot scramble history', async () => {
    const merged = mergeMessages([message(2)], [message(3), message(1)]);
    expect(merged.map((m) => m.seq)).toEqual(['1', '2', '3']);
  });

  it('invents nothing: every merged message came from one of the two inputs', async () => {
    const merged = mergeMessages([message(1)], [message(2)]);
    const sources = new Set([message(1).id, message(2).id]);
    for (const m of merged) expect(sources.has(m.id)).toBe(true);
  });
});

function conversation(
  id: string,
  overrides: Partial<RenderableConversation> = {},
): RenderableConversation {
  return {
    conversationId: id,
    subjectType: 'listing',
    listingTitleSnapshot: 'Walnut dining table',
    membershipState: 'active',
    isMuted: false,
    isClosed: false,
    unreadCount: 0,
    lastMessageAt: '2026-09-24T18:30:00.000Z',
    lastMessageBody: 'Still available?',
    ...overrides,
  };
}

describe('merging conversations', () => {
  it('updates a row in place, matched by conversation id', async () => {
    const before = [conversation('one'), conversation('two')];
    const after = mergeConversations(before, [
      conversation('one', { unreadCount: 2, lastMessageBody: 'I can deliver on Tuesday.' }),
      conversation('two'),
    ]);

    expect(after[0]?.unreadCount).toBe(2);
    expect(after[0]?.lastMessageBody).toBe('I can deliver on Tuesday.');
    // The untouched row keeps its identity, so React re-renders only what changed.
    expect(after[1]).toBe(before[1]);
  });

  it('takes the server’s order and the server’s membership of the page', async () => {
    const before = [conversation('one'), conversation('two')];
    const after = mergeConversations(before, [conversation('two'), conversation('three')]);

    expect(after.map((row) => row.conversationId)).toEqual(['two', 'three']);
    // A row the server no longer lists on this page is gone — which is how leaving one removes it.
    expect(after.some((row) => row.conversationId === 'one')).toBe(false);
  });

  it('fabricates nothing: every field comes from the fresh row', async () => {
    const after = mergeConversations(
      [conversation('one', { unreadCount: 5, isMuted: true })],
      [conversation('one', { unreadCount: 0, isMuted: false, lastMessageAt: null, lastMessageBody: null })],
    );

    expect(after[0]).toMatchObject({
      unreadCount: 0,
      isMuted: false,
      lastMessageAt: null,
      lastMessageBody: null,
    });
  });

  it('is idempotent', async () => {
    const page = [conversation('one'), conversation('two')];
    const once = mergeConversations(page, page);
    expect(mergeConversations(once, page)).toEqual(once);
  });
});

describe('merging the unread count', () => {
  it('takes a fresh count', async () => {
    expect(mergeUnreadCount(null, 4)).toBe(4);
    expect(mergeUnreadCount(4, 7)).toBe(7);
    expect(mergeUnreadCount(4, 0)).toBe(0);
  });

  it('keeps the last count that actually succeeded when a read fails', async () => {
    expect(mergeUnreadCount(4, null)).toBe(4);
  });

  it('never turns a failure into a zero', async () => {
    expect(mergeUnreadCount(null, null)).toBeNull();
    expect(mergeUnreadCount(null, null)).not.toBe(0);
  });
});

describe('the cadences the surfaces actually use', () => {
  it('are exactly the approved numbers', async () => {
    const { INBOX_POLL_INTERVAL_MS, THREAD_POLL_INTERVAL_MS } = await import(
      '../src/components/messaging-live'
    );

    expect(THREAD_POLL_INTERVAL_MS).toBe(5000);
    expect(INBOX_POLL_INTERVAL_MS).toBe(15_000);
  });

  it('give the inbox and the unread count one loop rather than two', async () => {
    // Asserted by reading the module: the badge and the list are rendered by one component, which polls
    // once per cycle and issues both reads inside it. A second loop for the counter would be a second
    // timer at the same cadence, which is exactly what the approved rule rules out.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/components/messaging-live.tsx', 'utf8'),
    );

    expect(source.match(/useMessagePolling\(/g)).toHaveLength(2);
    expect(source).toContain('INBOX_POLL_INTERVAL_MS, poll');
    expect(source).toContain('THREAD_POLL_INTERVAL_MS, poll');
  });
});
