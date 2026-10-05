'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import type { TrackEventType, TrackSource } from '@repo/contracts';

/**
 * The listing analytics beacon (0101).
 *
 * **It batches, and it never gets in the way.** Events are queued and flushed together — on a short timer,
 * and when the page is hidden or unloaded, which is the last moment a browser reliably runs anything. A flush
 * that fails is dropped: a beacon has nothing to show a visitor and nothing useful to retry, and retrying a
 * failed flush on a page that is closing would be work nobody is waiting for.
 *
 * **Nothing here identifies anybody.** The request carries listing identifiers, event types and a source. The
 * session is a cookie this browser cannot read, the account is resolved from the session token upstream, and
 * the request body has no field for either, so there is nothing a page script could add even by accident.
 *
 * **`favorite` and `share` have no control to fire them yet.** The contract and the database accept both, and
 * nothing in this app emits them: saving a listing has a BFF route with no button on any catalogue surface,
 * and there is no share affordance at all. Those are surfaces, not analytics, and inventing them here to have
 * something to count would be the wrong way round.
 */

const FLUSH_AFTER_MS = 2_000;
const MAX_QUEUE = 50;

interface QueuedEvent {
  readonly eventId: string;
  readonly listingId: string;
  readonly eventType: TrackEventType;
  readonly occurredAt: string;
  readonly source?: TrackSource;
}

const queue: QueuedEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (queue.length === 0) return;

  const events = queue.splice(0, MAX_QUEUE);
  const body = JSON.stringify({ events });

  // `sendBeacon` is the only thing a browser reliably runs while a page is going away. It is fire and
  // forget by design, which is exactly right for a beacon, and it falls back to a keepalive fetch where
  // it is unavailable or refuses the payload.
  const sent =
    typeof navigator !== 'undefined' &&
    typeof navigator.sendBeacon === 'function' &&
    navigator.sendBeacon('/api/track', new Blob([body], { type: 'application/json' }));

  if (sent === true) return;

  void fetch('/api/track', {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    headers: { 'content-type': 'application/json' },
    body,
  }).catch(() => undefined);
}

/** Queues one event. Flushing is the beacon's business, not the caller's. */
export function trackListingEvent(event: {
  readonly listingId: string;
  readonly eventType: TrackEventType;
  readonly source?: TrackSource;
}): void {
  if (typeof window === 'undefined') return;
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') return;

  queue.push({
    // The idempotency key, per event. It is what makes at-least-once delivery safe all the way down: the
    // database de-duplicates on it alone (0107), so a re-sent batch inserts nothing the second time even if
    // the server re-stamps the timestamp.
    eventId: crypto.randomUUID(),
    listingId: event.listingId,
    eventType: event.eventType,
    occurredAt: new Date().toISOString(),
    ...(event.source === undefined ? {} : { source: event.source }),
  });

  // A full queue flushes at once rather than growing past what one request may carry.
  if (queue.length >= MAX_QUEUE) {
    flush();
    return;
  }
  if (timer === null) timer = setTimeout(flush, FLUSH_AFTER_MS);
}

/**
 * Emits a `click` for whichever listing link inside it was clicked.
 *
 * One listener for a whole result list, rather than a client component per card: the cards stay server
 * components, the markup gains one data attribute, and a page with fifty results ships one handler.
 *
 * The capture phase, so the event is queued before a navigation starts — and `trackListingEvent` only
 * queues, so nothing is awaited and the link is never delayed.
 */
export function ListingClickBeacon({
  source,
  children,
}: {
  /**
   * Where the click happened, when one of 0013's six source values honestly describes this surface.
   *
   * **Omitted rather than guessed.** `/marketplace` and `/listings` are browse surfaces, and none of
   * `search`, `category`, `listing`, `seller`, `home` or `external` is what they are. The column is nullable,
   * so the click is recorded with no source: a null says "no agreed label", where picking the nearest value
   * would write a wrong fact into a column a later rollup groups by. A source taxonomy for browse surfaces
   * belongs with the analytics console, next to the impression definition.
   */
  readonly source?: TrackSource;
  readonly children: ReactNode;
}) {
  const container = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // The page is going away: send what is queued while there is still a chance.
    const onHide = (): void => flush();
    document.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, []);

  return (
    <div
      ref={container}
      onClickCapture={(event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const card = target.closest('[data-listing-id]');
        const listingId = card?.getAttribute('data-listing-id');
        if (typeof listingId === 'string' && listingId !== '') {
          trackListingEvent({
            listingId,
            eventType: 'click',
            ...(source === undefined ? {} : { source }),
          });
        }
      }}
    >
      {children}
    </div>
  );
}
