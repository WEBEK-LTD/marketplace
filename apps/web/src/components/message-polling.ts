import type { RenderableConversation, RenderableMessage } from './messaging-views';

/**
 * The messaging catch-up engine (Phase 5-F).
 *
 * No React, no `window`, no `document`: the scheduler takes its clock and its visibility source as
 * parameters, which is what makes the cadence, the visibility rules and the concurrency guarantees
 * testable with fake timers rather than inferred from a component. The hook in `use-message-polling.ts`
 * is the only place that binds this to a browser.
 *
 * What the scheduler guarantees, and what each guarantee is for:
 *
 * **An exact cadence while visible.** Each tick reschedules the next one before it starts any work, so
 * the interval measures tick-to-tick and never drifts by the duration of a request. No jitter, no
 * backoff, no adaptation — a fixed number, so a test can advance a fake clock by it and know exactly how
 * many cycles happened.
 *
 * **No requests while hidden.** A hidden document is not polled at all, and the timer is cleared rather
 * than left running, so nothing queues up to fire in a burst. Becoming visible again runs one immediate
 * catch-up and restarts the cadence from that moment.
 *
 * **Never two overlapping requests.** A tick that arrives while a cycle is still in flight is skipped
 * rather than queued. The cadence continues regardless, so the next tick is on time.
 *
 * **A stale answer can never overwrite a newer state.** Every cycle carries a generation and asks
 * `isCurrent()` before it touches anything. Stopping bumps the generation, so a response that arrives
 * after unmount is discarded by the consumer rather than written into a component that is gone.
 *
 * The engine itself performs no request and holds no data. What a cycle does is the caller's business;
 * all this decides is *when*, and whether the answer still matters.
 */

/** The timer this engine schedules on. `window` satisfies it; a fake-timer test supplies its own. */
export interface PollClock {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Whether the surface is being looked at, and a way to hear about changes. */
export interface VisibilitySource {
  isVisible(): boolean;
  /** Subscribes, and returns the unsubscribe. Called once per poller, undone once on stop. */
  onChange(listener: () => void): () => void;
}

/** One catch-up cycle. `isCurrent()` is false once a newer cycle has started or the poller has stopped. */
export interface PollCycle {
  readonly generation: number;
  isCurrent(): boolean;
}

export interface PollerOptions {
  /** Exactly this many milliseconds between ticks while visible. */
  readonly intervalMs: number;
  readonly clock: PollClock;
  readonly visibility: VisibilitySource;
  readonly run: (cycle: PollCycle) => Promise<void>;
}

export interface Poller {
  /** Subscribes, runs one immediate catch-up if visible, and begins the cadence. Idempotent. */
  start(): void;
  /** Clears the timer, unsubscribes, and makes every in-flight cycle stale. Idempotent. */
  stop(): void;
  /** How many cycles have been started. For assertions; nothing in the application reads it. */
  startedCycles(): number;
}

export function createPoller(options: PollerOptions): Poller {
  const { intervalMs, clock, visibility, run } = options;

  let handle: unknown = null;
  let unsubscribe: (() => void) | null = null;
  let generation = 0;
  let started = 0;
  let inFlight = false;
  let running = false;

  function clearTimer(): void {
    if (handle !== null) {
      clock.clearTimeout(handle);
      handle = null;
    }
  }

  function schedule(): void {
    clearTimer();
    handle = clock.setTimeout(onTick, intervalMs);
  }

  function fire(): void {
    // The one guard that prevents overlap. A skipped cycle is not queued: the next tick is already
    // scheduled, and a request that is still running is itself the catch-up in progress.
    if (!running || inFlight || !visibility.isVisible()) return;

    generation += 1;
    started += 1;
    const mine = generation;
    const cycle: PollCycle = {
      generation: mine,
      isCurrent: () => running && mine === generation,
    };

    inFlight = true;
    void (async () => {
      try {
        await run(cycle);
      } catch {
        // A failed cycle is not an event: the consumer keeps what it last rendered, and the cadence
        // continues. Swallowing here is what keeps one bad answer from stopping the loop.
      } finally {
        inFlight = false;
      }
    })();
  }

  function onTick(): void {
    handle = null;
    if (!running) return;
    if (!visibility.isVisible()) return; // Hidden: no request, and no timer until it is visible again.
    // Rescheduled before the work starts, so the cadence is tick-to-tick rather than end-to-start.
    schedule();
    fire();
  }

  function onVisibilityChange(): void {
    if (!running) return;
    if (!visibility.isVisible()) {
      clearTimer();
      return;
    }
    // Returning to visible: one immediate catch-up, and the cadence restarts from this moment.
    schedule();
    fire();
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      unsubscribe = visibility.onChange(onVisibilityChange);
      if (!visibility.isVisible()) return;
      schedule();
      fire();
    },
    stop(): void {
      if (!running) return;
      running = false;
      // Bumping the generation is what makes every in-flight cycle stale, so a late response cannot be
      // written into a component that has already gone.
      generation += 1;
      clearTimer();
      if (unsubscribe !== null) {
        unsubscribe();
        unsubscribe = null;
      }
    },
    startedCycles: () => started,
  };
}

/**
 * Compares two message sequences exactly.
 *
 * `seq` is a bigint the API sends as a digit string, so it must not go through `Number` — a long enough
 * sequence would lose precision and start comparing equal to its neighbour. For strings of plain digits
 * with no leading zero, longer is larger and equal lengths compare lexicographically, which is exact at
 * any size.
 */
export function compareSeq(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Merges a freshly fetched page of messages into what is already displayed.
 *
 * Deduplication is **strictly by `message.id`** — never by body, timestamp, sender or position, any of
 * which can legitimately repeat. Where an id appears in both, the freshly fetched copy wins, because the
 * server's answer is authoritative and the local one is at best a older rendering of the same row.
 *
 * Every message already displayed survives. That is the whole point: the poll asks for the *latest* page,
 * so replacing the array with it would silently throw away the older history the reader had loaded. The
 * result is ordered by `seq`, which is the order the server itself pages in, so new messages land after
 * the ones they follow and nothing already loaded is reordered.
 */
export function mergeMessages(
  existing: readonly RenderableMessage[],
  incoming: readonly RenderableMessage[],
): RenderableMessage[] {
  const byId = new Map<string, RenderableMessage>();
  for (const message of existing) byId.set(message.id, message);
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => compareSeq(a.seq, b.seq));
}

/**
 * Merges a freshly fetched inbox page over the rows currently displayed.
 *
 * The fresh page decides which rows exist and in what order — it is the same page, asked for again with
 * the same opaque cursor, so it is authoritative including about a row that has *left* it. Matching is by
 * `conversationId`, and a row whose fields are all unchanged keeps its existing object, so React sees no
 * change where the server reported none.
 *
 * Nothing is carried over from a row the server no longer lists, and nothing is invented for a field the
 * server did not send.
 */
export function mergeConversations(
  existing: readonly RenderableConversation[],
  incoming: readonly RenderableConversation[],
): RenderableConversation[] {
  const previous = new Map(existing.map((row) => [row.conversationId, row]));
  return incoming.map((row) => {
    const before = previous.get(row.conversationId);
    return before !== undefined && sameConversation(before, row) ? before : row;
  });
}

function sameConversation(a: RenderableConversation, b: RenderableConversation): boolean {
  return (
    a.subjectType === b.subjectType &&
    a.listingTitleSnapshot === b.listingTitleSnapshot &&
    a.membershipState === b.membershipState &&
    a.isMuted === b.isMuted &&
    a.isClosed === b.isClosed &&
    a.unreadCount === b.unreadCount &&
    a.lastMessageAt === b.lastMessageAt &&
    a.lastMessageBody === b.lastMessageBody
  );
}

/**
 * What the unread badge should show after a cycle.
 *
 * A successful count replaces the old one. A failed count keeps the last one that *was* successful — it
 * was a real number the server gave, and dropping it would make the badge flicker on every hiccup. What
 * never happens is a zero appearing because a request failed: a count that has never succeeded stays
 * unknown, and an unknown count renders no badge at all.
 */
export function mergeUnreadCount(previous: number | null, fresh: number | null): number | null {
  return fresh === null ? previous : fresh;
}
