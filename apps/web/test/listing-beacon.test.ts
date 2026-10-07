import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The browser's listing analytics beacon (0101).
 *
 * The valuable part of this component is its queue, and it is testable because it is a plain module: events
 * are queued, flushed together, and sent through whichever transport a closing page still runs. The
 * properties under test are the ones a visitor would notice if they were wrong —
 *
 *   * **one request per flush, not one per click**, so a result list does not fire fifty requests;
 *   * **a bounded queue**, so a long session cannot grow a batch past what one request may carry;
 *   * **`sendBeacon` first**, because it is the only transport a browser reliably runs while a page is going
 *     away, with a `keepalive` fetch where it is unavailable or refuses;
 *   * **a failure is swallowed**, because a beacon has nothing to show a visitor and nothing to retry;
 *
 * — and the one a page author could get wrong: **nothing identifying is in the payload**. There is no field
 * for an account, a session or a digest, so there is nothing a page script could add even by accident.
 *
 * The module reads `window`, `navigator`, `crypto` and `fetch` from the global scope, so each test gets a
 * fresh module instance with those stood up: the queue is module state and must not leak between tests.
 */

const ROOT = new URL('../', import.meta.url).pathname;
const LISTING = '11111111-1111-4111-8111-111111111111';

interface Sent {
  readonly url: string;
  readonly body: string;
  readonly init?: RequestInit | undefined;
}

interface Harness {
  readonly beacons: Sent[];
  readonly fetches: Sent[];
  readonly trackListingEvent: (event: {
    listingId: string;
    eventType: 'click' | 'contact' | 'favorite' | 'share';
    source?: 'search' | 'category' | 'listing' | 'seller' | 'home' | 'external';
  }) => void;
}

/** The module, freshly loaded, with a stubbed browser around it. */
async function load(
  options: { readonly sendBeacon?: 'ok' | 'refuses' | 'absent'; readonly fetchRejects?: boolean } = {},
): Promise<Harness> {
  const beacons: Sent[] = [];
  const fetches: Sent[] = [];
  const mode = options.sendBeacon ?? 'ok';

  const navigatorStub: Record<string, unknown> = {};
  if (mode !== 'absent') {
    navigatorStub['sendBeacon'] = (url: string, blob: Blob) => {
      // Recorded before the verdict, so a refused send is still observable.
      beacons.push({ url, body: (blob as unknown as { __text: string }).__text });
      return mode === 'ok';
    };
  }

  vi.stubGlobal('window', {} as unknown as Window);
  vi.stubGlobal('navigator', navigatorStub);
  // A Blob whose text is readable synchronously, which the real one is not.
  vi.stubGlobal(
    'Blob',
    class {
      readonly __text: string;
      readonly type: string;
      constructor(parts: string[], init?: { type?: string }) {
        this.__text = parts.join('');
        this.type = init?.type ?? '';
      }
    },
  );
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    fetches.push({ url, body: typeof init?.body === 'string' ? init.body : '', init });
    if (options.fetchRejects === true) throw new Error('the page is closing');
    return new Response('{"accepted":1}', { status: 202 });
  });

  vi.resetModules();
  const loaded = await import('../src/components/listing-beacon');
  return { beacons, fetches, trackListingEvent: loaded.trackListingEvent };
}

/** The one request a flush produced, from whichever transport took it. */
function onlyRequest(harness: Harness): Sent {
  const all = [...harness.beacons, ...harness.fetches];
  expect(all).toHaveLength(1);
  return all[0]!;
}

function events(sent: Sent): Array<Record<string, unknown>> {
  const payload = JSON.parse(sent.body) as Record<string, unknown>;
  expect(Object.keys(payload)).toEqual(['events']);
  return payload['events'] as Array<Record<string, unknown>>;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the queue', () => {
  it('sends nothing until the flush timer fires', async () => {
    const harness = await load();
    harness.trackListingEvent({ listingId: LISTING, eventType: 'click' });

    expect(harness.beacons).toEqual([]);
    expect(harness.fetches).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(harness.beacons).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(harness.beacons).toHaveLength(1);
  });

  /** The whole point of batching: a result list does not fire one request per click. */
  it('sends one request for several events', async () => {
    const harness = await load();
    harness.trackListingEvent({ listingId: LISTING, eventType: 'click' });
    harness.trackListingEvent({ listingId: LISTING, eventType: 'contact' });
    harness.trackListingEvent({ listingId: LISTING, eventType: 'share' });
    await vi.advanceTimersByTimeAsync(2_000);

    const sent = onlyRequest(harness);
    expect(events(sent).map((event) => event['eventType'])).toEqual(['click', 'contact', 'share']);
  });

  it('does not restart the timer on each event, so the first click is not delayed for ever', async () => {
    const harness = await load();
    harness.trackListingEvent({ listingId: LISTING, eventType: 'click' });
    await vi.advanceTimersByTimeAsync(1_500);
    harness.trackListingEvent({ listingId: LISTING, eventType: 'contact' });
    await vi.advanceTimersByTimeAsync(500);

    expect(onlyRequest(harness)).toBeDefined();
    expect(events(onlyRequest(harness))).toHaveLength(2);
  });

  /** Bounded: a long session cannot grow a batch past what one request may carry. */
  it('flushes at once when the batch reaches the ceiling, without waiting', async () => {
    const harness = await load();
    for (let index = 0; index < 50; index += 1) {
      harness.trackListingEvent({ listingId: LISTING, eventType: 'click' });
    }

    expect(harness.beacons).toHaveLength(1);
    expect(events(harness.beacons[0]!)).toHaveLength(50);
  });

  it('starts a fresh batch for what comes after the ceiling', async () => {
    const harness = await load();
    for (let index = 0; index < 51; index += 1) {
      harness.trackListingEvent({ listingId: LISTING, eventType: 'click' });
    }
    await vi.advanceTimersByTimeAsync(2_000);

    expect(harness.beacons).toHaveLength(2);
    expect(events(harness.beacons[0]!)).toHaveLength(50);
    expect(events(harness.beacons[1]!)).toHaveLength(1);
  });

  it('sends nothing at all when nothing was queued', async () => {
    const harness = await load();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.beacons).toEqual([]);
    expect(harness.fetches).toEqual([]);
  });

  it('queues nothing outside a browser, where there is nothing to flush into', async () => {
    const harness = await load();
    vi.stubGlobal('window', undefined);
    harness.trackListingEvent({ listingId: LISTING, eventType: 'click' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.beacons).toEqual([]);
  });
});

describe('what an event carries', () => {
  it('carries the listing, the type, a fresh identifier and a timestamp', async () => {
    const harness = await load();
    harness.trackListingEvent({ listingId: LISTING, eventType: 'click', source: 'search' });
    await vi.advanceTimersByTimeAsync(2_000);

    const [event] = events(onlyRequest(harness));
    expect(Object.keys(event!).sort()).toEqual([
      'eventId',
      'eventType',
      'listingId',
      'occurredAt',
      'source',
    ]);
    expect(event!['listingId']).toBe(LISTING);
    expect(event!['eventType']).toBe('click');
    expect(event!['source']).toBe('search');
    expect(event!['eventId']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(Date.parse(event!['occurredAt'] as string)).toBeGreaterThan(0);
  });

  /** The idempotency key, per event. A re-sent batch must insert nothing the second time. */
  it('gives every event its own identifier, even for the same listing and type', async () => {
    const harness = await load();
    for (let index = 0; index < 5; index += 1) {
      harness.trackListingEvent({ listingId: LISTING, eventType: 'click' });
    }
    await vi.advanceTimersByTimeAsync(2_000);

    const ids = events(onlyRequest(harness)).map((event) => event['eventId']);
    expect(new Set(ids).size).toBe(5);
  });

  it('omits the source rather than guessing one when the surface has none', async () => {
    const harness = await load();
    harness.trackListingEvent({ listingId: LISTING, eventType: 'click' });
    await vi.advanceTimersByTimeAsync(2_000);

    const [event] = events(onlyRequest(harness));
    expect('source' in event!).toBe(false);
  });

  /** Nothing here identifies anybody, and there is no field through which it could. */
  it('carries no account, session or digest', async () => {
    const harness = await load();
    harness.trackListingEvent({ listingId: LISTING, eventType: 'click' });
    await vi.advanceTimersByTimeAsync(2_000);

    const sent = onlyRequest(harness);
    for (const forbidden of ['userId', 'user_id', 'sessionId', 'sessionHash', 'session_hash', 'ip', 'seller']) {
      expect(sent.body, forbidden).not.toContain(forbidden);
    }
  });

  it('queues nothing when the browser cannot generate an identifier', async () => {
    const harness = await load();
    vi.stubGlobal('crypto', {});
    harness.trackListingEvent({ listingId: LISTING, eventType: 'click' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.beacons).toEqual([]);
  });
});

describe('the transport', () => {
  /** The only thing a browser reliably runs while a page is going away. */
  it('is sendBeacon when it is available, with no fetch at all', async () => {
    const harness = await load();
    harness.trackListingEvent({ listingId: LISTING, eventType: 'click' });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(harness.beacons).toHaveLength(1);
    expect(harness.beacons[0]!.url).toBe('/api/track');
    expect(harness.fetches).toEqual([]);
  });

  it('falls back to a keepalive fetch when sendBeacon refuses the payload', async () => {
    const harness = await load({ sendBeacon: 'refuses' });
    harness.trackListingEvent({ listingId: LISTING, eventType: 'click' });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(harness.fetches).toHaveLength(1);
    expect(harness.fetches[0]!.url).toBe('/api/track');
    expect(harness.fetches[0]!.init?.method).toBe('POST');
    expect(harness.fetches[0]!.init?.keepalive).toBe(true);
    expect(harness.fetches[0]!.init?.credentials).toBe('same-origin');
  });

  it('falls back to fetch where sendBeacon does not exist', async () => {
    const harness = await load({ sendBeacon: 'absent' });
    harness.trackListingEvent({ listingId: LISTING, eventType: 'click' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.fetches).toHaveLength(1);
  });

  /** A beacon has nothing to show a visitor and nothing worth retrying on a closing page. */
  it('swallows a failed send rather than raising on a page that is going away', async () => {
    const harness = await load({ sendBeacon: 'absent', fetchRejects: true });
    harness.trackListingEvent({ listingId: LISTING, eventType: 'click' });
    // A throw inside the flush would fail this test: the send is fire-and-forget and must stay that way.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.fetches).toHaveLength(1);
  });

  it('drops a failed batch rather than resending it for ever', async () => {
    const harness = await load({ sendBeacon: 'absent', fetchRejects: true });
    harness.trackListingEvent({ listingId: LISTING, eventType: 'click' });
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.fetches).toHaveLength(1);
  });

  it('posts to this origin only, with no absolute URL anywhere', async () => {
    const source = readFileSync(join(ROOT, 'src/components/listing-beacon.tsx'), 'utf8');
    expect(source).toContain("'/api/track'");
    expect(source).not.toMatch(/https?:\/\//);
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe('which surfaces emit', () => {
  function read(relative: string): string {
    return readFileSync(join(ROOT, relative), 'utf8');
  }

  /** A card the handler can attribute: the identifier has to be in the markup for `closest` to find it. */
  it('marks every listing card with its identifier', () => {
    expect(read('src/components/listing-views.tsx')).toContain('data-listing-id={listing.id}');
  });

  it('wraps the search results, which have an honest source', () => {
    const source = read('src/components/search-results.tsx');
    expect(source).toContain('<ListingClickBeacon source="search">');
  });

  it('wraps the two browse grids, without claiming a source for them', () => {
    for (const file of ['src/app/[locale]/marketplace/page.tsx', 'src/app/[locale]/listings/page.tsx']) {
      const source = read(file);
      expect(source, file).toContain('<ListingClickBeacon>');
      expect(source, file).not.toContain('<ListingClickBeacon source');
    }
  });

  /**
   * The homepage is **not** an emission surface, and that is a finding rather than an omission: 0093's
   * `HomepageListingCard` carries a slug and no identifier, so a click there cannot be attributed without
   * either widening a closed read contract or resolving a slug to an identifier on the server — which would
   * also hand anyone a slug oracle. It stays out until an increment owns that decision.
   */
  it('leaves the homepage out, because its cards carry no identifier', () => {
    const homepage = read('src/components/homepage-sections.tsx');
    expect(homepage).not.toContain('ListingClickBeacon');
    expect(homepage).not.toContain('data-listing-id');

    const contract = readFileSync(join(ROOT, '../../packages/contracts/src/homepage.ts'), 'utf8');
    const card = contract.slice(contract.indexOf('HomepageListingCardSchema'));
    expect(card.slice(0, card.indexOf('.strict()'))).not.toContain('id:');
  });

  /** The contact surface emits directly, because it already knows which listing it is contacting about. */
  it('emits a contact from the start-conversation control, on the listing surface', () => {
    const source = read('src/components/start-conversation.tsx');
    expect(source).toContain('trackListingEvent(');
    expect(source).toContain("eventType: 'contact'");
    expect(source).toContain("source: 'listing'");
  });

  /** A service is not a listing: `listing_events.listing_id` references listings, and only those. */
  it('never marks a service card', () => {
    expect(read('src/components/service-views.tsx')).not.toContain('data-listing-id');
  });
});
